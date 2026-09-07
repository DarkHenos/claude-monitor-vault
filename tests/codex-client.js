'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { CodexClient } = require('../companion/codex');
let notifications = 0;
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  let initialized = false;
  child.stdin.on('data', data => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'initialized') { initialized = true; return; }
    if (msg.method === 'initialize') assert.equal(initialized, false);
    else assert.equal(initialized, true);
    if (msg.method === 'fail') { child.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'Expected server failure' } }) + '\n'); return; }
    if (msg.method === 'hang') return;
    let result = {};
    if (msg.method === 'account/read') result = { account: { type: 'chatgpt' } };
    if (msg.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 10 } } };
    if (msg.method === 'model/list') result = msg.params.cursor
      ? { data: [{ id: 'second', model: 'second' }], nextCursor: null }
      : { data: [{ id: 'première', model: 'first' }], nextCursor: 'page2' };
    const bytes = Buffer.from(JSON.stringify({ id: msg.id, result }) + '\n');
    // Split every UTF-8 character across chunks as well as JSON boundaries.
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  });
  return child;
}
(async () => {
  const client = new CodexClient({ command: 'fake', args: [] }, fakeSpawn);
  const usage = await client.usage(); assert.equal(usage.rateLimits.primary.usedPercent, 10);
  console.log('PASS initialized account read and quota request');
  const models = await client.models(); assert.equal(models.length, 2); assert.equal(models[0].id, 'première');
  console.log('PASS paginated model catalog and fragmented UTF-8');
  client.onUpdate = () => notifications++;
  client.child.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: {} }) + '\n');
  assert.equal(notifications, 1); console.log('PASS quota notifications');
  await assert.rejects(client.request('fail'), /Expected server failure/);
  assert.equal(client.pending.size, 0); console.log('PASS JSON-RPC errors clean up pending requests');
  const pending = client.request('hang'); client.dispose(); await assert.rejects(pending, /closed/);
  assert.equal(client.pending.size, 0); console.log('PASS disposal rejects pending requests');
  await client.start(); assert.ok(client.child); client.dispose(); console.log('PASS reconnect after disposal');
})().catch(e => { console.error(e); process.exitCode = 1; });
