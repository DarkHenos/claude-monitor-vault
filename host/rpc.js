// JSON-RPC between this Node process and the IDE that started it.
//
// One JSON object per line, in both directions, over stdin and stdout. Either
// side can send a request (it carries an id and expects a response) or a
// notification (no id, no answer). Line-delimited JSON rather than the
// Content-Length framing of LSP: JSON.stringify never emits a raw newline, so a
// line is always a whole message, and the IDE side can read it with a plain
// buffered reader.
//
// Values typed into a masked input box travel through here. Nothing in this
// file logs a message body, and nothing should start to.

'use strict';

const readline = require('readline');

function create(input, write) {
  const pending = new Map();
  const requestHandlers = new Map();
  const notificationHandlers = new Map();
  const closeHandlers = [];
  let nextId = 1;
  let closed = false;

  function send(obj) {
    if (closed) return;
    try { write(JSON.stringify(obj) + '\n'); } catch (e) { /* the IDE is gone */ }
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error('IDE connection closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params: params === undefined ? null : params });
    });
  }

  function notify(method, params) {
    send({ method, params: params === undefined ? null : params });
  }

  function errorOf(e) {
    return { message: String((e && e.message) || e || 'error') };
  }

  async function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.method === undefined) {                 // a response to one of ours
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'IDE error'));
      else p.resolve(msg.result === undefined ? null : msg.result);
      return;
    }
    if (msg.id === undefined || msg.id === null) {  // a notification
      const h = notificationHandlers.get(msg.method);
      if (h) { try { await h(msg.params); } catch (e) { console.error('[host]', msg.method, e); } }
      return;
    }
    const h = requestHandlers.get(msg.method);
    if (!h) { send({ id: msg.id, error: { message: 'unknown method ' + msg.method } }); return; }
    try {
      const result = await h(msg.params);
      send({ id: msg.id, result: result === undefined ? null : result });
    } catch (e) {
      send({ id: msg.id, error: errorOf(e) });
    }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { console.error('[host] unreadable message from the IDE'); return; }
    onMessage(msg);
  });
  rl.on('close', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('IDE connection closed'));
    pending.clear();
    for (const h of closeHandlers) { try { h(); } catch (e) { /* shutting down */ } }
  });

  return {
    request,
    notify,
    onRequest: (method, h) => requestHandlers.set(method, h),
    onNotification: (method, h) => notificationHandlers.set(method, h),
    onClose: h => closeHandlers.push(h),
    get closed() { return closed; }
  };
}

module.exports = { create };
