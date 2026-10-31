// Claude Limits, real time Claude usage limits in VSCode.
// Data: the official /api/oauth/usage endpoint (the one behind the /usage
// command of Claude Code), local OAuth token, cache shared between windows.
//
// Performance principles:
//  - no needless periodic wakeups: a single setTimeout rescheduled to the
//    next real deadline (instead of a fixed 15 s heartbeat);
//  - no redundant disk I/O: cache/credentials reads filtered by mtime,
//    cache trimmed to the displayed values only, atomic writes;
//  - no redundant rendering: status bar, tree view and webview are only
//    refreshed if the display signature actually changed;
//  - the webview updates the DOM in place (no innerHTML rebuild) as long
//    as the row structure does not change.

const vscode = require('vscode');
const i18n = require('./i18n.js');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { execFile } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Read from the manifest rather than hard-coded: it used to announce
// "claude-limits-vscode/0.9" long after the extension had been renamed and had
// reached 0.58, and that string goes out to Anthropic on every single call.
const UA = 'claude-monitor-vault/' + require('./package.json').version;
// Claude Code honours CLAUDE_CONFIG_DIR. Hard-coding ~/.claude would read a
// token, and write a shared cache, in a directory Claude Code never looks at.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CREDS_PATH = path.join(CLAUDE_DIR, '.credentials.json');
// cache shared between all VSCode windows: a single real request feeds everyone
const CACHE_PATH = path.join(CLAUDE_DIR, 'claude-limits-cache.json');
const CACHE_TMP = CACHE_PATH + '.' + process.pid + '.tmp';

const BACKOFF_MS = 300000;        // 5 min pause after a 429
const BACKOFF_MAX_MS = 900000;    // ceiling for the 429 pause
const ERROR_BACKOFF_MS = 60000;   // short pause after a network error
const FETCH_COOLDOWN_MS = 30000;  // minimum delay between two real network calls (anti spam)
const MIN_SLEEP_MS = 1000;
const MAX_SLEEP_MS = 300000;      // safety net: machine sleep, clock drift
const MAX_BODY = 262144;          // guard on response size
const ALERT_TTL_MS = 86400000;    // forget notified thresholds after 24 h
const WATCH_DEBOUNCE_MS = 250;
const REQ_TIMEOUT_MS = 15000;

// A single view: quotas and secrets in the same panel. The compact and mini
// modes were removed, three ways of displaying the same thing meant three
// times more code for a companion that only has one useful state.
const VERSION = require('./package.json').version;

// ---------------------------------------------------------------- config

// Configuration is re read only when VSCode signals a change: getConfiguration()
// used to be called several times per heartbeat.
let cfgCache = null;
function cfg() {
  if (cfgCache) return cfgCache;
  const c = vscode.workspace.getConfiguration('claudeLimits');
  cfgCache = {
    pollMs: Math.max(120, c.get('pollSeconds', 210)) * 1000,
    alerts: c.get('alerts', true),
    statusBar: c.get('statusBar', true),
    pauseWhenExhausted: c.get('pauseWhenExhausted', true),
    showCredits: c.get('showCredits', true),
    // Next to the chat by default, like Claude Code itself. The container in
    // the secondary side bar is a real one since VS Code 1.106, hence the
    // engine floor: the key is `secondarySidebar`, and the lowercase b matters
    // — `secondarySideBar` was the proposed-API name, absent from the schema,
    // silently ignored, and every view declared under it landed in the Explorer.
    location: c.get('location', 'secondarySidebar'),   // secondarySidebar | sidebar
    badge: c.get('badge', true),      // activity-bar badge, on by default
    statusPos: c.get('statusBarPosition', 'right'),      // left | right
    statusStyle: normStyle(c.get('statusBarStyle', 'prominent')),   // prominent | subtle
    statusBands: readBands(c.get('statusBarBands', null)),
    statusWeek: c.get('statusBarWeek', false)            // also show the week
  };
  return cfgCache;
}

// "classic" was removed: it sat between the two remaining styles and nobody
// could say out loud what it did that the others did not. Anyone who had picked
// it wanted less colour rather than more, so it lands on the quiet style and
// not on the permanent pill. Anything unknown falls back to the default.
function normStyle(v) {
  return (v === 'subtle' || v === 'classic') ? 'subtle' : 'prominent';
}

// The colours a band may carry, and the default set, both read from the
// manifest rather than written twice. A theme colour id that does not exist
// renders as the plain foreground with no error anywhere, so a list that drifts
// from the one VS Code validates against would look like a broken feature
// rather than a typo. The settings page reads the same two values.
const BANDS_SCHEMA = require('./package.json')
  .contributes.configuration.properties['claudeLimits.statusBarBands'];
const BAND_COLORS = BANDS_SCHEMA.items.properties.color.enum;
const BANDS_DEFAULT = BANDS_SCHEMA.default;

// Bands are read as "up to X%", each one starting where the previous ended.
// Holes and overlaps are impossible by construction rather than rejected after
// the fact, which is also why the editor in the settings page can only ever
// produce something valid. What still has to be defended against is a settings
// file edited by hand: out of order, out of range, unknown colour, or a last
// band that stops short of 100 and leaves the top of the scale unpainted.
function readBands(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return defaultBands();
  const out = [];
  let prev = 0;
  for (const b of raw) {
    if (!b || typeof b.upTo !== 'number' || !isFinite(b.upTo)) continue;
    if (BAND_COLORS.indexOf(b.color) === -1) continue;
    const upTo = Math.min(100, Math.max(1, Math.round(b.upTo)));
    if (upTo <= prev) continue;              // out of order or duplicate
    out.push({ upTo, color: b.color });
    prev = upTo;
    if (out.length === 6) break;
  }
  if (out.length < 2) return defaultBands();
  out[out.length - 1].upTo = 100;            // the scale always ends at 100
  return out;
}

// A copy each time: the manifest object is shared through the require cache,
// and handing it out would let one caller's edit reach every other reader.
function defaultBands() {
  return BANDS_DEFAULT.map(b => ({ upTo: b.upTo, color: b.color }));
}

// The colour for a percentage. The first band whose ceiling is not yet passed
// wins, so 50 belongs to "up to 50" and not to the one after it.
function bandColor(pct, bands) {
  const p = Math.max(0, Math.min(100, pct));
  for (const b of bands) if (p <= b.upTo) return b.color;
  return bands[bands.length - 1].color;
}

// ---------------------------------------------------------------- API Anthropic

// The token is read from disk again only if the file changed (OAuth rotation).
let credKey = '';
let credToken = '';
let credAt = 0;
const KEYCHAIN_TTL_MS = 300000;   // a keychain item has no mtime to watch

function tokenFromJson(txt) {
  const raw = JSON.parse(txt);
  const tok = raw && raw.claudeAiOauth && raw.claudeAiOauth.accessToken;
  if (!tok) throw new Error('token absent');
  return tok;
}

// On macOS, Claude Code keeps its OAuth credentials in the login keychain
// rather than in ~/.claude/.credentials.json, so without this the extension
// never shows a single figure on a Mac. Read asynchronously on purpose: the
// first access by a binary that did not create the item raises an
// authorisation dialog, and a spawnSync would freeze the extension host for as
// long as it stayed on screen. No -a: the item's account does not have to match
// the local user name.
function tokenFromKeychain() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(i18n.t('macOS keychain refused the Claude Code credentials: {0}',
            String(stderr || err.message).trim())));
        }
        try { resolve(tokenFromJson(String(stdout || '').trim())); }
        catch (e) { reject(e); }
      });
  });
}

// The file stays the primary source on every platform: a headless Mac, an SSH
// session or a CI runner makes Claude Code itself fall back to it.
async function getToken() {
  let st = null;
  try { st = fs.statSync(CREDS_PATH); } catch (e) { st = null; }
  if (st) {
    const key = st.mtimeMs + ':' + st.size;
    if (key === credKey && credToken) return credToken;
    const tok = tokenFromJson(fs.readFileSync(CREDS_PATH, 'utf8'));
    credKey = key; credToken = tok; credAt = Date.now();
    return tok;
  }
  if (process.platform !== 'darwin') throw new Error('no credentials file');
  if (credKey === 'keychain' && credToken && Date.now() - credAt < KEYCHAIN_TTL_MS) return credToken;
  const tok = await tokenFromKeychain();
  credKey = 'keychain'; credToken = tok; credAt = Date.now();
  return tok;
}

async function fetchUsage() {
  let token;
  try {
    token = await getToken();
  } catch (e) {
    // A keychain that refuses access is not the same problem as a missing
    // login, and telling the user to sign in again would send them nowhere.
    throw /keychain/i.test(String(e && e.message))
      ? e
      : new Error(i18n.t('credentials not found: sign in to Claude Code'));
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = v => { if (!done) { done = true; resolve(v); } };
    const ko = e => { if (!done) { done = true; reject(e); } };

    const req = https.get(USAGE_URL, {
      headers: {
        'authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': UA,
        'accept': 'application/json'
      },
      timeout: REQ_TIMEOUT_MS
    }, res => {
      const code = res.statusCode;
      if (code !== 200) {
        res.resume();                       // frees the socket without buffering the error page
        if (code === 401) { credKey = ''; return ko(new Error(i18n.t('token expired: open Claude Code'))); }
        if (code === 429) {
          const err = new Error('429');
          err.status = 429;
          const ra = parseInt(res.headers['retry-after'], 10);
          if (ra > 0) err.retryAfter = ra;
          return ko(err);
        }
        return ko(new Error('HTTP ' + code));
      }
      // Buffer concatenation: accumulating a string would cut multi byte UTF-8 characters
      const chunks = [];
      let len = 0;
      res.on('data', c => {
        len += c.length;
        if (len > MAX_BODY) { req.destroy(); return ko(new Error(i18n.t('response too large'))); }
        chunks.push(c);
      });
      res.on('error', () => ko(new Error(i18n.t('connection interrupted'))));
      res.on('end', () => {
        if (done) return;
        try { ok(JSON.parse(Buffer.concat(chunks, len).toString('utf8'))); }
        catch (e) { ko(new Error(i18n.t('unreadable response'))); }
      });
    });
    req.on('timeout', () => { ko(new Error(i18n.t('request timed out'))); req.destroy(); });
    req.on('error', () => ko(new Error(i18n.t('offline'))));
  });
}

// ---------------------------------------------------------------- interpretation

// Labels mirror the /usage command of Claude Code.
//
// `short` is an internal identifier and never reaches the screen: rows are
// looked up by it, and the cache written by one window must stay readable by a
// window running in another language. `abbr` is its translated twin, the one
// the status bar shows. Both labels are English sources here and translated at
// the moment a row is built, because the language can now change while the
// extension is running.
const LIMIT_DEFS = [
  { key: 'five_hour', label: 'Session (5h)', short: '5h', abbr: '5h', sevKind: 'session' },
  { key: 'seven_day', label: 'Week', short: 'sem', abbr: 'wk', sevKind: 'weekly_all' },
  { key: 'seven_day_opus', label: 'Week · Opus', short: 'opus', abbr: 'Opus', sevKind: null },
  { key: 'seven_day_sonnet', label: 'Week · Sonnet', short: 'sonnet', abbr: 'Sonnet', sevKind: null }
];
const DEF_BY_KEY = new Map(LIMIT_DEFS.map(d => [d.key, d]));

// Alert level: the severity returned by the Anthropic API takes precedence,
// our own thresholds (70% / 90%) act as a safety net.
function levelOf(pct, severity) {
  if (severity && /exceed|critical|error|rejected|blocked/i.test(severity)) return 'crit';
  if (pct >= 90) return 'crit';
  if (severity && severity !== 'normal') return 'warn';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function buildRows(data) {
  const severities = {};
  if (Array.isArray(data.limits)) {
    for (const l of data.limits) {
      if (l && l.kind && !severities[l.kind]) severities[l.kind] = l.severity;
    }
  }
  const rows = [];
  for (const def of LIMIT_DEFS) {
    const o = data[def.key];
    if (!o || o.utilization === null || o.utilization === undefined) continue;
    const pct = Number(o.utilization);
    if (!isFinite(pct)) continue;
    rows.push({
      key: def.key,
      label: i18n.t(def.label),
      short: def.short,
      abbr: i18n.t(def.abbr),
      pct,
      resets: o.resets_at,
      resetAt: o.resets_at ? Date.parse(o.resets_at) : NaN,   // parsed once
      level: levelOf(pct, def.sevKind ? severities[def.sevKind] : undefined)
    });
  }
  return rows;
}

// "Extra usage" credits: what Claude bills beyond the plan, when the option
// is enabled on the account. The API returns it in two shapes (spend and
// extra_usage); we read the more precise one and show nothing if it is
// disabled, so we don't clutter the panel with a row that would never be used.
function buildCredits(data) {
  const sp = data && data.spend;
  const ex = data && data.extra_usage;
  const actif = !!(sp && sp.enabled) || !!(ex && ex.is_enabled);
  if (!actif) return null;

  const u = sp && sp.used;
  const exposant = u && typeof u.exponent === 'number' ? u.exponent : 2;
  const div = Math.pow(10, exposant);
  const utilise = u && typeof u.amount_minor === 'number' ? u.amount_minor / div : null;
  const plafond = sp && sp.limit && typeof sp.limit.amount_minor === 'number'
    ? sp.limit.amount_minor / div : null;
  const pct = sp && typeof sp.percent === 'number' ? sp.percent
    : (ex && typeof ex.utilization === 'number' ? ex.utilization : null);

  return {
    used: utilise,
    limit: plafond,
    currency: (u && u.currency) || (ex && ex.currency) || 'USD',
    pct: pct,
    level: levelOf(pct == null ? 0 : pct, sp && sp.severity),
    atteint: !!(ex && ex.spend_limit_reached)
  };
}

// The cache keeps only the 4 displayed values (~250 B instead of ~1.8 KB of
// raw response): reading, parsing and writing are all faster in every
// window. `k/p/r/v` = key / percent / reset / level.
function packRows(rows) {
  return rows.map(r => ({ k: r.key, p: r.pct, r: r.resets, v: r.level }));
}

function unpackRows(arr) {
  const rows = [];
  if (!Array.isArray(arr)) return rows;
  for (const o of arr) {
    const def = DEF_BY_KEY.get(o && o.k);
    if (!def) continue;
    const pct = Number(o.p);
    if (!isFinite(pct)) continue;
    rows.push({
      key: def.key,
      label: i18n.t(def.label),
      short: def.short,
      abbr: i18n.t(def.abbr),
      pct,
      resets: o.r,
      resetAt: o.r ? Date.parse(o.r) : NaN,
      level: o.v || levelOf(pct)
    });
  }
  return rows;
}

// Also accepts caches written by versions <= 0.8 (raw API response).
function rowsOfCache(c) {
  if (c.rows) return unpackRows(c.rows);
  if (c.data) return buildRows(c.data);
  return [];
}

function creditsOfCache(c) {
  if (c.cr !== undefined) return c.cr;
  if (c.data) return buildCredits(c.data);
  return null;
}

// When a limit is exhausted, calling the API again every 3 minutes serves no
// purpose: the response will not change before the reset. So we align on the
// reset time announced by Anthropic, which removes dozens of pointless calls
// during a period where we are blocked anyway.
function pauseUntilOf(rows) {
  let until = 0;
  for (const r of rows) {
    if (r.pct < 100 && r.level !== 'crit') continue;
    if (r.pct < 100) continue;                       // "crit" already fires at 90%: not exhausted yet
    if (isFinite(r.resetAt) && r.resetAt > until) until = r.resetAt;
  }
  return until ? until + 5000 : 0;                 // small margin on the server clock
}

// Backward compatibility: versions <= 0.8 only know how to read `data`.
// Without this bare minimum, a window that hasn't reloaded yet would think
// the cache is missing and call the API again every 30 s until it hits a 429.
function legacyData(rows) {
  const d = {};
  for (const r of rows) d[r.key] = { utilization: r.pct, resets_at: r.resets };
  return d;
}

function etaText(at) {
  if (!at || !isFinite(at)) return '';
  const s = Math.floor((at - Date.now()) / 1000);
  if (s <= 0) return i18n.t('resets soon');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) {
    return i18n.t('resets in {0}d {1}h', String(Math.floor(h / 24)), String(h % 24).padStart(2, '0'));
  }
  return i18n.t('resets in {0}h {1}', String(h), String(m).padStart(2, '0'));
}

// ChatGPT / Codex announces each limit by its window length in minutes, not by
// name. Read in the vocabulary the Claude rows already use, so the two blocks
// say "Session (5h)" and "Week" alike; any other window falls back to its plain
// length, which is still more telling than the plan's internal name.
function windowLabel(minutes) {
  const m = Number(minutes);
  if (!isFinite(m) || m <= 0) return '';
  if (m === 300) return i18n.t('Session (5h)');
  if (m === 10080) return i18n.t('Week');
  if (m < 60) return i18n.t('{0} min', String(Math.round(m)));
  if (m % 1440 === 0) return i18n.t('{0} d', String(m / 1440));
  return i18n.t('{0} h', String(Math.round(m / 6) / 10));
}

// Which Claude limit a window behaves like: up to a day it is a session (its
// projection follows the session option), beyond that a week.
function windowKind(minutes) { return Number(minutes) > 1440 ? 'sem' : '5h'; }

function worstLevel(rows) {
  for (const r of rows) if (r.level === 'crit') return 'crit';
  for (const r of rows) if (r.level === 'warn') return 'warn';
  return 'ok';
}

// VSCode theme colors (adapt to light/dark themes).
const CHART_COLOR = {
  ok: new vscode.ThemeColor('charts.green'),
  warn: new vscode.ThemeColor('charts.yellow'),
  crit: new vscode.ThemeColor('charts.red')
};
const BG_WARN = new vscode.ThemeColor('statusBarItem.warningBackground');
const BG_CRIT = new vscode.ThemeColor('statusBarItem.errorBackground');

// One ThemeColor object per id, built once. renderStatus runs on every
// heartbeat and on every window focus change, and a new object each time would
// make VS Code redraw the item even when the colour has not moved.
const BAND_THEME = new Map();
function bandTheme(id) {
  let c = BAND_THEME.get(id);
  if (!c) { c = new vscode.ThemeColor(id); BAND_THEME.set(id, c); }
  return c;
}

// -------------------------------------------------------- recolouring the pill
//
// The status bar refuses any background other than its two reserved slots, and
// drops the rest without a word. So the only route to another colour is to
// redefine the slot itself, in the user's own settings. That is a heavier act
// than it looks: the slot belongs to the workbench, not to this extension, so
// every warning or error item in the status bar takes the new colour, other
// extensions included. Hence the modal confirmation that says so, the scope
// limited to the theme in use, and the record of exactly which keys were
// written so that resetting removes ours and leaves everything else alone.
const PILL_SLOTS = {
  warn: ['statusBarItem.warningBackground', 'statusBarItem.warningForeground',
         'statusBarItem.warningHoverBackground'],
  crit: ['statusBarItem.errorBackground', 'statusBarItem.errorForeground',
         'statusBarItem.errorHoverBackground']
};
const PILL_STATE = 'claudeLimits.pillKeys';
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function hexParts(h) {
  let s = h.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// The hover colour is not asked for: one more question for a shade nobody
// pictures in advance. It is the background nudged towards the text colour, so
// it is always visibly different and always in the same family, whether the
// user picked something dark or something light.
function hoverOf(bg, fg) {
  const a = hexParts(bg), b = hexParts(fg);
  const mix = a.map((v, i) => Math.round(v + (b[i] - v) * 0.14));
  return '#' + mix.map(v => v.toString(16).padStart(2, '0')).join('');
}

function activeThemeScope() {
  const name = vscode.workspace.getConfiguration('workbench').get('colorTheme', '');
  return name ? '[' + name + ']' : null;
}

// Merge, never replace: this object commonly holds customisations that have
// nothing to do with us, and rewriting it whole would silently drop them.
async function writePillColors(context, slot, bg, fg, scope) {
  const conf = vscode.workspace.getConfiguration('workbench');
  const cur = conf.get('colorCustomizations') || {};
  const next = Object.assign({}, cur);
  const values = [bg, fg, hoverOf(bg, fg)];
  const keys = PILL_SLOTS[slot];
  if (scope) {
    next[scope] = Object.assign({}, next[scope] || {});
    keys.forEach((k, i) => { next[scope][k] = values[i]; });
  } else {
    keys.forEach((k, i) => { next[k] = values[i]; });
  }
  await conf.update('colorCustomizations', next, vscode.ConfigurationTarget.Global);

  const written = (context.globalState.get(PILL_STATE) || [])
    .filter(e => !(e.scope === (scope || null) && keys.indexOf(e.key) !== -1));
  keys.forEach(k => written.push({ scope: scope || null, key: k }));
  await context.globalState.update(PILL_STATE, written);
}

// The flow itself. Nothing is written before the modal, and the modal spells
// out the exact keys: a colour preference that quietly edits settings.json is
// the kind of thing people discover months later and cannot explain.
async function pillColorFlow(context) {
  const scope = activeThemeScope();
  const done = (context.globalState.get(PILL_STATE) || []).length > 0;
  const items = [
    { label: i18n.t('The current pill'), id: 'warn',
      description: i18n.t('shown from the warning threshold on') },
    { label: i18n.t('The critical threshold'), id: 'crit',
      description: i18n.t('shown at 90% and above') }
  ];
  if (done) items.push({ label: i18n.t('Reset'), id: 'reset',
    description: i18n.t('remove the colours written by this extension') });

  const pick = await vscode.window.showQuickPick(items, {
    title: i18n.t('Status bar pill colour'),
    placeHolder: i18n.t('Which state should be recoloured?')
  });
  if (!pick) return;

  if (pick.id === 'reset') {
    const ok = await vscode.window.showWarningMessage(
      i18n.t('Remove the status bar colours written by this extension?'),
      { modal: true, detail: i18n.t('Only the keys written from here are removed. Anything else in your colour customisations stays untouched.') },
      i18n.t('Remove'));
    if (!ok) return;
    const n = await resetPillColors(context);
    vscode.window.showInformationMessage(i18n.t('{0} colour keys removed.', String(n)));
    return;
  }

  const ask = async (prompt, value) => vscode.window.showInputBox({
    title: i18n.t('Status bar pill colour'), prompt, value, ignoreFocusOut: true,
    validateInput: v => (HEX_RE.test((v || '').trim()) ? null
      : i18n.t('Expected a hexadecimal colour, for instance #7a3fd4 or #7a3fd4cc.'))
  });
  const bg = await ask(i18n.t('Background colour'), '#');
  if (!bg) return;
  const fg = await ask(i18n.t('Text colour on that background'), '#ffffff');
  if (!fg) return;

  const keys = PILL_SLOTS[pick.id];
  const detail =
    i18n.t('Keys written to your user settings:') + '\n' +
    keys.map(k => '  ' + (scope ? scope + ' > ' : '') + k).join('\n') + '\n\n' +
    (scope
      ? i18n.t('Scope: the {0} theme only. Your other themes keep their own colours.', scope.slice(1, -1))
      : i18n.t('Scope: every theme, because no colour theme could be read.')) + '\n\n' +
    i18n.t('This redefines a workbench colour, not our own item. Every warning or error item in the status bar takes it, including those from other extensions.');
  const go = await vscode.window.showWarningMessage(
    i18n.t('Write these colours to your settings?'), { modal: true, detail }, i18n.t('Write'));
  if (!go) return;

  await writePillColors(context, pick.id, bg.trim(), fg.trim(), scope);
  vscode.window.showInformationMessage(
    i18n.t('Colours applied. Reverse them from the same menu, entry "{0}".', i18n.t('Reset')));
}

async function resetPillColors(context) {
  const written = context.globalState.get(PILL_STATE) || [];
  if (!written.length) return 0;
  const conf = vscode.workspace.getConfiguration('workbench');
  const cur = conf.get('colorCustomizations') || {};
  const next = JSON.parse(JSON.stringify(cur));
  let n = 0;
  for (const e of written) {
    const bag = e.scope ? next[e.scope] : next;
    if (bag && Object.prototype.hasOwnProperty.call(bag, e.key)) { delete bag[e.key]; n++; }
    // A scope left empty is noise in the settings file, so it goes too. Only
    // one we emptied ourselves: a scope the user filled keeps its keys.
    if (e.scope && next[e.scope] && Object.keys(next[e.scope]).length === 0) delete next[e.scope];
  }
  await conf.update('colorCustomizations',
    Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
  await context.globalState.update(PILL_STATE, []);
  return n;
}

// A reused formatter: toLocaleTimeString() would rebuild one on every call.
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtTime(ts) { return TIME_FMT.format(ts); }

// ---------------------------------------------------------------- shared cache

// Read filtered by mtime: as long as the file hasn't moved, no readFileSync
// and no JSON.parse (each window used to poll 4 times a minute).
let cacheKey = '';
let cacheVal = null;
function readCache() {
  let st;
  try { st = fs.statSync(CACHE_PATH); }
  catch (e) { cacheKey = ''; cacheVal = null; return null; }
  // The inode is part of the key: writeCache goes through a rename, so every
  // write lands on a fresh one. Without it, two writes of the same length
  // within the same second are indistinguishable on a filesystem whose mtime
  // has one-second granularity (HFS+, some NFS/CIFS mounts) and the window
  // would keep showing stale figures.
  const key = st.mtimeMs + ':' + st.size + ':' + st.ino;
  if (key === cacheKey) return cacheVal;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (c && typeof c.at === 'number' && (c.rows || c.data)) {
      cacheKey = key;
      cacheVal = c;
      return c;
    }
  } catch (e) { /* write in progress: keep the previous version */ }
  return cacheVal;
}

// Atomic write (temp file + rename): another window can no longer read a
// truncated JSON file while it is being written.
function writeCache(rows, alerted, credits) {
  const at = Date.now();
  const obj = { v: 2, at, rows: packRows(rows), cr: credits || null, alerted, data: legacyData(rows) };
  const txt = JSON.stringify(obj);
  try {
    // 0600 explicitly: left to the default umask this lands in 0644 on
    // macOS/Linux, readable by every account on the machine, whereas on Windows
    // it inherits the profile ACL. The rest of ~/.claude is user-only.
    fs.writeFileSync(CACHE_TMP, txt, { mode: 0o600 });
    // On Windows a rename over a file another window is reading fails with
    // EPERM/EBUSY (sharing violation). Those reads last microseconds, so a
    // couple of retries almost always win, and they are worth trying: the
    // fallback below is a non-atomic write straight over the live file.
    let renamed = false;
    for (let i = 0; i < 3 && !renamed; i++) {
      try { fs.renameSync(CACHE_TMP, CACHE_PATH); renamed = true; }
      catch (e) {
        if (i === 2) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(CACHE_TMP); } catch (_) { /* nothing to clean up */ }
    try { fs.writeFileSync(CACHE_PATH, txt, { mode: 0o600 }); } catch (_) { return at; }
  }
  // realign the mtime filter so we don't re read our own write
  cacheVal = obj;
  try {
    const st = fs.statSync(CACHE_PATH);
    cacheKey = st.mtimeMs + ':' + st.size + ':' + st.ino;   // same shape as readCache
  } catch (e) { cacheKey = ''; }
  return at;
}

// ---------------------------------------------------------------- extension

function activate(context) {
  let last = null;          // { rows, error, at }
  let inFlight = false;
  let lastFetchAt = 0;      // last real network call (anti spam)
  let lastCacheAt = 0;      // timestamp of the cache currently displayed
  let backoffUntil = 0;     // end of the pause after an error (429, offline...)
  let webviewView = null;      // the side-bar view (left or secondary)
  let htmlLang = null;         // language the panel's baked dictionary was built in
  let timer = null;
  let ticking = false;
  let lastSig = '';         // signature of the last render (avoids identical re renders)
  const alerted = Object.create(null);   // thresholds already notified, shared via the cache

  // Language, before anything is built. 'auto' follows the editor, any other
  // value overrides it. Read once here, and again whenever the user changes it.
  i18n.load(context.globalState.get('uiLanguage', 'auto'), vscode.env.language);
  const companion = require('./companion/ui.js').activate(context);
  context.subscriptions.push(companion.onDidChange(() => { render(true); pushToWebview(); }));
  require('./companion/updates.js').activate(context);

  // --- VAULT: isolated in a try/catch so that a vault failure never deprives
  // the user of their usage counters, the extension's original feature.
  // vault stays null if the module fails to load; the "Secrets" section then
  // shows the reason instead of silently disappearing.
  let vault = null;
  let vaultError = null;
  try {
    if (vscode.workspace.isTrusted) {
      vault = require('./vault/ui.js').activateVault(context, VERSION, () => pushToWebview());
    } else {
      vaultError = i18n.t('Trust this workspace before connecting an assistant or using project memory.');
      context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
        try {
          vault = require('./vault/ui.js').activateVault(context, VERSION, () => pushToWebview());
          vaultError = null;
        } catch (e) { vaultError = e.message; }
        pushToWebview();
      }));
    }
  } catch (e) {
    vaultError = e && e.message ? e.message : String(e);
    console.error('Claude Vault unavailable:', e);
  }

  // The left-hand placeholder, alive only while the panel sits next to the chat.
  // VS Code hides a container as soon as every one of its views has a false
  // when-clause, and a badge belongs to a view — so without something here, the
  // icon and its counter vanish the moment the panel moves right. It carries NO
  // rows: repeating the figures the panel already shows was the duplicate. Just
  // a title, the summary in its description, the badge, and — once unfolded —
  // the welcome text that says where the panel went and offers to bring it back.
  const gaugeEmitter = new vscode.EventEmitter();
  const gaugeView = vscode.window.createTreeView('claudeMonitorVault.summary', {
    treeDataProvider: {
      onDidChangeTreeData: gaugeEmitter.event,
      getChildren: () => [],
      getTreeItem: i => i
    }
  });
  context.subscriptions.push(gaugeView, gaugeEmitter);

  // --- THE PANEL: single webview (quota bars, secrets, ghost skeleton).
  // No retainContextWhenHidden: the webview restores its state via getState/setState
  // and we push data back to it whenever it becomes visible again.
  const panelProvider = {
    resolveWebviewView(v) {
      webviewView = v;
      v.webview.options = { enableScripts: true, localResourceRoots: [] };
      v.webview.html = getHtml(panelStrings());
      htmlLang = i18n.current();
      const subs = [
        v.webview.onDidReceiveMessage(m => onWebviewMessage(m)),
        v.onDidChangeVisibility(() => {
          if (v.visible) v.webview.postMessage(payload());
          schedule();               // visible: cosmetic tick; hidden: longer sleep
        })
      ];
      v.onDidDispose(() => {
        subs.forEach(d => d.dispose());
        if (webviewView === v) { webviewView = null; schedule(); }
      });
      v.webview.postMessage(payload());
      renderHeaders();
    }
  };
  // One provider, two view ids: the panel in the activity bar and its twin next
  // to the chat. Both containers are real, so exactly one twin is alive at any
  // time and webviewView always points at it.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeMonitorVault.panel', panelProvider),
    vscode.window.registerWebviewViewProvider('claudeMonitorVaultAux.panel', panelProvider)
  );

  // The context key is phrased POSITIVELY and the default is the secondary side
  // bar, so its unset state — which is what it is until activation sets it —
  // already means "next to the chat". Phrased the other way round, every start
  // would flash the panel on the left before moving it.
  function inSecondary() { return cfg().location === 'secondarySidebar'; }
  function activePanelId() {
    return inSecondary() ? 'claudeMonitorVaultAux.panel' : 'claudeMonitorVault.panel';
  }
  function applyLocation() {
    return vscode.commands.executeCommand('setContext', 'claudeLimits.inSecondary', inSecondary());
  }
  applyLocation();

  async function moveTo(loc) {
    try {
      await vscode.workspace.getConfiguration('claudeLimits')
        .update('location', loc, vscode.ConfigurationTarget.Global);
      cfgCache = null;
      await applyLocation();
      vscode.commands.executeCommand(activePanelId() + '.focus');
    } catch (e) { /* the location is a preference: never break on it */ }
  }

  // Alignment is fixed at creation, so a change of side means rebuilding the
  // item. buildStatus is idempotent: it only recreates when the side actually
  // changed, and disposes the old one so nothing lingers.
  let status = null;
  let statusAlign = null;
  function buildStatus() {
    const pos = cfg().statusPos === 'left'
      ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    if (status && statusAlign === pos) return;
    if (status) status.dispose();
    status = vscode.window.createStatusBarItem(pos, 100);
    status.name = 'Claude Monitor';
    status.text = '$(sparkle) Claude …';
    status.command = 'claudeLimits.open';
    statusAlign = pos;
    context.subscriptions.push(status);
  }
  buildStatus();

  function applyStatusVisibility() {
    if (cfg().statusBar) status.show(); else status.hide();
  }
  applyStatusVisibility();

  // Actions coming from the panel. The webview never acts on its own: it
  // asks, the extension decides, and typing a secret stays in a native
  // masked input box, never in the DOM.
  function onWebviewMessage(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case 'quotaDisplay': return companion.setDisplay(m.value);
      case 'assistantActions': return vscode.commands.executeCommand('agentBridge.actions');
      case 'connectCodex': return vscode.commands.executeCommand('agentBridge.connectVault');
      // render() explicitly: poll() only fetches, so without it the badge, the
      // status bar and the gauge stayed frozen until the next tick.
      case 'refresh': return Promise.all([poll(true), companion.refresh()]).then(() => { render(); schedule(); });
      case 'create': return vault && vault.createFromPanel(m);
      case 'add': return vscode.commands.executeCommand('claudeVault.add');
      case 'del': return vscode.commands.executeCommand('claudeVault.delete', m.name);
      case 'ttl': return vscode.commands.executeCommand('claudeVault.setTtl', m.name);
      case 'copy': return vscode.commands.executeCommand('claudeVault.copyMarker', m.name);
      case 'rename': return vscode.commands.executeCommand('claudeVault.rename', m.name);
      case 'replace': return vscode.commands.executeCommand('claudeVault.replace', m.name);
      case 'info': return vscode.commands.executeCommand('claudeVault.details', m.name);
      case 'mcp': return vscode.commands.executeCommand('claudeVault.toggleMcp', m.name);
      case 'mcpserver': return vscode.commands.executeCommand('claudeVault.mcpSnippet', m.name);
      case 'reveal': return vscode.commands.executeCommand('claudeVault.reveal', m.name);
      case 'actions': return vscode.commands.executeCommand('claudeVault.actions', m.name);
      case 'audit': return vscode.commands.executeCommand('claudeVault.audit');
      case 'connect': return vscode.commands.executeCommand('claudeVault.connect');
      case 'settings': return vscode.commands.executeCommand('claudeVault.settings');
      case 'recovery': return vscode.commands.executeCommand('claudeVault.recovery');
      case 'public': return vscode.commands.executeCommand('claudeVault.togglePublic', m.name);
      case 'terminal': return vscode.commands.executeCommand('claudeVault.terminal');
      case 'confirm': return vscode.commands.executeCommand('claudeVault.toggleConfirm', m.name);
      // Groups and separators. Ids and names are checked again on the vault
      // side: a stale or scripted message can at worst do nothing.
      case 'groupToggle': return vault && vault.groupToggle(m.id);
      case 'groupMenuAct': return vault && vault.groupMenuAct(m.act, m.id);
      case 'sepMenuAct': return vault && vault.sepMenuAct(m.act, m.id);
      case 'moveKey': return vault && vault.moveKey(m.name, m.groupId);
      case 'moveKeyNew': return vault && vault.moveKeyToNewGroup(m.name);
      case 'moveItem': return vault && vault.moveItemTo(m.id, m.toIndex);
      case 'collapseAll': return vault && vault.collapseAll(true);
      case 'expandAll': return vault && vault.collapseAll(false);
      case 'newGroup': return vscode.commands.executeCommand('claudeVault.newGroup');
      case 'newSeparator': return vscode.commands.executeCommand('claudeVault.newSeparator');
      case 'suggestGroups': return vscode.commands.executeCommand('claudeVault.suggestGroups');
    }
  }

  // The panel carries two kinds of text: the row labels, which travel with the
  // data and are translated at every refresh, and a dictionary baked into the
  // HTML once, when the view is drawn. Those two can drift apart, and the panel
  // then shows French labels above English wording. Rather than chase every way
  // that can happen, the panel remembers which language its dictionary was built
  // in and rebuilds itself the moment it stops matching.
  function postPayload() {
    if (webviewView && htmlLang !== null && htmlLang !== i18n.current()) {
      webviewView.webview.html = getHtml(panelStrings());
      htmlLang = i18n.current();
    }
    const p = payload();
    if (webviewView && webviewView.visible) webviewView.webview.postMessage(p);
  }
  function pushToWebview() { postPayload(); }

  function payload() {
    const nextAt = lastCacheAt ? lastCacheAt + cfg().pollMs : 0;
    const vaultState = vault
      ? vault.snapshot()
      : { secrets: [], issues: [{ level: 'error', msg: vaultError || i18n.t('vault unavailable') }],
          connected: false, needsUpdate: false, layout: [], pending: [], policy: null };
    const c = cfg();
    const pause = (c.pauseWhenExhausted && last) ? pauseUntilOf(last.rows) : 0;
    return {
      companion: codexPayload(companion.snapshot(), c),
      vault: vaultState,
      defaults: vault ? vault.getDefaults() : null,
      credits: (c.showCredits && last) ? (last.credits || null) : null,
      pause: pause && pause > Date.now() ? pause : 0,
      // resetAt is sent already parsed: the webview no longer has a date to interpret
      rows: last ? last.rows.map(r => ({
        label: r.label, short: r.short, pct: r.pct, level: r.level, resetAt: r.resetAt,
        hitsAt: projectFull(r, c)
      })) : [],
      error: last ? last.error : null,
      at: last ? last.at : '',
      next: nextAt ? fmtTime(nextAt) : ''
    };
  }

  // ---- consumption projection
  //
  // The gauges say where you stand; they never say where you are heading. With
  // a handful of samples the slope is enough to answer the only question that
  // actually changes what you do next: does this run out before it resets?
  //
  // Deliberately conservative. It reports nothing unless the samples span a
  // real stretch of time, the slope is genuinely rising, and the ceiling lands
  // before the reset. A projection that cries wolf gets ignored, and then the
  // one that mattered gets ignored too.
  const HIST = Object.create(null);
  const HIST_MAX = 40;
  const HIST_MIN_SPAN = 900000;                    // 15 min of observation

  function noteHistory(rows) {
    const now = Date.now();
    for (const r of rows || []) {
      const h = HIST[r.short] || (HIST[r.short] = []);
      // A drop means the window reset: what came before describes another
      // period and would flatten the slope of this one.
      if (h.length && r.pct < h[h.length - 1].pct - 0.5) h.length = 0;
      h.push({ t: now, pct: r.pct });
      if (h.length > HIST_MAX) h.shift();
    }
  }

  function projectFull(r, c) {
    // ChatGPT rows carry their own history key in `short` and say which limit
    // type they behave like in `kind`, so one option governs both providers.
    const kind = r.kind || r.short;
    if (kind === '5h' && !c.projectionSession) return 0;
    if (kind === 'sem' && !c.projectionWeek) return 0;
    const h = HIST[r.short];
    if (!h || h.length < 3 || r.pct >= 100) return 0;
    const span = h[h.length - 1].t - h[0].t;
    if (span < HIST_MIN_SPAN) return 0;
    // Least squares over the window: a single pair of points turns one burst
    // of activity into a prediction, and every pause into a retraction.
    let st = 0, sp = 0, stt = 0, stp = 0;
    const n = h.length, t0 = h[0].t;
    for (const p of h) {
      const x = (p.t - t0) / 3600000;              // hours, so the slope reads as %/h
      st += x; sp += p.pct; stt += x * x; stp += x * p.pct;
    }
    const denom = n * stt - st * st;
    if (denom <= 0) return 0;
    const slope = (n * stp - st * sp) / denom;
    if (slope < 1) return 0;                       // under 1 %/h: not worth a claim
    const at = Date.now() + ((100 - r.pct) / slope) * 3600000;
    if (!isFinite(at)) return 0;
    // If the window resets first, there is nothing to warn about.
    if (isFinite(r.resetAt) && r.resetAt && at >= r.resetAt) return 0;
    return Math.round(at);
  }

  // ---- ChatGPT / Codex rows, shaped like the Claude ones
  //
  // The two quota blocks must read the same way: labels from the window length,
  // the same countdown, the same projection, the same 70/90 levels. Building the
  // ChatGPT rows here, next to the Claude ones and with the same fields, is what
  // lets the panel, the status bar and the badge use a single code path for
  // both. Only the colour stays ChatGPT's own (colors.paint, custom setting).
  const CODEX_KEY = 'cx:';                         // history keys never collide with Claude's
  let codexSeen = 0;

  function codexRows(snap, c) {
    const qs = (snap && snap.quotas) || [];
    const labels = qs.map(q => windowLabel(q.minutes) || q.label || 'ChatGPT');
    return qs.map((q, i) => {
      const kind = windowKind(q.minutes);
      // Two plans with the same window would read as twin rows: only then does
      // the plan name join the label. Otherwise it stays in the tooltip.
      const twin = labels.indexOf(labels[i]) !== labels.lastIndexOf(labels[i]);
      const r = {
        label: twin && q.label ? labels[i] + ' · ' + q.label : labels[i],
        title: [q.label, q.plan].filter(Boolean).join(' · '),
        short: CODEX_KEY + q.id,
        kind,
        abbr: q.minutes === 300 ? i18n.t('5h') : q.minutes === 10080 ? i18n.t('wk') : labels[i],
        pct: q.pct,
        level: q.level || levelOf(q.pct),
        color: q.color || null,
        resetAt: Number.isFinite(q.resetAt) ? q.resetAt : NaN
      };
      r.hitsAt = projectFull(r, c);
      return r;
    });
  }

  // One sample per poll period, as for Claude. The companion reads ChatGPT's
  // quota again on every terminal or tab change, each reading with a fresh
  // `updated`, so sampling every update let a busy user fill the forty slots
  // in a few minutes: the history never spanned the fifteen minutes the
  // projection needs, and when it did, it rested on a much shorter stretch
  // than Claude's. A window reset still clears the history at once, and a
  // limit seen for the first time is sampled straight away.
  let codexSampleAt = 0;

  function noteCodex(snap) {
    if (snap && !snap.updated) codexSampleAt = 0;   // readings cleared (setting changed)
    if (!snap || !snap.updated || snap.updated === codexSeen) return;
    codexSeen = snap.updated;
    const rows = snap.quotas.map(q => ({ short: CODEX_KEY + q.id, pct: q.pct }));
    const fresh = rows.some(r => {
      const h = HIST[r.short];
      return !h || !h.length || r.pct < h[h.length - 1].pct - 0.5;
    });
    if (codexSampleAt && snap.updated - codexSampleAt < cfg().pollMs && !fresh) return;
    codexSampleAt = snap.updated;
    noteHistory(rows);
  }

  function codexPayload(snap, c) {
    return Object.assign({}, snap, {
      rows: codexRows(snap, c),
      at: snap.updated ? fmtTime(snap.updated) : '',
      next: snap.next ? fmtTime(snap.next) : ''
    });
  }

  // ---- alerts: evaluated once, by the window that made the call, and
  // recorded in the shared cache so we don't notify N times across N windows.
  function mergeAlerted(src) {
    if (!src) return;
    for (const k in src) alerted[k] = 1;
  }

  function purgeAlerted() {
    const keys = Object.keys(alerted);
    if (keys.length > 64) { for (const k of keys) delete alerted[k]; return; }
    const cutoff = Date.now() - ALERT_TTL_MS;
    for (const k of keys) {
      const t = Date.parse(k.slice(k.indexOf('|') + 1));
      if (isFinite(t) && t < cutoff) delete alerted[k];
    }
  }

  function checkAlerts(rows) {
    if (!cfg().alerts) return;
    purgeAlerted();
    const fire = (row, th, txt) => {
      if (!row || row.pct < th) return;
      const key = txt + th + '|' + row.resets;
      if (alerted[key]) return;
      alerted[key] = 1;
      vscode.window.showWarningMessage(i18n.t(
        'Claude: {0} at {1}%, {2}', txt, String(Math.round(row.pct)), etaText(row.resetAt)));
    };
    const s5 = rows.find(r => r.short === '5h');
    const w7 = rows.find(r => r.short === 'sem');
    fire(s5, 80, i18n.t('session (5h)'));
    fire(s5, 95, i18n.t('session (5h)'));
    fire(w7, 90, i18n.t('weekly limit'));
  }

  // ---- rendu

  // Fingerprint of everything that's displayed: as long as it doesn't
  // change, we touch neither the status bar, nor the tree view, nor the webview.
  function signature(snap) {
    if (!last) return '';
    let s = last.at + '|' + (last.error || '') + '|' + lastCacheAt +
            '|' + (last.credits ? last.credits.used + ':' + last.credits.pct : '');
    for (const r of last.rows) {
      s += '|' + r.short + ':' + r.pct.toFixed(1) + ':' + r.level + ':' + etaText(r.resetAt);
    }
    // The ChatGPT counters tick down like Claude's, so their countdown belongs
    // in the fingerprint too, or the status bar tooltip would freeze between
    // two ChatGPT updates.
    if (snap) {
      s += '|' + snap.providers.join(',') + ':' + snap.updated + ':' + (snap.error || '');
      for (const q of snap.quotas) s += '|' + q.id + ':' + q.pct.toFixed(1) + ':' + etaText(q.resetAt);
    }
    return s;
  }

  // What each displayed provider brings to the counters outside the panel,
  // in one shape, so the status bar and the badge treat ChatGPT exactly like
  // Claude. `named` says whether the provider's name has to lead its figures:
  // Claude alone keeps its historic unnamed text, everything else is named.
  function providerBlocks(snap) {
    snap = snap || companion.snapshot();
    const blocks = [];
    if (snap.providers.includes('claude') && last) {
      blocks.push({ name: 'Claude', title: 'Claude', rows: last.rows, error: last.error,
        at: last.at, next: lastCacheAt ? fmtTime(lastCacheAt + cfg().pollMs) : '' });
    }
    if (snap.providers.includes('codex')) {
      blocks.push({ name: 'ChatGPT', title: 'ChatGPT / Codex', rows: codexRows(snap, cfg()),
        error: snap.error || null,          // a memory/vault setup issue is not a quota fault
        at: snap.updated ? fmtTime(snap.updated) : '', next: snap.next ? fmtTime(snap.next) : '' });
    }
    const multi = blocks.length > 1;
    for (const b of blocks) b.named = multi || b.name !== 'Claude';
    return blocks;
  }

  function rowOfKind(rows, kind) { return rows.find(r => (r.kind || r.short) === kind); }

  // The figure that speaks for a provider: the session, else the fullest limit.
  function leadPct(rows) {
    const s5 = rowOfKind(rows, '5h');
    return s5 ? s5.pct : rows.reduce((m, r) => Math.max(m, r.pct), 0);
  }

  function renderHeaders(snap) {
    if (!last) return;
    let badge;
    const blocks = providerBlocks(snap);
    const multi = blocks.length > 1;
    const segs = [];
    let lead = null;
    for (const b of blocks) {
      const s5 = rowOfKind(b.rows, '5h');
      const w7 = rowOfKind(b.rows, 'sem');
      const parts = [];
      if (s5) parts.push(Math.round(s5.pct) + '% ' + s5.abbr);
      if (w7) parts.push(Math.round(w7.pct) + '% ' + w7.abbr);
      if (!b.rows.length && !multi) continue;
      segs.push((b.named ? b.name + ' ' : '') + (parts.length ? parts.join(multi ? ', ' : ' · ') : '…') +
        (b.error ? ' ⚠' : ''));
      const l = s5 || w7;
      if (l && (!lead || l.pct > lead.row.pct)) lead = { row: l, block: b };
    }
    const head = segs.join(' · ');
    // The activity-bar badge is numeric-only: VS Code's ViewBadge.value is a
    // number, so it cannot carry a "%" sign, no API can. We show the session
    // percentage as the bare number (67 for 67%) and put the "%" in the
    // tooltip, the only place text is allowed. The session (5h) leads; the
    // weekly figure stands in only if there is no session row. With both
    // providers shown, the fuller of the two speaks. On by default, switched
    // off from the settings.
    if (cfg().badge && lead) {
      const pct = Math.round(lead.row.pct);
      if (pct > 0) {
        badge = { value: pct, tooltip: multi ? head
          : (lead.block.named ? lead.block.name + ' ' : '') + lead.row.label + ' ' + pct + '%' };
      }
    }
    if (webviewView) {
      webviewView.description = head;
      // The badge stays a LEFT-side signal: on the right the panel is already
      // in plain sight, and the placeholder below is what keeps the activity-bar
      // icon alive. Carrying it on both would make VS Code sum the two.
      webviewView.badge = inSecondary() ? undefined : badge;
    }
    gaugeView.description = head;
    gaugeView.badge = inSecondary() ? badge : undefined;
  }

  // Two looks, within what the status bar API allows. A custom background is
  // NOT permitted: only the warning amber and the error red render, anything
  // else is dropped without a word. The foreground has no such limit, but it is
  // overridden the moment a background is applied, which is the whole reason
  // "subtle" sets no background at all: the text carries the colour and the
  // background stays the theme's own.
  //   prominent (default): the amber pill at all times, red at crit.
  //   subtle:              no pill ever, the text follows the bands.
  function paintStatus(lvl, pct) {
    if (cfg().statusStyle === 'subtle' && typeof pct === 'number') {
      status.backgroundColor = undefined;
      status.color = bandTheme(bandColor(pct, cfg().statusBands));
      return;
    }
    // No figures to place on the scale: this is a fault, not a fill level, so
    // it keeps the amber it has always had whatever the chosen style.
    status.color = undefined;
    status.backgroundColor = lvl === 'crit' ? BG_CRIT : BG_WARN;
  }

  // Session spelled out by default; the week is added only when the user asks
  // for it, or stands in when there is no session row at all. With both
  // providers on one item, the short form keeps it to a glance.
  function statusBrief(rows, short) {
    const s5 = rowOfKind(rows, '5h');
    const w7 = rowOfKind(rows, 'sem');
    const week = w7 && (cfg().statusWeek || !s5);
    const parts = [];
    if (short) {
      if (s5) parts.push(Math.round(s5.pct) + '%' + (week ? ' ' + s5.abbr : ''));
      if (week) parts.push(Math.round(w7.pct) + '% ' + w7.abbr);
      return parts.join(', ');
    }
    if (s5) parts.push(i18n.t('session: {0}%', String(Math.round(s5.pct))));
    if (week) parts.push(i18n.t('week: {0}%', String(Math.round(w7.pct))));
    return parts.join(' · ');
  }

  function renderStatus(snap) {
    if (!cfg().statusBar) return;          // hidden: nothing to compute
    const blocks = providerBlocks(snap);
    const multi = blocks.length > 1;
    const rows = [].concat(...blocks.map(b => b.rows));
    const errors = blocks.map(b => b.error).filter(Boolean);
    if (!rows.length) {
      status.text = '$(warning) ' + (blocks.map(b => b.name).join(' · ') || 'Claude') + ' ?';
      // Each provider's fault under its own name: a ChatGPT error shown as
      // "Claude Limits, ..." sends the user looking in the wrong place. Claude
      // alone keeps its historic wording.
      status.tooltip = !blocks.length || (blocks.length === 1 && blocks[0].name === 'Claude')
        ? i18n.t('Claude Limits, {0}', errors.join(' · ') || i18n.t('no data'))
        : blocks.map(b => i18n.t('{0}: {1}', b.title, b.error || i18n.t('no data'))).join('\n');
      paintStatus('warn');
      return;
    }
    // $(dashboard) is a built-in gauge codicon: it echoes our activity-bar
    // gauge, unlike the old sparkle. The status bar only takes Codicons, so our
    // exact SVG cannot go here; this is the closest native match.
    status.text = '$(dashboard) ' + blocks.map(b =>
      (b.named ? b.name + ' ' : '') + (statusBrief(b.rows, multi) || '…')).join(' · ') +
      (errors.length ? ' $(warning)' : '');
    // Same tooltip for every provider: each row with its countdown, then when
    // the figures were read and when they will be read again.
    status.tooltip = new vscode.MarkdownString(blocks.map(b => {
      const lines = b.rows.map(r => {
        const eta = etaText(r.resetAt);
        return '**' + r.label + '**: ' + Math.round(r.pct) + '%' + (eta ? ', ' + eta : '');
      });
      lines.push('_' + (b.at ? i18n.t('updated {0}', b.at) : i18n.t('no data')) +
        (b.next ? ' · ' + i18n.t('next ≈ {0}', b.next) : '') +
        (b.error ? ', ⚠ ' + b.error : '') + '_');
      return (b.named ? '**' + b.title + '**\n\n' : '') + lines.join('\n\n');
    }).join('\n\n---\n\n') + '\n\n_' + i18n.t('Click to open the panel') + '_');
    // The session drives the colour, because that is the number the bar shows
    // and the one that empties within the day. Without a session row, the
    // fullest limit stands in rather than leaving the scale unread. With both
    // providers, the fuller one decides.
    paintStatus(worstLevel(rows), Math.max(...blocks.map(b => leadPct(b.rows))));
  }

  function render(force) {
    const snap = companion.snapshot();
    if (!last) {
      if (!snap.providers.includes('codex')) return;
      last = { rows: [], error: null, at: '' };
    }
    noteCodex(snap);
    const sig = signature(snap);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    renderStatus(snap);
    renderHeaders(snap);
    postPayload();
  }

  // ---- data

  function applyCache(cache) {
    lastCacheAt = cache.at;
    last = { rows: rowsOfCache(cache), credits: creditsOfCache(cache),
             error: null, at: fmtTime(cache.at) };
    noteHistory(last.rows);
    mergeAlerted(cache.alerted);
  }

  // GLOBAL clock: the next refresh is defined by the age of the shared cache
  // (cache.at + pollSeconds), identical for every window. Only the ACTIVE
  // window triggers the server call; the others just follow the cache.
  async function poll(force) {
    if (!companion.snapshot().providers.includes('claude')) return;
    if (inFlight) return;
    const now = Date.now();
    const c = cfg();
    const cache = readCache();
    if (cache && cache.at !== lastCacheAt) applyCache(cache);

    // Quota exhausted: we sleep until the reset time announced by Anthropic.
    // Querying the API while we're blocked cannot learn anything new.
    // The refresh button bypasses this: if you re enable the quota some other
    // way (credits, plan change), you must be able to see it right away.
    const pause = (c.pauseWhenExhausted && last) ? pauseUntilOf(last.rows) : 0;
    if (!force && pause && now < pause) return;

    const age = cache ? now - cache.at : Infinity;
    const cooled = now - lastFetchAt >= FETCH_COOLDOWN_MS;
    const due = age >= c.pollMs && now >= backoffUntil;
    if (!cooled || (!force && !due)) return;
    // inactive window: no server call, it just follows the shared cache
    if (!force && !vscode.window.state.focused) return;

    inFlight = true;
    try {
      lastFetchAt = Date.now();
      const data = await fetchUsage();
      const rows = buildRows(data);
      const credits = buildCredits(data);
      backoffUntil = 0;
      checkAlerts(rows);                       // before the write: fired thresholds go into the cache
      lastCacheAt = writeCache(rows, alerted, credits);
      last = { rows, credits, error: null, at: fmtTime(lastCacheAt) };
      noteHistory(rows);
    } catch (e) {
      let msg;
      if (e && e.status === 429) {
        const wait = Math.min(Math.max((e.retryAfter || 0) * 1000, BACKOFF_MS), BACKOFF_MAX_MS);
        backoffUntil = Date.now() + wait;
        msg = i18n.t('too many requests (429), pausing {0} min', String(Math.round(wait / 60000)));
      } else {
        backoffUntil = Date.now() + ERROR_BACKOFF_MS;
        msg = String((e && e.message) || e);
      }
      // keep showing the last known data
      last = {
        rows: (last && last.rows) || (cache ? rowsOfCache(cache) : []),
        credits: (last && last.credits) || (cache ? creditsOfCache(cache) : null),
        error: msg,
        at: last ? last.at : (cache ? fmtTime(cache.at) : '')
      };
    } finally {
      inFlight = false;
    }
  }

  // ---- scheduling
  // A single timer, rescheduled to the nearest useful deadline: a server
  // call becoming due, or a minute rollover while a countdown is on screen.
  function uiVisible() {
    return (webviewView && webviewView.visible) || cfg().statusBar;
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const now = Date.now();
    // without a cache, retry at the cooldown pace instead of in a tight loop
    const c = cfg();
    let base = lastCacheAt ? lastCacheAt + c.pollMs : (lastFetchAt || now) + FETCH_COOLDOWN_MS;
    // exhausted: the next useful piece of information arrives at reset, not before
    const pause = (c.pauseWhenExhausted && last) ? pauseUntilOf(last.rows) : 0;
    if (pause > base) base = pause;
    let delay = Math.max(base, backoffUntil) - now;
    // cosmetic refresh of the countdowns: at the next minute rollover
    if (uiVisible()) delay = Math.min(delay, 60000 - (now % 60000) + 200);
    delay = Math.min(Math.max(delay, MIN_SLEEP_MS), MAX_SLEEP_MS);
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  }

  async function tick() {
    if (ticking) return;                                  // a focus event during a call restarts nothing
    if (timer) { clearTimeout(timer); timer = null; }      // otherwise the running timer would stay armed
    ticking = true;
    try {
      const cache = readCache();
      if (cache && cache.at !== lastCacheAt) applyCache(cache);
      await poll(false);
      render();
    } finally {
      ticking = false;
      schedule();
    }
  }

  context.subscriptions.push({
    dispose: () => { if (timer) { clearTimeout(timer); timer = null; } }
  });

  // --- instant sync: as soon as another window writes the cache, we update
  // the display without waiting for the next cycle.
  let watchDebounce = null;
  let watcher = null;
  function startWatch() {
    try {
      watcher = fs.watch(CLAUDE_DIR, (event, fname) => {
        // Node does not guarantee a filename on macOS (FSEvents coalesces
        // events): dropping a null one would silently disable instant sync
        // between windows there. A null means "something moved", so we look.
        if (fname !== null && fname !== undefined
            && fname !== path.basename(CACHE_PATH)) return;   // very active directory: filter first
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          const c = readCache();
          if (c && c.at !== lastCacheAt) { applyCache(c); render(); schedule(); }
        }, WATCH_DEBOUNCE_MS);
      });
      // a watcher that dies silently would leave the windows out of sync
      watcher.on('error', () => { try { watcher.close(); } catch (e) {} watcher = null; });
    } catch (e) { /* fs.watch unavailable: the normal cycle is enough */ }
  }
  startWatch();
  context.subscriptions.push({
    dispose: () => {
      if (watcher) { try { watcher.close(); } catch (e) {} }
      if (watchDebounce) clearTimeout(watchDebounce);
      try { fs.unlinkSync(CACHE_TMP); } catch (e) {}
    }
  });

  // --- commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeLimits.refresh', async () => {
      await Promise.all([poll(true), companion.refresh()]);
      render();
      schedule();
    }),
    vscode.commands.registerCommand('claudeLimits.open', () =>
      vscode.commands.executeCommand(activePanelId() + '.focus')),
    // Relocation, handed to the workbench. It offers every destination VS Code
    // actually supports — including the secondary side bar, next to the chat —
    // and it remembers the choice. An extension cannot declare a container
    // there, which is exactly what used to make this button lie.
    //
    // The mirror buttons: same panel, other side. Both destinations are real
    // containers now, so this is a genuine move and not an illusion.
    vscode.commands.registerCommand('claudeLimits.moveToSecondary', () =>
      moveTo('secondarySidebar')),
    vscode.commands.registerCommand('claudeLimits.moveToPrimary', () =>
      moveTo('sidebar')),
    vscode.commands.registerCommand('claudeLimits.pillColor', () => pillColorFlow(context)),
    // Called by the settings window after a language change. The webview holds
    // a dictionary baked into its HTML, so it is rebuilt rather than nudged;
    // the row labels come back translated on the next render.
    vscode.commands.registerCommand('claudeLimits.relocalize', () => {
      i18n.load(context.globalState.get('uiLanguage', 'auto'), vscode.env.language);
      if (webviewView) {
        webviewView.webview.html = getHtml(panelStrings());
        htmlLang = i18n.current();
        webviewView.webview.postMessage(payload());
      }
      if (last) last.rows = last.rows.map(r => Object.assign({}, r, {
        label: i18n.t(DEF_BY_KEY.get(r.key) ? DEF_BY_KEY.get(r.key).label : r.label),
        abbr: i18n.t(DEF_BY_KEY.get(r.key) ? DEF_BY_KEY.get(r.key).abbr : r.abbr)
      }));
      render(true);
    }),
    vscode.commands.registerCommand('claudeVault.show', () =>
      vscode.commands.executeCommand(activePanelId() + '.focus')),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeLimits')) return;
      cfgCache = null;
      buildStatus();               // rebuild only if the side changed
      applyStatusVisibility();
      applyLocation();             // relocate the panel if the side setting changed
      render(true);
      schedule();
    }),
    // when focus comes back: this window becomes the active one, so it resumes the clock
    vscode.window.onDidChangeWindowState(st => { if (st.focused) tick(); })
  );

  // first render: the cache first (instant), then the clock
  const boot = readCache();
  if (boot) { applyCache(boot); render(); }
  tick();

  // Extension API: VSCode exposes it to other extensions, and it also makes
  // the whole thing testable without launching the editor.
  return { vault };
}

// ---------------------------------------------------------------- webview (Quota + Secrets tabs)

// Interface stance: in a side view, imposing a color palette or a font would
// fight the editor's theme, so everything is drawn from VSCode's own
// variables. The personality instead comes from how the information is
// designed: a secret is defined by the fact that it DIES, so its expiry is
// the main visual, a bar that empties out. That is exactly the language of
// the quota bars, so the two tabs end up telling the same story, something
// being consumed against a limit. Keys with no expiry have no bar at all:
// the absence is the signal.

// The panel lives in a webview, which cannot call i18n.t() itself: it runs
// in its own sandboxed frame with no access to the extension host. So every
// string it needs is translated here, on the extension side, and injected as a
// dictionary. Keys are short; the English source strings are what the l10n
// bundles are keyed on.
function panelStrings() {
  const t = i18n.t;
  return {
    secrets: t('Secrets'),
    newKey: t('New key'),
    keyName: t('KEY_NAME'),
    pasteValue: t('Paste the value'),
    options: t('Options'),
    create: t('Create'),
    cancel: t('Cancel'),
    expiry: t('Expiry'),
    none: t('None'),
    m5: t('5 minutes'),
    h1: t('1 hour'),
    h8: t('8 hours'),
    h24: t('24 hours'),
    d7: t('7 days'),
    burnFirst: t('Burn after first use'),
    allowMcp: t('Allow for MCP tools'),
    nameRequired: t('Give the key a name.'),
    nameRule: t('Uppercase letters, digits and underscores only, starting with a letter.'),
    exists: t('{0} already exists: creating it will replace the old value for good.', '{0}'),
    noKeys: t('No keys yet.'),
    noKeysHint: t('Create a key, then enable access for your assistant in its permissions.'),
    notConnected: t('Claude Code cannot read this vault yet.'),
    connectCodex: t('Connect Codex to the vault'),
    connOutdated: t('The connection to Claude Code is from an older version.'),
    connect: t('Connect to Claude Code'),
    updateConn: t('Update the connection'),
    auditLog: t('Access log'),
    connection: t('Connection'),
    assistantSettings: t('Assistant settings'),
    settings: t('Settings'),
    refreshNow: t('Refresh'),
    vaultTerminal: t('Open a vault terminal'),
    hitsAt: t('full ≈ {0}', '{0}'),
    agoNow: t('just now'),
    agoHours: t('{0} h ago', '{0}'),
    agoDays: t('{0} d ago', '{0}'),
    agoMonths: t('{0} mo ago', '{0}'),
    agoYears: t('{0} y ago', '{0}'),
    usedAgo: t('used {0}', '{0}'),
    neverUsed: t('never used'),
    staleHint: t('Created {0} and unused since: consider rotating it.', '{0}'),
    recoTitle: t('Back up this vault'),
    recoBody: t('A list of words that reopens the vault if the master key is ever lost.'),
    recoBtn: t('Create the backup key'),
    loading: t('loading…'),
    session5h: t('Session (5h)'),
    week: t('Week'),
    codexEmpty: t('No subscription quota returned'),
    resetsSoon: t('resets soon'),
    resetsH: t('resets in {0}h {1}', '{0}', '{1}'),
    resetsD: t('resets in {0}d {1}h', '{0}', '{1}'),
    updated: t('updated {0}', '{0}'),
    updatedNext: t('updated {0} · next ≈ {1}', '{0}', '{1}'),
    updatedPaused: t('updated {0} · paused', '{0}'),
    credits: t('Credits'),
    beyondPlan: t('beyond the plan'),
    capReached: t('spending cap reached'),
    pausedMin: t('Limit exhausted: calls suspended, resuming in {0} min.', '{0}'),
    pausedH: t('Limit exhausted: calls suspended, resuming in {0}h {1}.', '{0}', '{1}'),
    neverExpires: t('never expires'),
    expired: t('expired'),
    burnsNext: t('burns on next use'),
    usesLeft: t('{0} uses left', '{0}'),
    underMinute: t('under a minute'),
    min: t('{0} min', '{0}'),
    hm: t('{0}h {1}', '{0}', '{1}'),
    dh: t('{0}d {1}h', '{0}', '{1}'),
    chars: t('{0} characters', '{0}'),
    rowHint: t('click, or right-click, for all actions'),
    actCopy: t('Copy marker'),
    actDetails: t('Details'),
    actRename: t('Rename'),
    actReplace: t('Replace the value'),
    actTtl: t('Change expiry'),
    actMarkPublic: t('Mark as public'),
    actMarkSecret: t('Treat as a secret again'),
    tagPublic: t('publishable value, not watched'),
    actConfirmOn: t('Ask before every use'),
    actConfirmOff: t('Stop asking before every use'),
    tagConfirm: t('asks before every use'),
    actMcpServer: t('Use in an MCP server'),
    actMcpAllow: t('Allow for MCP'),
    actMcpRemove: t('Remove MCP authorisation'),
    actReveal: t('Reveal'),
    actDelete: t('Delete'),
    searchKeys: t('Search keys'),
    sortBy: t('Sort'),
    sortRecent: t('Newest first'),
    sortOldest: t('Oldest first'),
    sortName: t('Name (A to Z)'),
    runningOut: t('{0} key(s) running out', '{0}'),
    // groups and separators
    ungrouped: t('Ungrouped'),
    noGroup: t('No group'),
    group: t('Group'),
    groupNamePh: t('Group name'),
    newGroup: t('New group'),
    newGroupDots: t('New group…'),
    newSeparator: t('New separator'),
    separator: t('Separator'),
    suggestGroups: t('Suggest groups'),
    collapseAll: t('Collapse all'),
    expandAll: t('Expand all'),
    groupEmpty: t('Empty group: drag keys here or use Move to group'),
    newKeyInGroup: t('New key in this group'),
    moveUp: t('Move up'),
    moveDown: t('Move down'),
    groupMcpAllow: t('Allow MCP for the group'),
    groupMcpRemove: t('Remove MCP for the group'),
    deleteGroup: t('Delete group (keys kept)'),
    editLabel: t('Edit label'),
    removeSep: t('Remove'),
    moveToGroup: t('Move to group'),
    keysCount: t('{0} key(s)', '{0}'),
    mcpCount: t('{0} allowed for MCP', '{0}'),
    foldedAlert: t('A folded key is old or running out'),
    tagRequest: t('MCP access requested: waiting for your answer'),
    aiAuto: t('Automatic MCP access is on: the AI grants and removes access on its own.'),
    shownOf: t('{0} of {1} shown', '{0}', '{1}')
  };
}

function getHtml(T) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language || 'en')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: 12px;
         color: var(--vscode-foreground); padding: 0; margin: 0;
         display: flex; flex-direction: column;
         user-select: none; cursor: default; }
  #pane { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 6px 12px 10px; }
  .ok   { color: var(--vscode-charts-green); }
  .warn { color: var(--vscode-charts-yellow); }
  .crit { color: var(--vscode-charts-red); }
  .fill.ok   { background: var(--vscode-charts-green); }
  .fill.warn { background: var(--vscode-charts-yellow); }
  .fill.crit { background: var(--vscode-charts-red); }
  .row { margin-bottom: 8px; }
  .top { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .pct { font-weight: 600; }
  .bar { height: 4px; border-radius: 2px; overflow: hidden;
         background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
  .fill { height: 100%; border-radius: 2px; }
  .eta { opacity: .55; font-size: 11px; margin-top: 2px; }
  .warnmsg { color: var(--vscode-charts-yellow); margin: 4px 0 6px; font-size: 11px; }
  .pausemsg { color: var(--vscode-charts-yellow); opacity: .85; font-size: 10.5px;
              line-height: 1.4; margin: 2px 0 5px; }
  .at { opacity: .4; font-size: 10px; }
  .hint { opacity: .35; font-size: 10px; margin-top: 4px; }
  [hidden] { display: none !important; }
  /* --- ghost skeleton --- */
  .gh { display: inline-block; border-radius: 3px;
        background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
        animation: pulse 1.4s ease-in-out infinite; }
  .gfill { height: 100%; border-radius: 2px;
           background: color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
           animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .35; } 50% { opacity: .75; } }

  /* ---------- splitting the two halves ----------
     A single panel: quotas on top, secrets below. The section header reuses
     the vocabulary of VSCode's native sections (small, understated capitals)
     and carries the add action on the right, where the eye lands after
     reading the title. */
  /* No separator line: the spacing and the title's letter case are enough to
     break up the panel. A horizontal rule in a 250 px wide panel would just
     add noise without adding any real structure. */
  .sect { display: flex; align-items: center; gap: 8px; margin: 22px 0 10px; }
  .sect h2 { margin: 0; font-size: 10px; font-weight: 600; letter-spacing: .7px;
             text-transform: uppercase; opacity: .5; }
  .sect .cnt { font-size: 10px; opacity: .35; font-variant-numeric: tabular-nums; }
  .sect .dotw { width: 5px; height: 5px; border-radius: 50%;
                background: var(--vscode-charts-yellow); }
  .newkey { margin-left: auto; appearance: none; border: 0; border-radius: 3px; cursor: pointer;
            font-family: inherit; font-size: 14px; line-height: 1; padding: 2px 7px 4px;
            background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .newkey:hover { background: var(--vscode-button-hoverBackground); }
  .newkey:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  /* The whole row is a button: clicking it opens the key's action menu.
     Having to remember eight palette commands was the opposite of a companion. */
  .key { display: block; width: 100%; text-align: left; appearance: none; border: 0;
         background: none; color: inherit; font-family: inherit; cursor: pointer;
         padding: 5px 6px 6px; margin: 0 -6px 2px; border-radius: 3px; }
  .key:hover { background: var(--vscode-list-hoverBackground); }
  .key:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .kname { display: flex; align-items: baseline; gap: 5px;
           font-family: var(--vscode-editor-font-family, monospace);
           font-size: 11.5px; font-weight: 600; letter-spacing: -.2px;
           overflow: hidden; white-space: nowrap; }
  .kname span { overflow: hidden; text-overflow: ellipsis; }
  /* The NAME takes the free space, so everything after it — ageing dot, tags,
     chevron — sits on the right whatever the combination. Hanging the margin on
     one of the markers meant the layout depended on which markers happened to
     be present. */
  .kname > span:first-child { flex: 1 1 auto; min-width: 0; }
  .tag { flex: 0 0 auto; font-family: var(--vscode-font-family);
         font-size: 9px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase;
         padding: 0 4px; border-radius: 2px; opacity: .8;
         color: var(--vscode-charts-blue);
         border: 1px solid color-mix(in srgb, var(--vscode-charts-blue) 45%, transparent); }
  /* A guarded key is the one thing on this row worth a warm colour. */
  .tag.ask { color: var(--vscode-charts-yellow);
             border-color: color-mix(in srgb, var(--vscode-charts-yellow) 45%, transparent); }
  /* A published value is not an alert: grey, quieter than the MCP tag, which
     marks something the user granted rather than something a service publishes. */
  .tag.pub { color: var(--vscode-foreground); opacity: .45;
             border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  /* Ageing marker: a dot, not a badge. It informs, it does not scold. */
  .old { flex: 0 0 auto; font-style: normal; font-size: 13px; line-height: 0;
         color: var(--vscode-charts-yellow); opacity: .55; }
  .chev { flex: 0 0 auto; opacity: 0; font-size: 10px; }
  .key:hover .chev { opacity: .45; }
  .kmeta { opacity: .5; font-size: 10.5px; margin: 2px 0 4px;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* life bar: same .bar/.fill classes as the quotas, shared visual language */
  .seg { display: flex; gap: 2px; height: 4px; }
  .seg i { flex: 1 1 0; border-radius: 1px;
           background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
  .seg i.on { background: var(--vscode-charts-yellow); }
  /* ---------- search and sort tools ---------- */
  #stools { display: flex; gap: 6px; margin: 0 0 9px; }
  #stools input, #stools select { font-family: inherit; border-radius: 2px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); }
  #stools #ssearch { flex: 1 1 auto; min-width: 0; font-size: 11.5px; padding: 3px 8px; }
  #stools #ssort { flex: 0 0 auto; font-size: 11px; padding: 3px 4px; cursor: pointer; }
  #stools input:focus, #stools select:focus { outline: 1px solid var(--vscode-focusBorder); }
  /* ---------- groups and separators ----------
     Folders in a sidebar: a twisty, a name, counts on the right. Keys are never
     removed from the DOM when a group folds or a search filters them out: they
     are hidden by a class, so the index-based updates keep their alignment. */
  .key.khide { display: none; }
  .key[data-gid] { padding-left: 17px; }
  .ghead { display: flex; align-items: center; gap: 6px; margin: 8px -6px 2px; padding: 3px 6px;
           border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600; }
  .ghead:hover { background: var(--vscode-list-hoverBackground); }
  .ghead:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .ghead .gtw { flex: 0 0 auto; width: 9px; font-size: 10px; opacity: .6;
                display: inline-block; transition: transform .12s ease; transform: rotate(90deg); }
  .ghead.folded .gtw { transform: none; }
  .ghead .gname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ghead .gcnt { flex: 0 0 auto; font-size: 10px; font-weight: 400; opacity: .45;
                 font-variant-numeric: tabular-nums; }
  .ghead .gmcp { flex: 0 0 auto; font-size: 9px; font-weight: 600; letter-spacing: .4px;
                 text-transform: uppercase; color: var(--vscode-charts-blue); opacity: .75; }
  .ghead .gdot { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%;
                 background: var(--vscode-charts-yellow); }
  .ghead.gnone { cursor: default; opacity: .7; }
  .ghead.gnone:hover { background: none; }
  .gempty { font-size: 10.5px; opacity: .45; padding: 2px 0 6px 17px; line-height: 1.4; }
  .lsep { display: flex; align-items: center; gap: 7px; margin: 10px 0 6px; min-height: 9px;
          font-size: 9.5px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase;
          cursor: grab; }
  .lsep::before, .lsep::after { content: ''; flex: 1 1 auto; height: 1px;
          background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent); }
  .lsep span { flex: 0 1 auto; opacity: .5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lsep:empty::before { flex-basis: 100%; }
  .lsep:empty::after { display: none; }
  .lsep:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .aiauto { font-size: 10px; opacity: .6; margin: 0 0 8px; cursor: pointer; }
  .aiauto:hover { opacity: 1; text-decoration: underline; }
  .tag.req { color: var(--vscode-charts-orange);
             border-color: color-mix(in srgb, var(--vscode-charts-orange) 45%, transparent); }
  /* Drag and drop: the target lights up, a line shows where an item lands. */
  .dragging { opacity: .4; }
  .ghead.dropin, .gempty.dropin { background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent); }
  .dropbefore { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .dropafter { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  #fgrpnew { margin-top: -1px; }
  /* ---------- creation form, inside the panel ---------- */
  #form { margin-bottom: 12px; }
  #form input[type="text"], #form input[type="password"], #form select {
      width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12px;
      padding: 4px 7px; margin-bottom: 5px; border-radius: 2px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); }
  #form input#fnom { font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600; letter-spacing: -.2px; text-transform: uppercase; }
  #form input:focus, #form select:focus { outline: 1px solid var(--vscode-focusBorder); }
  #form input.faux { border-color: var(--vscode-charts-red); }
  .ferr { color: var(--vscode-charts-red); font-size: 10.5px; margin: -2px 0 5px; line-height: 1.35; }
  #fopts { margin: 2px 0 7px; padding-left: 1px; }
  #fopts label { display: block; font-size: 10.5px; opacity: .7; margin-bottom: 4px; }
  #fopts label.ligne { display: flex; align-items: center; gap: 5px; opacity: .8; }
  #fopts input[type="checkbox"] { margin: 0; }
  .fbtns { display: flex; align-items: center; gap: 10px; }
  .primaire { appearance: none; border: 0; border-radius: 2px; cursor: pointer;
      font-family: inherit; font-size: 12px; padding: 4px 14px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primaire:hover { background: var(--vscode-button-hoverBackground); }
  .primaire:disabled { opacity: .45; cursor: default; }
  .lien { appearance: none; border: 0; background: none; cursor: pointer; padding: 0;
      font-family: inherit; font-size: 11px; color: var(--vscode-textLink-foreground); }
  .lien:hover { text-decoration: underline; }
  .primaire:focus-visible, .lien:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

  .empty { opacity: .55; font-size: 11px; line-height: 1.5; margin-top: 2px; }
  .empty code { font-family: var(--vscode-editor-font-family, monospace); opacity: .85; }
  .notice { font-size: 10.5px; line-height: 1.45; padding: 6px 8px; margin-bottom: 10px;
            border-radius: 2px; border-left: 2px solid var(--vscode-charts-yellow);
            background: color-mix(in srgb, var(--vscode-charts-yellow) 9%, transparent); }
  .notice button { appearance: none; border: 0; background: none; cursor: pointer; padding: 0;
            margin-top: 3px; font-family: inherit; font-size: 10.5px; font-weight: 600;
            color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .notice.err { border-left-color: var(--vscode-charts-red);
            background: color-mix(in srgb, var(--vscode-charts-red) 9%, transparent); }
  /* Sits just above the log, outside the scroller so it cannot be scrolled past.
     Rounded and outlined rather than filled: it is an invitation, not an alarm —
     the vault works perfectly well without a phrase. Gone once one exists. */
  #reco { flex: 0 0 auto; margin: 0 10px 8px; padding: 9px 11px 10px;
          border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 40%, transparent);
          border-radius: 8px;
          background: color-mix(in srgb, var(--vscode-textLink-foreground) 7%, transparent); }
  #reco .rtitle { font-size: 11px; font-weight: 600; margin-bottom: 3px; }
  #reco .rbody { font-size: 10.5px; opacity: .7; line-height: 1.45; }
  #reco button { margin-top: 8px; appearance: none; border: 0; border-radius: 4px; cursor: pointer;
          font-family: inherit; font-size: 11px; padding: 4px 10px;
          background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #reco button:hover { background: var(--vscode-button-hoverBackground); }
  #reco button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  /* Pinned to the bottom edge, outside the scroller: the log and the connection
     state are always one click away, whether the vault holds forty keys or none.
     Appended to the key list, they sat wherever the list happened to end. */
  #foot { flex: 0 0 auto; display: flex; align-items: center; font-size: 10px;
            padding: 6px 12px 7px;
            border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 11%, transparent);
            background: var(--vscode-sideBar-background, transparent); }
  .foot button { appearance: none; border: 0; background: none; cursor: pointer; padding: 0;
            font-family: inherit; font-size: 10px; color: inherit; opacity: .55;
            text-decoration: underline; }
  .foot button:hover { opacity: 1; }
  .foot button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .foot .dot { margin: 0 6px; opacity: .35; }
  /* ---------- our own action dropdown, opened at the click ---------- */
  #kmenu { position: fixed; z-index: 1000; min-width: 226px; max-width: 320px;
           background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
           color: var(--vscode-menu-foreground, var(--vscode-foreground));
           border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
           border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, .4); padding: 5px; }
  #kmenu[hidden] { display: none; }
  #kmenu .mtitle { font-size: 10px; opacity: .55; letter-spacing: .4px; padding: 3px 9px 6px;
           font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
  #kmenu button { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
           appearance: none; border: 0; background: none; color: inherit; font-family: inherit;
           font-size: 12px; padding: 6px 9px; border-radius: 4px; cursor: pointer; }
  #kmenu button .mhint { margin-left: auto; opacity: .4; font-size: 10.5px;
           font-family: var(--vscode-editor-font-family, monospace); }
  #kmenu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
           color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, inherit)); }
  #kmenu button:hover .mhint { opacity: .7; }
  #kmenu button.danger { color: var(--vscode-errorForeground); }
  #kmenu button.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
           color: var(--vscode-errorForeground); }
  #kmenu .msep { height: 1px; margin: 5px 4px; background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent); }
  @media (prefers-reduced-motion: reduce) { .gh, .gfill { animation: none; } }
  /* Wide (the editor-tab view): two columns, quotas on the left, secrets on the
     right, with more breathing room. The narrow sidebar keeps the single
     stacked column. */
  @media (min-width: 640px) {
    /* Wide (the editor tab): one single column, capped and centred, never a
       two-column split. The content stays a comfortable width in the middle. */
    #pane { align-self: center; width: 100%; max-width: 620px; padding: 22px 26px 34px; }
  }
</style>
</head>
<body>
<div id="pane">
  ${require('./companion/quota-panel').html().replace('NONCE_PLACEHOLDER', 'nonce="' + nonce + '"')}
  <div id="quota"></div>
  <!-- The header and the form are STATIC: the panel gets redrawn on every
       refresh, and a rebuilt form would wipe out whatever is being typed
       into it. Only #quota and #secrets get remounted. -->
  <div id="vaultcol">
  <div class="sect">
    <h2>${esc(T.secrets)}</h2>
    <span class="cnt" id="cnt"></span>
    <span class="dotw" id="dotw" hidden></span>
    <button class="newkey" id="plus" title="${esc(T.newKey)}" aria-label="${esc(T.newKey)}">+</button>
  </div>
  <div id="stools" hidden>
    <input id="ssearch" type="search" placeholder="${esc(T.searchKeys)}" spellcheck="false" autocomplete="off">
    <select id="ssort" title="${esc(T.sortBy)}">
      <option value="recent">${esc(T.sortRecent)}</option>
      <option value="old">${esc(T.sortOldest)}</option>
      <option value="name">${esc(T.sortName)}</option>
    </select>
  </div>
  <div id="form" hidden>
    <input id="fnom" type="text" placeholder="${esc(T.keyName)}" spellcheck="false"
           autocomplete="off" autocapitalize="characters" maxlength="64">
    <div id="ferr" class="ferr" hidden></div>
    <input id="fval" type="password" placeholder="${esc(T.pasteValue)}" spellcheck="false"
           autocomplete="new-password">
    <select id="fgrp" title="${esc(T.group)}" aria-label="${esc(T.group)}">
      <option value="">${esc(T.noGroup)}</option>
      <option value="#new">${esc(T.newGroupDots)}</option>
    </select>
    <input id="fgrpnew" type="text" placeholder="${esc(T.groupNamePh)}" spellcheck="false"
           autocomplete="off" maxlength="40" hidden>
    <button id="fopt" class="lien" aria-expanded="false">${esc(T.options)}</button>
    <div id="fopts" hidden>
      <label>${esc(T.expiry)}
        <select id="fttl">
          <option value="0">${esc(T.none)}</option>
          <option value="300000">${esc(T.m5)}</option>
          <option value="3600000">${esc(T.h1)}</option>
          <option value="28800000">${esc(T.h8)}</option>
          <option value="86400000">${esc(T.h24)}</option>
          <option value="604800000">${esc(T.d7)}</option>
          <option value="burn">${esc(T.burnFirst)}</option>
        </select>
      </label>
      <label class="ligne"><input id="fmcp" type="checkbox"> ${esc(T.allowMcp)}</label>
    </div>
    <div class="fbtns">
      <button id="fok" class="primaire">${esc(T.create)}</button>
      <button id="fko" class="lien">${esc(T.cancel)}</button>
    </div>
  </div>
  <div id="secrets"></div>
  </div>
</div>
<div id="reco" hidden>
  <div class="rtitle">${esc(T.recoTitle)}</div>
  <div class="rbody">${esc(T.recoBody)}</div>
  <button data-act="recovery">${esc(T.recoBtn)}</button>
</div>
<div class="foot" id="foot">
  <button data-act="audit">${esc(T.auditLog)}</button>
  <span class="dot">·</span>
  <button data-act="settings">${esc(T.assistantSettings)}</button>
</div>
<div id="kmenu" hidden role="menu"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var api = acquireVsCodeApi();
  document.addEventListener('quota-action', function(e) { api.postMessage(e.detail); });
  // Translated once by the extension host and injected here: the webview has no
  // way to reach vscode.l10n itself.
  var T = ${JSON.stringify(T)};
  function fmt(s) {
    var a = Array.prototype.slice.call(arguments, 1);
    return String(s).replace(/\\{(\\d)\\}/g, function (_, i) { return a[i]; });
  }
  var root = document.getElementById('pane');
  var lastData = api.getState() || null;   // restores the display instantly
  var struct = '';                          // DOM structure currently mounted
  var refs = null;                          // references reused between two renders

  // A single delegated listener for the whole panel: buttons created during
  // mounting don't need to be rewired on every render.
  document.body.addEventListener('click', function (e) {
    // A group header folds or unfolds. It carries no data-act and no
    // data-name, so it can never be mistaken for a key.
    var gh = e.target.closest('.ghead[data-gid]');
    if (gh) { toggleGroup(gh.getAttribute('data-gid')); return; }
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var host = b.closest('[data-name]');
    var name = host ? host.getAttribute('data-name') : null;
    var act = b.getAttribute('data-act');
    // A key opens OUR dropdown at the click, not a message and not the top bar.
    if (act === 'actions' && name) { openMenu(name, e.clientX, e.clientY); return; }
    api.postMessage({ type: act, name: name });
  });
  // Right click on a key opens the same dropdown, at the cursor.
  root.addEventListener('contextmenu', function (e) {
    // Group headers and separators have their own menus, reachable from the
    // keyboard too: both are focusable, and the menu key fires this event.
    var gh = e.target.closest('.ghead[data-gid]');
    var sp = gh ? null : e.target.closest('.lsep[data-item]');
    if (gh || sp) {
      e.preventDefault();
      var rr = (gh || sp).getBoundingClientRect();
      var mx = e.clientX || rr.left + 12, my = e.clientY || rr.bottom;
      if (gh) openGroupMenu(gh.getAttribute('data-gid'), mx, my);
      else openSepMenu(sp.getAttribute('data-item'), mx, my);
      return;
    }
    var key = e.target.closest('.key[data-name]');
    if (key) {
      e.preventDefault();
      var r = key.getBoundingClientRect();
      openMenu(key.getAttribute('data-name'), e.clientX || r.left + 12, e.clientY || r.bottom);
      return;
    }
    // Anywhere else in the vault column. Fields keep the native menu: without
    // it there is no paste, and pasting is how a key value gets in.
    if (e.target.closest('input, select, textarea, #quota')) return;
    if (e.target !== root && !e.target.closest('#vaultcol')) return;
    e.preventDefault();
    openPaneMenu(e.clientX, e.clientY);
  });

  // ---- our action dropdown, positioned at the click and clamped to the view.
  var kmenu = document.getElementById('kmenu');
  function secretByName(n) {
    var v = lastData && lastData.vault;
    if (!v || !v.secrets) return null;
    for (var i = 0; i < v.secrets.length; i++) if (v.secrets[i].name === n) return v.secrets[i];
    return null;
  }
  function closeMenu() { kmenu.hidden = true; kmenu.innerHTML = ''; }

  // Both menus — a key's actions and the panel's own — share this renderer:
  // same look, same clamping, same keyboard exit.
  function showMenu(title, items, x, y, name, ctx) {
    var html = title ? '<div class="mtitle">' + esc(title) + '</div>' : '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.sep) { html += '<div class="msep"></div>'; continue; }
      html += '<button type="button" data-mact="' + esc(it.act) + '"' + (it.danger ? ' class="danger"' : '') + '>' +
              '<span>' + esc(it.label) + '</span>' +
              (it.hint ? '<span class="mhint">' + esc(it.hint) + '</span>' : '') + '</button>';
    }
    kmenu.innerHTML = html;
    kmenu.hidden = false;
    // Clamp to the viewport so it never spills off the edge.
    var w = kmenu.offsetWidth, h = kmenu.offsetHeight;
    kmenu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    kmenu.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    var first = kmenu.querySelector('button');
    if (first) first.focus();
    kmenu.__name = name || null;
    // What the menu is about (a key, a group, a separator), and where it was
    // opened, so a submenu can open in the same place.
    kmenu.__ctx = ctx || { kind: name ? 'key' : 'pane' };
    kmenu.__x = x; kmenu.__y = y;
  }

  // ---- the layout as the panel last received it
  function layoutOf() {
    var v = lastData && lastData.vault;
    return (v && v.layout) || [];
  }
  function itemOf(id) {
    var items = layoutOf();
    for (var i = 0; i < items.length; i++) if (items[i] && items[i].id === id) return items[i];
    return null;
  }
  function groupsList() {
    return layoutOf().filter(function (x) { return x && x.type === 'group'; });
  }

  // Folding shows at once; the host stores it in the layout so it survives a
  // refresh or a restart, and the next payload brings back the stored truth.
  function toggleGroup(id) {
    var g = itemOf(id);
    if (!g || g.type !== 'group') return;
    g.collapsed = !g.collapsed;
    applySearch();
    api.postMessage({ type: 'groupToggle', id: id });
  }
  function foldAll(on) {
    var gs = groupsList();
    for (var i = 0; i < gs.length; i++) gs[i].collapsed = !!on;
    applySearch();
    api.postMessage({ type: on ? 'collapseAll' : 'expandAll' });
  }

  function openGroupMenu(id, x, y) {
    var g = itemOf(id);
    if (!g) return;
    showMenu(g.name, [
      { act: '#newkeyin', label: T.newKeyInGroup, hint: '+' },
      { act: 'rename', label: T.actRename },
      { act: 'up', label: T.moveUp },
      { act: 'down', label: T.moveDown },
      { sep: true },
      { act: 'mcpAllow', label: T.groupMcpAllow },
      { act: 'mcpRemove', label: T.groupMcpRemove },
      { sep: true },
      { act: 'delete', label: T.deleteGroup, danger: true }
    ], x, y, null, { kind: 'group', id: id });
  }

  function openSepMenu(id, x, y) {
    var s = itemOf(id);
    if (!s) return;
    showMenu(s.label || T.separator, [
      { act: 'edit', label: T.editLabel },
      { act: 'up', label: T.moveUp },
      { act: 'down', label: T.moveDown },
      { sep: true },
      { act: 'remove', label: T.removeSep, danger: true }
    ], x, y, null, { kind: 'sep', id: id });
  }

  // Move to group: the existing groups, a new one, or none.
  function openMoveMenu(name, x, y) {
    var s = secretByName(name);
    var gs = groupsList(), items = [];
    for (var i = 0; i < gs.length; i++) {
      if (s && s.groupId === gs[i].id) continue;
      items.push({ act: 'g:' + gs[i].id, label: gs[i].name });
    }
    if (items.length) items.push({ sep: true });
    items.push({ act: '#new', label: T.newGroupDots });
    if (s && s.groupId) items.push({ act: '#none', label: T.noGroup });
    showMenu(T.moveToGroup + ' · ' + name, items, x, y, name, { kind: 'move', name: name });
  }

  function openMenu(name, x, y) {
    var s = secretByName(name);
    var marker = '{{vault' + (s && s.isFile ? '-file' : '') + ':' + name + '}}';
    var items = [
      { act: 'copy', label: T.actCopy, hint: marker },
      { act: 'info', label: T.actDetails },
      { act: 'rename', label: T.actRename, hint: name },
      { act: 'replace', label: T.actReplace },
      { act: 'ttl', label: T.actTtl },
      { act: 'public', label: (s && s.pub) ? T.actMarkSecret : T.actMarkPublic },
      { act: 'confirm', label: (s && s.confirm) ? T.actConfirmOff : T.actConfirmOn },
      { act: 'mcpserver', label: T.actMcpServer },
      { act: 'mcp', label: (s && s.mcp) ? T.actMcpRemove : T.actMcpAllow },
      { act: '#movekey', label: T.moveToGroup, hint: (s && s.group) || '' },
      { act: 'reveal', label: T.actReveal },
      { sep: true },
      { act: 'del', label: T.actDelete, danger: true }
    ];
    showMenu(name + (s ? ' · ' + s.kind : ''), items, x, y, name);
  }

  // Right click on the background: the panel offers what it can do. No title
  // above the list — the options say it themselves.
  function openPaneMenu(x, y) {
    showMenu(null, [
      { act: '#newkey', label: T.newKey, hint: '+' },
      { act: 'newGroup', label: T.newGroup },
      { act: 'newSeparator', label: T.newSeparator },
      { act: 'suggestGroups', label: T.suggestGroups },
      { act: '#collapseAll', label: T.collapseAll },
      { act: '#expandAll', label: T.expandAll },
      { sep: true },
      { act: 'terminal', label: T.vaultTerminal },
      { sep: true },
      { act: 'audit', label: T.auditLog },
      { act: 'settings', label: T.settings },
      { act: 'refresh', label: T.refreshNow }
    ], x, y, null);
  }

  kmenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-mact]');
    if (!b) return;
    var act = b.getAttribute('data-mact'), name = kmenu.__name;
    var ctx = kmenu.__ctx || {}, mx = kmenu.__x, my = kmenu.__y;
    closeMenu();
    // '#' prefix: handled here, in the panel, with no round trip to the host.
    if (act === '#newkey') { ouvrirForm(true); return; }
    if (act === '#newkeyin') { ouvrirForm(true, ctx.id); return; }
    if (act === '#movekey') { openMoveMenu(name, mx, my); return; }
    if (act === '#collapseAll') { foldAll(true); return; }
    if (act === '#expandAll') { foldAll(false); return; }
    if (ctx.kind === 'group') { api.postMessage({ type: 'groupMenuAct', act: act, id: ctx.id }); return; }
    if (ctx.kind === 'sep') { api.postMessage({ type: 'sepMenuAct', act: act, id: ctx.id }); return; }
    if (ctx.kind === 'move') {
      if (act === '#new') api.postMessage({ type: 'moveKeyNew', name: ctx.name });
      else if (act === '#none') api.postMessage({ type: 'moveKey', name: ctx.name, groupId: null });
      else if (act.indexOf('g:') === 0) api.postMessage({ type: 'moveKey', name: ctx.name, groupId: act.slice(2) });
      return;
    }
    api.postMessage({ type: act, name: name });
  });
  // Enter or Space on a focused group header folds it, like a click.
  root.addEventListener('keydown', function (e) {
    var gh = e.target.closest && e.target.closest('.ghead[data-gid]');
    if (gh && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleGroup(gh.getAttribute('data-gid')); }
  });
  document.addEventListener('click', function (e) {
    if (!kmenu.hidden && !kmenu.contains(e.target) && !e.target.closest('.key')) closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  root.addEventListener('scroll', closeMenu, true);
  window.addEventListener('blur', closeMenu);

  // ---- search and sort. Sorting reorders the data array itself, so the mount
  // signature changes and the list is rebuilt in order; search only hides rows,
  // which keeps the mounted references aligned with the data.
  var sortMode = 'recent';   // recent (default) | old | name
  var searchText = '';
  // Layout order first (the groups as they were placed, ungrouped keys last),
  // then the sort mode inside each group. The DOM is built from this array in
  // this order, which is what keeps refs.keys[i] the row of v.secrets[i].
  function sortSecrets(v) {
    if (!v || !v.secrets) return;
    var rank = {}, n = 0, items = v.layout || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === 'group') rank[items[i].id] = n++;
    }
    var rankOf = function (s) {
      return s.groupId && Object.prototype.hasOwnProperty.call(rank, s.groupId) ? rank[s.groupId] : n;
    };
    v.secrets.sort(function (a, b) {
      var ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      if (sortMode === 'name') return a.name.localeCompare(b.name);
      var ca = a.createdAt || 0, cb = b.createdAt || 0;
      return sortMode === 'old' ? ca - cb : cb - ca;   // recent first by default
    });
  }

  function runningOut(s) {
    if (s.maxUses) return Math.max(0, s.maxUses - s.uses) <= 1;
    var l = lifeOf(s);
    return !!(l && l.left < 600000);
  }

  // Visibility is decided here and only here. Folded groups and the search
  // both hide keys with a class, never by removing them, so the index-based
  // updates stay aligned. Search matches name, group and description; a folded
  // group opens for display only while the search finds something in it.
  function applySearch() {
    var v = lastData && lastData.vault;
    var box = document.getElementById('secrets');
    if (!v || !v.secrets || !box) return;
    var q = searchText.trim().toLowerCase();
    var keys = box.querySelectorAll('.key');
    var folded = {}, items = v.layout || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === 'group') folded[items[i].id] = !!items[i].collapsed;
    }
    var st = {}, shown = 0;
    for (var k = 0; k < v.secrets.length && k < keys.length; k++) {
      var s = v.secrets[k];
      var gid = s.groupId && Object.prototype.hasOwnProperty.call(folded, s.groupId) ? s.groupId : '';
      var hit = !q || s.name.toLowerCase().indexOf(q) !== -1 ||
        (!!s.group && String(s.group).toLowerCase().indexOf(q) !== -1) ||
        (!!s.note && String(s.note).toLowerCase().indexOf(q) !== -1);
      var g = st[gid] || (st[gid] = { n: 0, mcp: 0, hit: 0, alert: 0 });
      g.n++;
      if (s.mcp) g.mcp++;
      if (hit) { g.hit++; shown++; }
      if (staleOf(s) || runningOut(s)) g.alert++;
      var hide = !hit || (!q && !!folded[gid]);
      if (keys[k].classList.contains('khide') !== hide) keys[k].classList.toggle('khide', hide);
    }
    var heads = box.querySelectorAll('.ghead');
    for (var h = 0; h < heads.length; h++) {
      var id = heads[h].getAttribute('data-gid') || '';
      var gs = st[id] || { n: 0, mcp: 0, hit: 0, alert: 0 };
      var isFold = !!folded[id] && !(q && gs.hit);
      if (heads[h].classList.contains('folded') !== isFold) heads[h].classList.toggle('folded', isFold);
      if (id) heads[h].setAttribute('aria-expanded', isFold ? 'false' : 'true');
      heads[h].hidden = !!q && !gs.hit;
      var c = heads[h].querySelector('.gcnt');
      if (c) { setText(c, String(gs.n)); c.title = fmt(T.keysCount, gs.n); }
      var m = heads[h].querySelector('.gmcp');
      if (m) { setText(m, gs.mcp ? gs.mcp + ' mcp' : ''); m.hidden = !gs.mcp; m.title = fmt(T.mcpCount, gs.mcp); }
      var d = heads[h].querySelector('.gdot');
      if (d) { d.hidden = !(folded[id] && !q && gs.alert); d.title = T.foldedAlert; }
    }
    // Separators and empty groups say nothing about a search result, and the
    // notice of an empty group folds away with its group like any key would.
    var quiet = box.querySelectorAll('.lsep, .gempty');
    for (var j = 0; j < quiet.length; j++) {
      var qg = quiet[j].classList.contains('gempty') ? quiet[j].getAttribute('data-gid') : '';
      quiet[j].hidden = !!q || (!!qg && !!folded[qg]);
    }
    var cnt = document.getElementById('cnt');
    if (cnt) {
      setText(cnt, !v.secrets.length ? '' : (q ? shown + '/' + v.secrets.length : String(v.secrets.length)));
      cnt.title = q ? fmt(T.shownOf, shown, v.secrets.length) : '';
    }
  }

  // ---- drag and drop. Keys go into groups; groups and separators move among
  // themselves. The panel only says what was dropped where: the host checks
  // it, and the next payload redraws the list in its new order.
  var drag = null;
  var secretsBox = document.getElementById('secrets');
  function cssId(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }
  function clearMarks() {
    var marked = secretsBox.querySelectorAll('.dropin, .dropbefore, .dropafter');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('dropin', 'dropbefore', 'dropafter');
  }
  function clearDrag() {
    clearMarks();
    var d = secretsBox.querySelectorAll('.dragging');
    for (var i = 0; i < d.length; i++) d[i].classList.remove('dragging');
  }
  function headOf(gid) {
    return gid ? secretsBox.querySelector('.ghead[data-gid="' + cssId(gid) + '"]')
               : secretsBox.querySelector('.ghead.gnone');
  }
  // A key dropped on a header, an empty-group notice or another key lands in
  // that group; the "Ungrouped" header takes it out of any group.
  function keyTarget(el) {
    var t = el && el.closest ? el.closest('.ghead, .gempty, .key') : null;
    if (!t || !secretsBox.contains(t)) return null;
    if (t.classList.contains('gnone')) return { gid: null, el: t };
    var gid = t.getAttribute('data-gid') || null;
    if (t.classList.contains('key')) {
      var head = headOf(gid);
      if (!head) return null;
      return { gid: gid, el: head };
    }
    return { gid: gid, el: t };
  }
  // A group or separator lands before or after the item under the pointer.
  // Over a group's keys it lands after that group; over the ungrouped part,
  // at the end of the layout.
  function itemTarget(el, y) {
    var t = el && el.closest ? el.closest('.ghead, .lsep, .gempty, .key') : null;
    if (!t || !secretsBox.contains(t)) return null;
    if (t.classList.contains('gnone')) return { id: null, before: true, el: t };
    if (t.classList.contains('key') || t.classList.contains('gempty')) {
      var gid = t.getAttribute('data-gid');
      if (!gid) { var none = headOf(null); return none ? { id: null, before: true, el: none } : null; }
      var rows = secretsBox.querySelectorAll('.key[data-gid="' + cssId(gid) + '"], .gempty[data-gid="' + cssId(gid) + '"]');
      return { id: gid, before: false, el: rows.length ? rows[rows.length - 1] : t };
    }
    var r = t.getBoundingClientRect();
    return { id: t.getAttribute('data-item'), before: y < r.top + r.height / 2, el: t };
  }
  function targetOf(e) {
    return drag.kind === 'key' ? keyTarget(e.target) : itemTarget(e.target, e.clientY);
  }
  secretsBox.addEventListener('dragstart', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.key, .ghead[data-item], .lsep[data-item]') : null;
    if (!el) return;
    // A flat list has nowhere to drop; a filtered list hides the separators.
    if (!layoutOf().length || (!el.classList.contains('key') && searchText.trim())) { e.preventDefault(); return; }
    drag = el.classList.contains('key')
      ? { kind: 'key', name: el.getAttribute('data-name'), gid: el.getAttribute('data-gid') || null }
      : { kind: 'item', id: el.getAttribute('data-item') };
    el.classList.add('dragging');
    closeMenu();
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.name || drag.id);
    } catch (x) { /* some hosts refuse custom data: the drag still works */ }
  });
  secretsBox.addEventListener('dragover', function (e) {
    if (!drag) return;
    var tgt = targetOf(e);
    clearMarks();
    if (!tgt) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (x) { /* read-only in some hosts */ }
    tgt.el.classList.add(drag.kind === 'key' ? 'dropin' : (tgt.before ? 'dropbefore' : 'dropafter'));
  });
  secretsBox.addEventListener('drop', function (e) {
    if (!drag) return;
    e.preventDefault();
    var d = drag, tgt = targetOf(e);
    drag = null;
    clearDrag();
    if (!tgt) return;
    if (d.kind === 'key') {
      if ((tgt.gid || null) !== (d.gid || null)) {
        api.postMessage({ type: 'moveKey', name: d.name, groupId: tgt.gid || null });
      }
      return;
    }
    var ids = layoutOf().map(function (x) { return x.id; });
    var from = ids.indexOf(d.id);
    if (from < 0) return;
    var at = tgt.id ? ids.indexOf(tgt.id) + (tgt.before ? 0 : 1) : ids.length;
    if (at < 0) return;
    if (from < at) at--;                 // the item leaves its old slot first
    if (at !== from) api.postMessage({ type: 'moveItem', id: d.id, toIndex: at });
  });
  document.addEventListener('dragend', function () { drag = null; clearDrag(); });
  var searchEl = document.getElementById('ssearch');
  var sortEl = document.getElementById('ssort');
  if (searchEl) searchEl.addEventListener('input', function () { searchText = searchEl.value; applySearch(); });
  if (sortEl) sortEl.addEventListener('change', function () {
    sortMode = sortEl.value;
    if (lastData && lastData.vault) { sortSecrets(lastData.vault); struct = ''; render(); }
  });

  // ---------------------------------------------------------------- form
  //
  // A secret's value passes through the webview's DOM here, something the
  // native input box avoided. Three rules make up for it: the field is of
  // type password, it is never stored in the webview's state (api.setState
  // only ever receives the payload coming from the extension), and it is
  // cleared as soon as it's sent.

  var form = document.getElementById('form');
  var fnom = document.getElementById('fnom');
  var fval = document.getElementById('fval');
  var ferr = document.getElementById('ferr');
  var fopts = document.getElementById('fopts');
  var fttl = document.getElementById('fttl');
  var fmcp = document.getElementById('fmcp');
  var fok = document.getElementById('fok');
  var fgrp = document.getElementById('fgrp');
  var fgrpnew = document.getElementById('fgrpnew');
  var defaults = null;               // sent by the extension along with the payload
  var groupsSig = null;

  // The group selector is part of the static form, so it is refilled in place
  // when the groups change, keeping whatever was selected.
  function fillGroups() {
    var gs = groupsList();
    var sig = gs.map(function (g) { return g.id + ':' + g.name; }).join('|');
    if (sig === groupsSig) return;
    groupsSig = sig;
    var keep = fgrp.value;
    var h = '<option value="">' + esc(T.noGroup) + '</option>';
    for (var i = 0; i < gs.length; i++) h += '<option value="' + esc(gs[i].id) + '">' + esc(gs[i].name) + '</option>';
    h += '<option value="#new">' + esc(T.newGroupDots) + '</option>';
    fgrp.innerHTML = h;
    fgrp.value = keep;
    if (fgrp.value !== keep) fgrp.value = '';
    syncGroupInput();
  }
  function syncGroupInput() { fgrpnew.hidden = fgrp.value !== '#new'; }

  function nomValide(n) {
    if (!n) return { msg: T.nameRequired, dur: true };
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(n)) return { msg: T.nameRule, dur: true };
    var v = lastData && lastData.vault;
    if (v && v.secrets.some(function (s) { return s.name === n; })) {
      // a warning, not a refusal: replacing a key is a legitimate thing to do
      return { msg: fmt(T.exists, n), dur: false };
    }
    return null;
  }

  function verifier() {
    var n = fnom.value.toUpperCase();
    var r = n ? nomValide(n) : null;
    var msg = r ? r.msg : '';
    var bloquant = !!(r && r.dur);
    setText(ferr, msg || '');
    ferr.hidden = !msg;
    fnom.classList.toggle('faux', bloquant);
    fok.disabled = !n || bloquant || !fval.value ||
      (fgrp.value === '#new' && !fgrpnew.value.trim());
  }

  // gid: open the form already pointing at that group ("New key in this group").
  function ouvrirForm(ouvrir, gid) {
    form.hidden = !ouvrir;
    if (!ouvrir) { fnom.value = ''; fval.value = ''; fgrpnew.value = ''; verifier(); return; }
    fillGroups();
    fgrp.value = gid || '';
    if (fgrp.value !== (gid || '')) fgrp.value = '';
    syncGroupInput();
    if (defaults) {
      fttl.value = defaults.burn ? 'burn' : String(defaults.ttlMs || 0);
      fmcp.checked = !!defaults.mcp;
    }
    verifier();
    fnom.focus();
  }

  function envoyer() {
    var n = fnom.value.toUpperCase();
    if (fok.disabled || !n || !fval.value) return;
    api.postMessage({
      type: 'create', name: n, value: fval.value,
      ttlMs: fttl.value === 'burn' ? 0 : Number(fttl.value),
      burn: fttl.value === 'burn',
      mcp: !!fmcp.checked,
      groupId: fgrp.value && fgrp.value !== '#new' ? fgrp.value : null,
      groupName: fgrp.value === '#new' ? fgrpnew.value.trim() : null
    });
    fval.value = '';               // the value doesn't stick around a millisecond longer
    fnom.value = '';
    ouvrirForm(false);
  }

  document.getElementById('plus').addEventListener('click', function () {
    ouvrirForm(form.hidden);
  });
  document.getElementById('fopt').addEventListener('click', function (e) {
    fopts.hidden = !fopts.hidden;
    e.currentTarget.setAttribute('aria-expanded', fopts.hidden ? 'false' : 'true');
  });
  document.getElementById('fko').addEventListener('click', function () { ouvrirForm(false); });
  fok.addEventListener('click', envoyer);
  fnom.addEventListener('input', verifier);
  fval.addEventListener('input', verifier);
  fgrpnew.addEventListener('input', verifier);
  fgrp.addEventListener('change', function () {
    syncGroupInput();
    verifier();
    if (!fgrpnew.hidden) fgrpnew.focus();
  });
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter in the group fields chooses a group; it does not create the key.
      if (e.target === fgrp || e.target === fgrpnew) return;
      envoyer();
    }
    else if (e.key === 'Escape') { e.preventDefault(); ouvrirForm(false); }
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function etaText(at) {
    if (!at) return '';
    var s = Math.floor((at - Date.now()) / 1000);
    if (s <= 0) return T.resetsSoon;
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 24) return fmt(T.resetsD, Math.floor(h / 24), ('0' + (h % 24)).slice(-2));
    return fmt(T.resetsH, h, ('0' + m).slice(-2));
  }

  function skeleton() {
    var s = '', labels = [T.session5h, T.week], widths = [45, 28];
    for (var i = 0; i < labels.length; i++) {
      s += '<div class="row"><div class="top"><span>' + labels[i] +
           '</span><span class="gh" style="width:28px;height:11px"></span></div>' +
           '<div class="bar"><div class="gfill" style="width:' + widths[i] + '%"></div></div>' +
           '<div class="eta"><span class="gh" style="width:72px;height:8px"></span></div></div>';
    }
    return s;
  }

  // --- secrets: remaining time and alert level, computed locally from
  // absolute timestamps. No drift between two payloads from the extension.

  function fmtLeft(ms) {
    if (ms <= 0) return T.expired;
    var m = Math.floor(ms / 60000);
    if (m < 1) return T.underMinute;
    if (m < 60) return fmt(T.min, m);
    var h = Math.floor(m / 60);
    if (h < 24) return fmt(T.hm, h, ('0' + (m % 60)).slice(-2));
    return fmt(T.dh, Math.floor(h / 24), h % 24);
  }

  function lifeOf(s) {
    if (!s.expiresAt) return null;
    var now = Date.now();
    var span = s.expiresAt - (s.createdAt || 0);
    return {
      left: s.expiresAt - now,
      frac: span > 0 ? Math.max(0, Math.min(1, (s.expiresAt - now) / span)) : 0
    };
  }

  function levelOfLife(f) { return f > 0.35 ? 'ok' : (f > 0.12 ? 'warn' : 'crit'); }

  // A projection lands at a moment, so it reads as a clock time. Beyond today
  // the hour alone would be ambiguous, so the date joins it.
  function clockOf(ts) {
    var d = new Date(ts);
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var now = new Date();
    if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth()) return hm;
    return String(d.getDate()).padStart(2, '0') + '/' +
           String(d.getMonth() + 1).padStart(2, '0') + ' ' + hm;
  }

  // Rounded to the unit that carries meaning at that distance: nobody needs
  // "il y a 47 jours", they need "il y a 2 mois".
  function agoText(ts) {
    var d = Date.now() - ts;
    if (d < 3600000) return T.agoNow;
    if (d < 86400000) return fmt(T.agoHours, Math.round(d / 3600000));
    if (d < 2592000000) return fmt(T.agoDays, Math.round(d / 86400000));
    if (d < 31536000000) return fmt(T.agoMonths, Math.max(1, Math.round(d / 2592000000)));
    return fmt(T.agoYears, Math.max(1, Math.round(d / 31536000000)));
  }

  // Never used and old enough to have been: worth saying so plainly. A key
  // sitting unused for months is either forgotten or already dead upstream —
  // and finding that out from a 401 in production is the expensive way.
  var STALE_MS = 15552000000;                   // six months

  function usageText(s) {
    if (s.lastUsedAt) return fmt(T.usedAgo, agoText(s.lastUsedAt));
    if (s.createdAt && Date.now() - s.createdAt > 604800000) return T.neverUsed;
    return null;
  }

  function metaOf(s) {
    var head;
    if (s.maxUses) {
      var left = Math.max(0, s.maxUses - s.uses);
      head = s.kind + ' · ' + (left <= 1 ? T.burnsNext : fmt(T.usesLeft, left));
    } else {
      var l = lifeOf(s);
      head = s.kind + ' · ' + (l ? fmtLeft(l.left) : T.neverExpires);
    }
    if (s.mcp) head += ' · MCP';
    var use = usageText(s);
    if (use) head += ' · ' + use;
    return head;
  }

  // Old and untouched: a discreet marker, no colour, no alarm. Rotating is a
  // decision, not an emergency.
  function staleOf(s) {
    if (!s.createdAt || Date.now() - s.createdAt < STALE_MS) return null;
    var since = s.lastUsedAt || s.createdAt;
    if (Date.now() - since < STALE_MS) return null;
    return fmt(T.staleHint, agoText(s.createdAt));
  }

  // Structure signature: as long as it doesn't change, we update the DOM in
  // place (textContent / style.width) instead of rebuilding it.
  // Covers BOTH halves of the panel: an added key or a quota row appearing
  // must both trigger a remount.
  function structOf(d) {
    if (!d) return 'boot';
    var k = d.rows.length ? 'q:' : 'q0:' + (d.error ? 1 : 0) + ':';
    for (var i = 0; i < d.rows.length; i++) k += d.rows[i].short + ',';
    var v = d.vault || { secrets: [] };
    if(d.companion) k += '|assistant:' + d.companion.providers.join(',') + ':' + d.companion.setupReady;
    k += '|s:' + (v.connected ? 1 : 0) + (v.needsUpdate ? 1 : 0) +
         (v.recovery ? 1 : 0) + ':' + (v.issues || []).length + ':';
    var pend = {}, pl = v.pending || [];
    for (var p = 0; p < pl.length; p++) pend[pl[p]] = 1;
    for (var j = 0; j < v.secrets.length; j++) {
      k += v.secrets[j].name + (v.secrets[j].maxUses ? '#' : (v.secrets[j].expiresAt ? '@' : '-')) +
           (v.secrets[j].mcp ? '+' + (v.secrets[j].mcpServers || []).join('+') : '') +
           (v.secrets[j].pub ? 'P' : '') +
           (v.secrets[j].confirm ? 'C' : '') +
           (pend[v.secrets[j].name] ? 'R' : '') +
           '/' + (v.secrets[j].groupId || '') +
           (staleOf(v.secrets[j]) ? '!' : '') + ',';
    }
    // The layout's shape, not its folded state: folding only toggles classes,
    // it never needs a remount.
    var items = v.layout || [];
    k += '|L:';
    for (var l = 0; l < items.length; l++) {
      if (items[l]) k += (items[l].type === 'group' ? 'g' : 's') + items[l].id + '=' + (items[l].name || items[l].label || '') + ';';
    }
    k += '|A:' + (v.policy && v.policy.auto ? 1 : 0);
    return k;
  }

  // The mounting functions RETURN HTML instead of writing into the panel:
  // both halves are assembled in a single pass by mountAll().
  // One row markup for both providers: label, percentage, bar, reset line.
  // The ChatGPT block is drawn and updated by these very functions, so the two
  // blocks can only ever differ by the colour their container gives them.
  function rowsHtml(rows) {
    var h = '';
    for (var i = 0; i < rows.length; i++) {
      h += '<div class="row"' + (rows[i].title ? ' title="' + esc(rows[i].title) + '"' : '') +
           '><div class="top"><span>' + esc(rows[i].label) +
           '</span><span class="pct"></span></div>' +
           '<div class="bar" role="progressbar" aria-label="' + esc(rows[i].label) +
           '" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div>' +
           '<div class="eta"></div></div>';
    }
    return h;
  }

  function htmlFull(rows) {
    return rowsHtml(rows) + '<div id="cred"></div><div class="warnmsg" hidden></div>' +
           '<div class="pausemsg" hidden></div><div class="at"></div>';
  }

  // Taken right after mounting, before anything else (the credits row) lands
  // in the block with the same classes.
  function rowRefs(el) {
    return {
      row: el.querySelectorAll('.row'),
      pct: el.querySelectorAll('.pct'),
      bar: el.querySelectorAll('.bar'),
      fill: el.querySelectorAll('.fill'),
      eta: el.querySelectorAll('.eta')
    };
  }

  // Same percentage, level classes, countdown and projection for every row,
  // whoever the provider. A row that names a colour (ChatGPT's own palette,
  // custom setting included) gets it through --quota-color; the rest of the
  // look is shared.
  function paintRows(rf, rows) {
    for (var i = 0; i < rows.length; i++) {
      if (!rf.pct[i] || !rf.fill[i]) continue;
      var r = rows[i], p = Math.round(r.pct);
      setText(rf.pct[i], p + '%');
      setClass(rf.pct[i], 'pct ' + r.level);
      setClass(rf.fill[i], 'fill ' + r.level);
      var w = Math.max(0, Math.min(r.pct, 100)) + '%';
      if (rf.fill[i].style.width !== w) rf.fill[i].style.width = w;
      rf.bar[i].setAttribute('aria-valuenow', p);
      setText(rf.eta[i], etaText(r.resetAt) +
        (r.hitsAt ? ' · ' + fmt(T.hitsAt, clockOf(r.hitsAt)) : ''));
      var col = /^[a-z]+(\\.[a-z]+)?$/i.test(r.color || '')
        ? 'var(--vscode-' + r.color.replace('.', '-') + ')' : '';
      if (rf.row[i] && rf.row[i].style.getPropertyValue('--quota-color') !== col) {
        if (col) rf.row[i].style.setProperty('--quota-color', col);
        else rf.row[i].style.removeProperty('--quota-color');
      }
    }
  }

  function footText(b) {
    if (!b.at) return '';
    return b.pause ? fmt(T.updatedPaused, b.at)
      : (b.next ? fmt(T.updatedNext, b.at, b.next) : fmt(T.updated, b.at));
  }

  // The ChatGPT block: the same skeleton while loading, the same rows, the
  // same warning line and the same footer as the Claude block. Its own
  // structure signature, so a Claude refresh never remounts it.
  var cstruct = '', crefs = null;
  function codexRowsOf(c) {
    if (c.rows) return c.rows;
    // An older host sends raw quotas only: shape them minimally rather than
    // leave the block empty.
    return (c.quotas || []).map(function (q) {
      return { label: q.label, short: q.id, pct: q.pct, resetAt: q.resetAt, color: q.color,
               level: q.level || (q.pct >= 90 ? 'crit' : (q.pct >= 70 ? 'warn' : 'ok')) };
    });
  }
  function renderCodex(c) {
    var box = document.getElementById('codex-rows');
    if (!box) return;
    if (!c || !c.providers || c.providers.indexOf('codex') < 0) {
      if (cstruct) { box.innerHTML = ''; cstruct = ''; crefs = null; }
      return;
    }
    var rows = codexRowsOf(c);
    var err = c.error || c.setupError || '';
    var loading = c.busy || !c.updated;
    var k = rows.length ? 'q:' : 'q0:' + (err ? 1 : 0) + (loading ? 'l' : 'e') + ':';
    for (var i = 0; i < rows.length; i++) k += rows[i].short + '=' + rows[i].label + '=' + (rows[i].title || '') + ',';
    if (k !== cstruct) {
      cstruct = k;
      box.innerHTML = rows.length
        ? rowsHtml(rows) + '<div class="warnmsg" hidden></div><div class="at"></div>'
        : (err || loading ? skeleton() : '') +
          (err ? '<div class="warnmsg"></div>'
               : '<div class="hint">' + esc(loading ? T.loading : T.codexEmpty) + '</div>');
      crefs = rowRefs(box);
      crefs.err = box.querySelector('.warnmsg');
      crefs.at = box.querySelector('.at');
    }
    if (rows.length) paintRows(crefs, rows);
    if (crefs.err) {
      crefs.err.hidden = !err;
      if (err) setText(crefs.err, '⚠ ' + err);
    }
    if (crefs.at) setText(crefs.at, footText(c));
  }

  function htmlSecrets(v) {
    var h = '';
    var companion = lastData && lastData.companion;
    if(companion && companion.providers.indexOf('codex')>=0) {
      h += companion.setupReady ? '<div class="hint">ChatGPT / Codex · MCP</div>'
        : '<div class="notice"><button data-act="connectCodex">'+esc(T.connectCodex)+'</button></div>';
    }
    for (var i = 0; i < (v.issues || []).length; i++) {
      h += '<div class="notice' + (v.issues[i].level === 'error' ? ' err' : '') + '">' +
           esc(v.issues[i].msg) + '</div>';
    }
    if (!v.connected && (!companion || companion.providers.indexOf('claude')>=0)) {
      h += '<div class="notice">' +
           esc(v.needsUpdate ? T.connOutdated : T.notConnected) +
           '<br><button data-act="connect">' +
           esc(v.needsUpdate ? T.updateConn : T.connect) +
           '</button></div>';
    }
    // Automatic MCP access is a choice worth seeing while it is on: one quiet
    // line, a click away from the setting that turns it off.
    if (v.policy && v.policy.auto) {
      h += '<div class="aiauto" data-act="settings">' + esc(T.aiAuto) + '</div>';
    }
    var items = v.layout || [];
    if (!v.secrets.length && !items.length) {
      return h + '<div class="empty">' + esc(T.noKeys) + '<br>' + esc(T.noKeysHint) + '</div>';
    }
    var pend = {}, pl = v.pending || [];
    for (var p = 0; p < pl.length; p++) pend[pl[p]] = 1;

    // No layout yet: today's flat list.
    if (!items.length) {
      for (var k = 0; k < v.secrets.length; k++) h += keyHtml(v.secrets[k], pend);
      return h;
    }

    // The layout in order: groups with their keys, separators where they were
    // put, then the ungrouped keys. v.secrets is already sorted the same way,
    // so the .key elements come out in exactly the array's order. Headers and
    // separators never carry class key, kmeta or data-name.
    var known = {}, hasGroup = false;
    for (var i2 = 0; i2 < items.length; i2++) {
      if (items[i2] && items[i2].type === 'group') { known[items[i2].id] = 1; hasGroup = true; }
    }
    var byGroup = {};
    for (var j = 0; j < v.secrets.length; j++) {
      var gid = v.secrets[j].groupId && known[v.secrets[j].groupId] ? v.secrets[j].groupId : '';
      (byGroup[gid] = byGroup[gid] || []).push(v.secrets[j]);
    }
    for (var a = 0; a < items.length; a++) {
      var it = items[a];
      if (!it) continue;
      if (it.type === 'separator') {
        h += '<div class="lsep" data-item="' + esc(it.id) + '" draggable="true" tabindex="0" role="separator"' +
             ' title="' + esc(it.label || T.separator) + '">' +
             (it.label ? '<span>' + esc(it.label) + '</span>' : '') + '</div>';
        continue;
      }
      if (it.type !== 'group') continue;
      var ks = byGroup[it.id] || [];
      h += '<div class="ghead" data-gid="' + esc(it.id) + '" data-item="' + esc(it.id) +
           '" draggable="true" tabindex="0" role="button" aria-expanded="true">' +
           '<span class="gtw">›</span><span class="gname">' + esc(it.name) + '</span>' +
           '<span class="gmcp" hidden></span><span class="gcnt"></span><i class="gdot" hidden></i></div>';
      if (!ks.length) h += '<div class="gempty" data-gid="' + esc(it.id) + '">' + esc(T.groupEmpty) + '</div>';
      for (var b = 0; b < ks.length; b++) h += keyHtml(ks[b], pend);
    }
    var loose = byGroup[''] || [];
    // Not a layout item: not foldable, not movable, but a drop target that
    // takes a key out of its group.
    if (hasGroup) {
      h += '<div class="ghead gnone"><span class="gtw"></span><span class="gname">' + esc(T.ungrouped) +
           '</span><span class="gcnt"></span></div>';
    }
    for (var c = 0; c < loose.length; c++) h += keyHtml(loose[c], pend);
    return h;
  }

  function keyHtml(s, pend) {
    // Left click AND right click open OUR action menu (a translated quick
    // pick), not the native VS Code context menu: that one is resolved from
    // package.nls by VS Code's own display language, so it ignored the panel's
    // language setting and always showed English. Ours follows the setting.
    var h = '<button class="key" data-act="actions" data-name="' + esc(s.name) + '"' +
           (s.groupId ? ' data-gid="' + esc(s.groupId) + '"' : '') + ' draggable="true" title="' +
             esc(s.kind + ' · ' + s.hint + ' · ' + fmt(T.chars, s.length) +
                 (s.group ? ' · ' + s.group : '') + ' · ' + T.rowHint) + '">' +
           '<div class="kname"><span>' + esc(s.name) + '</span>' +
             (staleOf(s) ? '<em class="old" title="' + esc(staleOf(s)) + '">•</em>' : '') +
             (pend && pend[s.name] ? '<em class="tag req" title="' + esc(T.tagRequest) + '">req</em>' : '') +
             (s.pub ? '<em class="tag pub" title="' + esc(T.tagPublic) + '">pub</em>' : '') +
             (s.confirm ? '<em class="tag ask" title="' + esc(T.tagConfirm) + '">ask</em>' : '') +
             (s.mcp ? '<em class="tag"' + (s.mcpServers && s.mcpServers.length
               ? ' title="' + esc(s.mcpServers.join(', ')) + '"' : '') + '>mcp</em>' : '') +
             '<span class="chev">›</span>' +
           '</div>' +
           '<div class="kmeta"></div>';
    if (s.maxUses) {
      // Finite in uses, not in time: discrete segments, not a continuous bar.
      var n = Math.min(s.maxUses, 8);
      h += '<div class="seg">';
      for (var u = 0; u < n; u++) h += '<i></i>';
      h += '</div>';
    } else if (s.expiresAt) {
      h += '<div class="bar"><div class="fill"></div></div>';
    }
    // With no expiry and no use counter: no bar at all. The absence is the signal.
    return h + '</button>';
  }

  // The header is static: we only ever update the counter and the alert dot
  // in it, never rebuild it.
  function updateSection(v) {
    var cnt = document.getElementById('cnt');
    var dot = document.getElementById('dotw');
    // Nothing to back up while the vault is empty, and nothing to offer once
    // a phrase exists: the box only shows where it would actually help.
    var reco = document.getElementById('reco');
    if (reco) reco.hidden = !v || !v.secrets.length || v.recovery !== false;
    if (!v) { cnt.textContent = ''; dot.hidden = true; return; }
    var soon = 0;
    for (var i = 0; i < v.secrets.length; i++) {
      var s = v.secrets[i];
      if (s.maxUses) { soon++; continue; }
      var l = lifeOf(s);
      if (l && l.left < 600000) soon++;
    }
    setText(cnt, v.secrets.length ? String(v.secrets.length) : '');
    dot.hidden = !soon;
    if (soon) dot.title = fmt(T.runningOut, soon);
  }

  function updateSecrets(v) {
    if (!refs || !refs.meta) return;
    for (var i = 0; i < v.secrets.length; i++) {
      var s = v.secrets[i];
      if (!refs.meta[i]) continue;
      setText(refs.meta[i], metaOf(s));
      var host = refs.keys[i];
      if (s.maxUses) {
        var segs = host.querySelectorAll('.seg i');
        var left = Math.max(0, s.maxUses - s.uses);
        for (var j = 0; j < segs.length; j++) {
          var on = j < left;
          if (segs[j].classList.contains('on') !== on) segs[j].classList.toggle('on', on);
        }
      } else if (s.expiresAt) {
        var life = lifeOf(s);
        var fill = host.querySelector('.fill');
        if (fill) {
          setClass(fill, 'fill ' + levelOfLife(life.frac));
          var w = (life.frac * 100).toFixed(1) + '%';
          if (fill.style.width !== w) fill.style.width = w;
        }
      }
    }
  }

  function setText(el, txt) { if (el.textContent !== txt) el.textContent = txt; }
  function setClass(el, cls) { if (el.className !== cls) el.className = cls; }

  function money(v, currency) {
    if (v == null) return '';
    try { return v.toLocaleString(undefined, { style: 'currency', currency: currency || 'USD' }); }
    catch (e) { return v.toFixed(2) + ' ' + (currency || 'USD'); }
  }

  // Paid credits: only show up if the option is enabled on the Claude account.
  // One more row when it serves no purpose is just noise.
  function updateCredits(c) {
    if (!refs.cred) return;
    if (!c) { if (refs.cred.innerHTML) refs.cred.innerHTML = ''; return; }
    var lvl = c.atteint ? 'crit' : (c.level || 'ok');
    var txt = money(c.used, c.currency) + (c.limit != null ? ' / ' + money(c.limit, c.currency) : '');
    var h = '<div class="row"><div class="top"><span>' + esc(T.credits) + '</span>' +
            '<span class="pct ' + lvl + '">' + esc(txt) + '</span></div>';
    if (c.pct != null) {
      h += '<div class="bar"><div class="fill ' + lvl + '" style="width:' +
           Math.min(Math.max(c.pct, 0), 100) + '%"></div></div>';
    }
    h += '<div class="eta">' + esc(c.atteint ? T.capReached : T.beyondPlan) + '</div></div>';
    if (refs.cred.innerHTML !== h) refs.cred.innerHTML = h;
  }

  function updatePause(until) {
    if (!refs.pause) return;
    refs.pause.hidden = !until;
    if (!until) return;
    var m = Math.max(0, Math.round((until - Date.now()) / 60000));
    setText(refs.pause, m > 60
      ? fmt(T.pausedH, Math.floor(m / 60), m % 60)
      : fmt(T.pausedMin, m));
  }

  // A single mount for both halves, a single DOM write. The references are
  // then scoped to their own container: without that, the secrets' life
  // bars would get mistaken for quota bars.
  function mountAll(d) {
    var q = document.getElementById('quota');
    var s = document.getElementById('secrets');

    q.innerHTML = (!d || !d.rows.length)
      ? skeleton() +
        (d && d.error ? '<div class="warnmsg"></div>' : '<div class="hint">' + esc(T.loading) + '</div>')
      : htmlFull(d.rows);

    var v = (d && d.vault) || null;
    s.innerHTML = v ? htmlSecrets(v) : '';
    updateSection(v);

    refs = {
      vide: !d || !d.rows.length,
      rows: rowRefs(q),
      err: q.querySelector('.warnmsg'),
      pause: q.querySelector('.pausemsg'),
      cred: q.querySelector('#cred'),
      at: q.querySelector('.at'),
      keys: s.querySelectorAll('.key'),
      meta: s.querySelectorAll('.kmeta')
    };
    if (refs.vide && d && d.error && refs.err) refs.err.textContent = '⚠ ' + d.error;
  }

  function render() {
    var d = lastData;
    document.dispatchEvent(new CustomEvent('quota-initial', { detail: d }));
    var st = structOf(d);
    if (st !== struct) { struct = st; mountAll(d); }
    if (!refs) return;

    if (!refs.vide && d && d.rows.length) {
      paintRows(refs.rows, d.rows);
      if (refs.err) {
        refs.err.hidden = !d.error;
        if (d.error) setText(refs.err, '⚠ ' + d.error);
      }
      updateCredits(d.credits);
      updatePause(d.pause);
      if (refs.at) setText(refs.at, footText(d));
    } else if (refs.err && d && d.error) {
      setText(refs.err, '⚠ ' + d.error);
    }
    renderCodex(d && d.companion);

    if (d && d.vault) updateSecrets(d.vault);
    var stools = document.getElementById('stools');
    if (stools) stools.hidden = !(d && d.vault && d.vault.secrets && d.vault.secrets.length);
    applySearch();
    fillGroups();
  }

  window.addEventListener('message', function (e) {
    lastData = e.data;
    if (lastData && lastData.defaults) defaults = lastData.defaults;
    if (lastData && lastData.vault) sortSecrets(lastData.vault);   // recent first by default
    // setState receives ONLY what comes from the extension: never the content
    // of input fields, which must survive neither a reload nor state restoration.
    api.setState(lastData);
    render();
  });

  // countdowns stay accurate between two API calls: one wakeup per minute,
  // aligned to the rollover, and none at all while the panel is hidden.
  // Exception: a key expiring in under 10 min deserves a refresh every 10 s,
  // otherwise its bar would visibly jump in steps.
  function nextDelay() {
    var minute = 60000 - (Date.now() % 60000) + 200;
    if (!lastData) return minute;
    // Same rule for a quota about to reset, Claude or ChatGPT alike: the
    // countdown is the thing being watched at that moment.
    var q = (lastData.rows || []).concat((lastData.companion && lastData.companion.rows) || []);
    for (var k = 0; k < q.length; k++) {
      var left = q[k].resetAt - Date.now();
      if (left > 0 && left < 600000) return Math.min(minute, 10000);
    }
    var v = lastData.vault || { secrets: [] };
    for (var i = 0; i < v.secrets.length; i++) {
      var l = lifeOf(v.secrets[i]);
      if (l && l.left > 0 && l.left < 600000) return Math.min(minute, 10000);
    }
    return minute;
  }

  function schedule() {
    setTimeout(function () {
      if (lastData && document.visibilityState !== 'hidden') render();
      schedule();
    }, nextDelay());
  }
  schedule();
  render();
})();
</script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
