'use strict';
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { resolveCli } = require('./cli');

class CodexClient {
  constructor(executable, spawnProcess = spawn) {
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.id = 0;
    this.child = null;
    this.ready = null;
    this.onUpdate = () => {};
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.connect();
    try { await this.ready; } catch (e) { this.dispose(); throw e; }
  }
  async connect() {
    const cli = this.executable && typeof this.executable === 'object'
      ? this.executable : resolveCli('codex', this.executable);
    const child = this.spawnProcess(cli.command, [...cli.args, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // Do not let project-local configuration influence a quota-only client.
      cwd: require('os').homedir()
    });
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 4 * 1024 * 1024) return this.fail(new Error('Codex response exceeds the size limit.'));
      let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.method && msg.id !== undefined) {
          // This client only reads account/catalog data. It never approves tools.
          this.send({ id: msg.id, error: { code: -32601, message: 'Read-only monitor client' } });
        } else if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(String(msg.error.message || 'Codex request failed')));
          else p.resolve(msg.result);
        } else if (msg.method === 'account/rateLimits/updated') this.onUpdate(msg.params);
      }
    });
    child.stderr.on('data', () => {}); // Drain without storing credentials or logs.
    child.stdin.on('error', () => this.fail(new Error('Codex connection closed.')));
    child.on('error', () => this.fail(new Error('Cannot start Codex CLI. Check its executable path.')));
    child.on('exit', () => { if (this.child === child) this.fail(new Error('Codex CLI stopped.')); });
    await this.request('initialize', { clientInfo: {
      name: 'claude_monitor_vault', title: 'Claude Monitor & Vault + ChatGPT',
      version: require('../package.json').version
    } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is not connected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Codex request timed out: ' + method));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async usage() {
    await this.start();
    const account = await this.request('account/read', { refreshToken: false });
    if (!account.account) throw new Error('Sign in first with codex login.');
    if (account.account.type !== 'chatgpt' && account.account.type !== 'chatgptAuthTokens'
        && account.account.type !== 'personalAccessToken') {
      throw new Error('Subscription quotas require a ChatGPT-backed Codex account.');
    }
    return this.request('account/rateLimits/read');
  }
  async models() {
    await this.start();
    const rows = []; let cursor = null;
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      rows.push(...(result.data || [])); cursor = result.nextCursor;
      if (rows.length > 1000) throw new Error('Codex model catalog is too large.');
    } while (cursor);
    return rows;
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    const child = this.child; this.child = null; this.ready = null;
    if (child) child.kill();
  }
  dispose() { this.fail(new Error('Codex client closed.')); }
}

function quotaRows(data) {
  const buckets = data && data.rateLimitsByLimitId
    ? Object.values(data.rateLimitsByLimitId) : [data && data.rateLimits];
  const rows = [];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const slot of ['primary', 'secondary']) {
      const w = bucket[slot];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      rows.push({ id: (bucket.limitId || 'codex') + ':' + slot,
        label: bucket.limitName || bucket.limitId || 'Codex',
        minutes: w.windowDurationMins, pct: Math.max(0, Math.min(100, w.usedPercent)),
        resetAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null });
    }
  }
  return rows;
}
module.exports = { CodexClient, quotaRows };
