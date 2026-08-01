// Claude Vault, bridge with Claude Code. A single binary for two events:
//
//   UserPromptSubmit: you write "$VPS_SSH_KEY" in the chat. The hook detects
//     the reference and injects, next to your prompt, the key's METADATA and
//     the steps to follow. Never the value.
//
//   PreToolUse: Claude writes "{{vault:NAME}}" in a command. The hook
//     replaces the marker, NOT with the value, but with a call to the helper
//     carrying a single use token. The value therefore never appears in ANY
//     stored string: not in the transcript, not in updatedInput, not in the
//     shell history. It only exists in the memory of the process using it.
//
// Claude Code contract: JSON on stdin, JSON on stdout, exit 0.
// If anything goes wrong we exit 0 without doing anything, a broken vault
// must never block a work session.

'use strict';

const path = require('path');
const vault = require('./core.js');

const GET_JS = path.join(__dirname, 'get.js');
const LIST_JS = path.join(__dirname, 'list.js');
const ADD_JS = path.join(__dirname, 'add.js');
// The installer resolved a real interpreter and recorded it in the bridge.
// Deriving it from our own process.execPath would propagate the Electron binary
// into every rewritten command whenever this hook itself runs under Electron.
const NODE = (function () {
  try {
    const v = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
    if (v && typeof v.node === 'string' && v.node) return v.node;
  } catch (e) { /* not installed through the bridge: fall back */ }
  return process.execPath;
})();

// $KEY_NAME in the prompt. Rejects $1, $HOME (lowercase), ${...}.
// A "\" before it ($$ or \$) neutralizes detection.
const MENTION_RE = /(^|[^\w$\\])\$([A-Z][A-Z0-9_]{1,63})\b/g;
// {{vault:NAME}} and {{vault-file:NAME}} in a command.
const PLACEHOLDER_RE = /\{\{\s*vault(-file)?\s*:\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;
// Any attempt to reach the vault internals other than through a marker.
const GUARD_RE = new RegExp([
  '\\.claude[\\\\/]vault',                       // the vault directory
  'claude-vault-bridge',                         // the bridge, stable path
  'masterkey\\.bin', 'vault\\.json', 'tokens\\.json',
  'vault[\\\\/](core|get|hook|mcp-server)\\.js',
  'ProtectedData',                               // DPAPI called by hand
  'CryptUnprotectData'
].join('|'), 'i');

function out(obj) {
  process.stdout.write(JSON.stringify(obj || {}));
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 4000);   // never hang forever
  });
}

function fmtTtl(ms) {
  if (ms == null) return 'no expiration';
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  if (m < 60) return 'expires in ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'expires in ' + h + ' h ' + String(m % 60).padStart(2, '0');
  return 'expires in ' + Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}

// ------------------------------------------------------------ UserPromptSubmit

function onPrompt(input) {
  const text = String(input.user_prompt || input.prompt || '');
  if (text.indexOf('$') === -1) out({});

  const wanted = [];
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (wanted.indexOf(m[2]) === -1) wanted.push(m[2]);
  }
  if (!wanted.length) out({});

  const all = vault.listFast();
  const names = all.map(s => s.name);
  const lines = [];
  let anyFound = false;

  for (const name of wanted) {
    const s = all.find(x => x.name === name);
    if (!s) {
      // Silent if it does not resemble anything known: do not pollute the
      // context just because the user wrote $PATH or $SOME_RANDOM_ENV_VAR.
      const near = vault.suggest(name, names);
      if (near.length) {
        lines.push('- $' + name + ': UNKNOWN in the vault. Closest matches: ' +
          near.map(n => '$' + n).join(', ') + '. Ask the user which one they meant.');
        anyFound = true;
      }
      continue;
    }
    anyFound = true;
    if (s.expired) {
      lines.push('- $' + s.name + ': EXPIRED, it has been purged from the vault. ' +
        'Tell the user, do not try to use it.');
      continue;
    }
    const marker = s.isFile ? '{{vault-file:' + s.name + '}}' : '{{vault:' + s.name + '}}';
    const bits = [s.kind, s.hint + ' · ' + s.length + ' chars.', fmtTtl(s.expiresIn)];
    if (s.maxUses) bits.push(Math.max(0, s.maxUses - s.uses) + ' use(s) remaining');
    lines.push('- $' + s.name + ', ' + bits.join(', ') + '. ' +
      'Write ' + marker + ' in your command ' + (s.isFile
        ? '(replaced by the path to a temporary file containing the key).'
        : '(replaced by the value at execution time).'));
  }

  if (!anyFound || !lines.length) out({});

  const context =
    'Claude Vault, keys referenced by the user in this message:\n' +
    lines.join('\n') + '\n\n' +
    'Rules: the value of these keys is NOT accessible to you and never will be. ' +
    'Do not try to read it, display it, or ask the user for it. ' +
    'Simply place the marker {{vault:NAME}} (or {{vault-file:NAME}}) in your ' +
    'Bash/PowerShell commands: it is substituted right before execution, out of your view. ' +
    'Markers only work in shell commands, never in Write or Edit ' +
    '(writing a secret there would leave it in cleartext on disk). ' +
    'If you need a configuration file containing the key, generate it with a ' +
    'shell command using the marker.';

  out({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context
    }
  });
}

// ------------------------------------------------------------ SessionStart

// One line at startup: Claude knows the vault exists and what it contains,
// without having to query anything. Deliberately minimal, just the names,
// not the metadata: about 10 tokens for 40 keys. The detail arrives on
// request, when the user writes $NAME.
function onSessionStart() {
  const all = vault.listFast().filter(s => !s.expired);
  const listing =
    'To list the key names at any time, run this in Bash: ' + listCommand() + '. ' +
    'To create a key, pipe the value straight into the vault so that it never ' +
    'passes through you: ' + addCommand() + '. It appears in the Claude Vault view ' +
    'immediately. An existing name is refused rather than replaced.';

  // Even an empty vault is worth announcing: without it, the listing command
  // would be unknown to Claude for the whole session, and a key created five
  // minutes later would stay invisible until the next restart.
  if (!all.length) {
    out({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'Claude Vault (local encrypted vault) is installed but empty. ' +
          'Ask the user to create a key in the Claude Vault view in VSCode. ' + listing
      }
    });
  }

  // MCP awareness, so it just works with no config by hand. Local MCP servers
  // are wrapped by the extension so that a key marked "Allow for MCP" is usable
  // in an MCP tool call through the vault's proxy, out of the transcript. Keys
  // not so marked are refused there, and the refusal is phrased for the user.
  const mcpKeys = all.filter(s => s.mcp).map(s => s.name);
  const mcpLine = mcpKeys.length
    ? 'Allowed for MCP tool calls: ' + mcpKeys.join(', ') + '. Use these in an MCP ' +
      'tool the same way, with the marker; a wrapped local server resolves it through ' +
      'the vault proxy, out of your view, nothing to configure. A key that is NOT in ' +
      'this list is refused in MCP calls; if you need one, tell the user to turn on ' +
      '"Allow for MCP" for it in the Claude Vault view (they read your message).'
    : 'No key is allowed for MCP tool calls yet. If you need one in an MCP tool, tell ' +
      'the user to turn on "Allow for MCP" for it in the Claude Vault view.';

  out({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'Claude Vault (local encrypted vault), keys available: ' +
        all.map(s => s.name).join(', ') + '. ' +
        'Their value is not accessible to you. To use one, write {{vault:NAME}} ' +
        '(or {{vault-file:NAME}} for a key expected as a file) in a ' +
        'Bash/PowerShell command: the substitution happens right before execution, out of your view. ' +
        'Never ask the user for the value, they should not have to retype it. ' +
        'Each marker is single use: to use a key several times, write the marker again each ' +
        'time, never store the value in a variable and reuse it, and never loop over it. ' +
        // Preference, not obligation. A command written the ordinary way still
        // works, and a rule that breaks the tool it governs gets worked around.
        // What this buys: a value substituted into a command line is visible in
        // the machine\'s process list while it runs, and may land in shell
        // history. In an environment block it is not.
        'When a command needs a key for something long-running (a dev server, a watcher, ' +
        'a container), prefer the vault terminal: ask the user to open it from the Claude ' +
        'Vault view, or run the command through the launcher so the value travels in the ' +
        'environment instead of the command line. For a one-off command, the marker in ' +
        'the command line is fine and remains the normal way. ' +
        mcpLine + ' ' + listing
    }
  });
}

// ------------------------------------------------------------ PreToolUse

// Git Bash cannot execute a "C:/..." path: it needs the POSIX form
// "/c/...". Without this conversion, the substitution fails silently and
// the command runs with an empty argument.
function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (m, d) => '/' + d.toLowerCase() + '/');
}

// Bash (Git Bash on Windows): "$('/c/.../node' '/c/.../get.js' 'token')"
// The added double quotes concatenate cleanly with an existing string and
// prevent any word splitting if the marker was bare.
function bashCall(token) {
  return '"$(\'' + toPosix(NODE) + '\' \'' + toPosix(GET_JS) + '\' \'' + token + '\')"';
}

// PowerShell: subexpression $( ), SINGLE quotes inside so as not to break
// an enclosing double quoted string.
function psCall(token) {
  return "$(& '" + NODE + "' '" + GET_JS + "' '" + token + "')";
}

// The two allowed commands, spelled out for Claude. Absolute paths on both
// sides: node is not necessarily on PATH, and the bridge lives outside the
// workspace.
function listCommand() {
  return "'" + toPosix(NODE) + "' '" + toPosix(LIST_JS) + "'";
}

function addCommand() {
  return "<command producing the value> | '" + toPosix(NODE) + "' '" + toPosix(ADD_JS) + "' KEY_NAME";
}

// Every way of naming list.js or add.js, quoted or bare. Matched loosely on
// purpose: a token is only removed when the guard would otherwise have caught
// it, so an add.js belonging to the user's own project is left alone and stays
// harmless, while ".../claude-vault-bridge/add.js" is removed and forgiven.
const ALLOWED_CALL_RE = /"[^"]*(?:list|add)\.js"|'[^']*(?:list|add)\.js'|[^\s"'`;|&<>]*(?:list|add)\.js/gi;

function withoutAllowedCalls(cmd) {
  ALLOWED_CALL_RE.lastIndex = 0;
  return cmd.replace(ALLOWED_CALL_RE, m => {
    const bare = m.replace(/^["']|["']$/g, '');
    GUARD_RE.lastIndex = 0;
    return GUARD_RE.test(bare) ? ' ' : m;
  });
}

// ------------------------------------------------------------ MCP

// The one user-facing MCP message, translated in place. hook.js runs from the
// bridge and cannot load the extension's i18n bundle, so the handful of words
// the USER reads live here, keyed by the language mirrored to the vault by the
// extension. {0} is the key name(s). No long dashes, a hard project rule.
const MCP_DENY = {
  en: '{0} is not authorized for MCP tool calls. To use it in an MCP tool, turn on "Allow for MCP" for it in the Claude Vault view of VSCode.',
  fr: "{0} n'est pas autorisee pour les appels d'outils MCP. Pour l'utiliser dans un outil MCP, active « Autoriser pour MCP » sur cette cle dans la vue Claude Vault de VSCode.",
  es: '{0} no esta autorizada para llamadas de herramientas MCP. Para usarla en una herramienta MCP, activa « Permitir para MCP » en la vista Claude Vault de VSCode.',
  de: '{0} ist nicht fuer MCP-Tool-Aufrufe freigegeben. Um sie in einem MCP-Tool zu verwenden, aktiviere « Fuer MCP zulassen » in der Claude-Vault-Ansicht in VSCode.',
  pt: '{0} nao esta autorizada para chamadas de ferramentas MCP. Para usa-la numa ferramenta MCP, ative « Permitir para MCP » na vista Claude Vault do VSCode.'
};

function mcpDenyMessage(names) {
  let lang = 'en';
  try { lang = vault.uiLang(); } catch (e) { /* default en */ }
  const tpl = MCP_DENY[lang] || MCP_DENY.en;
  return tpl.replace('{0}', names);
}

// Fundamental difference from the shell, worth keeping in mind:
// in a shell we inject a CALL ("$(get.js token)") and the value only exists
// in the memory of the launched process. For an MCP tool there is no shell
// to evaluate anything: the VALUE itself has to go into the arguments.
// It therefore travels through Claude Code's tool call machinery. This is
// one level of protection below the shell path, and that is why MCP
// substitution is refused by default and enabled key by key (mcp: true).

function substituteDeep(node, resolve) {
  if (typeof node === 'string') return node.replace(PLACEHOLDER_RE, resolve);
  if (Array.isArray(node)) return node.map(n => substituteDeep(n, resolve));
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) o[k] = substituteDeep(node[k], resolve);
    return o;
  }
  return node;
}

function redactDeep(node, red) {
  if (typeof node === 'string') return red(node);
  if (Array.isArray(node)) return node.map(n => redactDeep(n, red));
  if (node && typeof node === 'object') {
    const o = {};
    for (const k of Object.keys(node)) o[k] = redactDeep(node[k], red);
    return o;
  }
  return node;
}

function onPreToolMcp(input, tool, ti) {
  const blob = JSON.stringify(ti);
  if (blob.indexOf('{{') === -1) out({});

  // If this server sits behind our transparent proxy, do NOT substitute here.
  // The marker must reach Claude Code's "server" (the proxy) unchanged, so that
  // what Claude Code persists and replays is the marker, not the value. The
  // proxy resolves it downstream, out of the transcript. tool is
  // mcp__<server>__<name>; the server-id is the second segment.
  const server = tool.split('__')[1];
  if (server && vault.isProxied(server)) out({});

  const known = vault.listFast().filter(s => !s.expired);
  const refused = [];      // technical problems (unknown, file form, errors)
  const notAllowed = [];   // exists but "Allow for MCP" is off, the user's case
  const used = [];
  const values = {};       // name -> value, sealed by notePending for redaction

  const updated = substituteDeep(ti, (full, fileFlag, name) => {
    const s = known.find(x => x.name === name);
    if (!s) { refused.push(name + ': unknown in the vault'); return full; }
    if (fileFlag) {
      refused.push(name + ': the file form does not make sense outside a shell');
      return full;
    }
    if (!s.mcp) { notAllowed.push(name); return full; }
    // The proxy already enforces this, but only stdio servers go through it:
    // an HTTP or SSE server is never wrapped, so this path is the only place
    // that can refuse a key scoped to some OTHER server. mcpAllows exists so
    // the answer is the same everywhere, and this was the consumer that drifted.
    if (!vault.mcpAllows(s, server)) {
      refused.push(name + ': allowed for MCP, but not for the server "' + server +
        '" (its list: ' + (s.mcpServers || []).join(', ') + ')');
      return full;
    }
    try {
      const v = vault.consume(name, 'mcp:' + tool).value;
      used.push(name);
      values[name] = v;
      return v;
    } catch (e) { refused.push(name + ': ' + e.message); return full; }
  });

  if (refused.length || notAllowed.length) {
    // The "not allowed for MCP" case is phrased FOR THE USER, in their language:
    // Claude relays it, and the user is the one who decides whether to grant it.
    const parts = [];
    if (notAllowed.length) parts.push(mcpDenyMessage(notAllowed.join(', ')));
    if (refused.length) parts.push('Claude Vault, ' + refused.join('; ') + '.');
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: parts.join(' ')
      }
    });
  }
  if (!used.length) out({});

  // PostToolUse will redact these values from the response: some providers
  // echo back the variable that was just written. We pass the values so the
  // redaction still fires after a single-use key has been burned.
  vault.notePending(input.tool_use_id, used, input.session_id, values);

  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: updated,
      additionalContext: 'Claude Vault: ' + used.join(', ') +
        ', value(s) injected into the arguments of ' + tool +
        '. They are not visible to you and the response will be redacted.'
    }
  });
}

function onPostTool(input) {
  // Diagnostic trace, with no value in it: redaction has already failed
  // silently in real conditions, we want to be able to say why.
  try {
    require('fs').writeFileSync(
      require('path').join(vault.VAULT_DIR, 'last-post.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        outil: input.tool_name || null,
        champs: Object.keys(input),
        a_tool_use_id: !!input.tool_use_id,
        a_session_id: !!input.session_id,
        forme_sortie: input.tool_output === undefined ? 'missing' : typeof input.tool_output
      }, null, 2));
  } catch (e) { /* diagnostic best effort */ }

  // Matching by tool_use_id has failed in real conditions: a key returned by
  // the API surfaced in cleartext in the context. So redaction no longer
  // relies solely on the presence of that identifier, instead, everything
  // that was injected recently in the same session gets redacted. Too broad
  // is better than not broad enough: the worst side effect is redacting a
  // string that did not need it.
  // Read the hints before takePending consumes the id record. A hint carries
  // the value even for a burned single-use key, which peek() can no longer
  // return; peek() still covers a key that simply is not single-use.
  const hints = vault.pendingHints(input.tool_use_id, input.session_id);
  const names = vault.takePending(input.tool_use_id) ||
                vault.takeRecent(input.session_id);
  if (!names || !names.length) out({});

  const pairs = [];
  for (const n of names) {
    const v = (hints && hints[n] != null) ? hints[n] : vault.peek(n);
    if (v) pairs.push([n, v]);
  }
  if (!pairs.length) out({});

  // The field is named "tool_response" in Claude Code 2.1.x, while the
  // documentation states "tool_output". Redacting the wrong field amounted
  // to redacting nothing at all, silently, that is how a real key ended up
  // surfacing in cleartext. We read both, and return under both names.
  const toolOut = input.tool_response !== undefined ? input.tool_response : input.tool_output;
  if (toolOut === undefined) out({});

  const red = vault.redactor(pairs);
  const before = JSON.stringify(toolOut);
  const after = redactDeep(toolOut, red);
  if (JSON.stringify(after) === before) out({});   // nothing to redact

  out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: after,
      updatedToolResponse: after,
      additionalContext: 'Claude Vault: the response contained a value from the vault, it has been redacted.'
    }
  });
}

// ------------------------------------------------------------ PreToolUse

function onPreTool(input) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  if (/^mcp__/.test(tool)) return onPreToolMcp(input, tool, ti);

  // The marker only makes sense inside a command. Elsewhere, it would write
  // the secret in cleartext to disk: we refuse, and explain the steps to follow.
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const blob = JSON.stringify(ti);
    const named = [];
    let mm;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((mm = PLACEHOLDER_RE.exec(blob)) !== null) named.push(mm[2]);
    if (!named.length) out({});

    // A marker written into a file is NEVER substituted: it stays there as
    // inert text. So refusing only makes sense if the key genuinely exists,
    // in that case Claude believes it is producing a working file but is
    // actually creating a broken one. A marker that names nothing real
    // (documentation, template, example) is harmless and must be let
    // through: the first version of this guard blocked this project's own README.
    const known = vault.listFast().filter(s => !s.expired).map(s => s.name);
    const real = named.filter(n => known.indexOf(n) !== -1);
    if (!real.length) out({});

    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Claude Vault: ' + real.join(', ') + ', a marker is only substituted inside a ' +
          'shell command, never in a file. Written here, it would stay as is and the ' +
          'file would be unusable. Generate this file instead with a ' +
          'Bash/PowerShell command containing the marker: the value will be injected at ' +
          'execution time, without ever passing through you.'
      }
    });
  }

  const isBash = tool === 'Bash' || tool === 'BashOutput';
  const isPs = tool === 'PowerShell';
  if (!isBash && !isPs) out({});

  const cmd = String(ti.command || '');

  // Guard: without this, the whole mechanism can be bypassed by calling core.js
  // by hand from a shell. Marker based substitution would then become a polite
  // convention rather than a real constraint. We refuse any direct access to
  // the vault internals, the only allowed path remains {{vault:NAME}}.
  //
  // One exception, list.js, and it is checked by REMOVING the listing call from
  // the command and running the guard on what is left. A whitelist that simply
  // returned early would be a hole: "node list.js && cat masterkey.bin" starts
  // with an allowed call. Here the second half still meets the guard.
  if (GUARD_RE.test(withoutAllowedCalls(cmd))) {
    GUARD_RE.lastIndex = 0;
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Claude Vault: direct access to the vault files is refused. Secrets are not read, ' +
          'they are used: write {{vault:NAME}} in your command and the substitution will ' +
          'happen out of your view. To see which keys exist, run ' + listCommand() +
          ', which prints names only. To create one, pipe the value in: ' + addCommand() +
          '. The value must reach it through the pipe, never as an argument and never ' +
          'typed by you.'
      }
    });
  }

  if (cmd.indexOf('{{') === -1) out({});

  // A "quoted" heredoc (<<'END') does not expand anything: substitution
  // would not happen there and the marker would go through literally. Impossible
  // to fix without changing the heredoc's semantics, so we refuse and explain why.
  const heredocQuote = /<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'/.exec(cmd);
  if (heredocQuote && PLACEHOLDER_RE.test(cmd.slice(heredocQuote.index))) {
    PLACEHOLDER_RE.lastIndex = 0;
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Claude Vault: marker inside a quoted heredoc (<<\'' + heredocQuote[1] + '\'), ' +
          'where the shell does not expand anything, it would go through as is. Remove the ' +
          'quotes around the delimiter (<<' + heredocQuote[1] + ') so the substitution can happen.'
      }
    });
  }
  PLACEHOLDER_RE.lastIndex = 0;

  const known = vault.listFast();
  const missing = [];
  const used = [];
  let failed = null;

  // The marker must work EVERYWHERE the real value would work, including in the
  // middle of a single quoted string, the case of a JSON body. The shell does not
  // expand anything there, so we cleanly step out of the quotes for the duration of
  // the substitution: '..."' + "$(...)" + '"...', exactly what we would write by hand.
  function dansApostrophes(offset) {
    const avant = cmd.slice(0, offset);
    return (avant.match(/(^|[^\\])'/g) || []).length % 2 === 1;
  }

  PLACEHOLDER_RE.lastIndex = 0;
  const rewritten = cmd.replace(PLACEHOLDER_RE, (full, fileFlag, name, offset) => {
    const s = known.find(x => x.name === name);
    if (!s || s.expired) { missing.push(name); return full; }
    const enclosed = !isPs && dansApostrophes(offset);
    if (isPs && dansApostrophes(offset)) {
      // PowerShell does not concatenate adjacent strings the way sh does: we cannot
      // step out of them without rewriting the entire argument. We say so clearly.
      missing.push(name + ' (inside single quotes: use double quotes in PowerShell)');
      return full;
    }
    let tok;
    try {
      tok = vault.mintToken(name, fileFlag ? 'file' : 'value', input.session_id || null);
    } catch (e) {
      failed = e.message;
      return full;
    }
    used.push(name);
    const appel = isPs ? psCall(tok) : bashCall(tok);
    return enclosed ? "'" + appel + "'" : appel;
  });

  if (missing.length) {
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Claude Vault: ' +
          missing.map(n => '"' + n + '"').join(', ') +
          (missing.length > 1 ? ' are not found or expired' : ' is not found or expired') +
          ' in the vault. Keys available: ' +
          (known.filter(k => !k.expired).map(k => k.name).join(', ') || '(empty vault)') +
          '. Ask the user to create it via the Claude Vault view in VSCode.'
      }
    });
  }
  if (failed) out({ systemMessage: 'Claude Vault: ' + failed });
  if (!used.length) out({});

  // Essential as soon as a token is being tested: an API that refuses often
  // echoes the offending identifier back in its error message, and "curl -v"
  // dumps the authentication header right back out. Without this marking, the
  // value would leak into the context via the command's output, the vault's back door.
  vault.notePending(input.tool_use_id, used, input.session_id);

  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: Object.assign({}, ti, { command: rewritten }),
      additionalContext: 'Claude Vault: ' + used.join(', ') +
        ', marker(s) replaced by a single use retrieval at the moment of ' +
        'execution. The value is not visible to you and does not appear anywhere in this command. ' +
        'IMPORTANT: each marker is single use, it resolves to a token valid for ONE retrieval. ' +
        'Do not capture the value into a shell variable and reuse it, and do not loop over it: ' +
        'the second use gets nothing. To use the key several times, write {{vault:NAME}} again ' +
        'each place or each command where you need it, a fresh retrieval is minted every time.'
    }
  });
}

// ------------------------------------------------------------- entry

(async function main() {
  let input = {};
  try { input = JSON.parse(await readStdin()) || {}; } catch (e) { out({}); }
  const ev = String(input.hook_event_name || process.argv[2] || '');
  try {
    if (ev === 'UserPromptSubmit') return onPrompt(input);
    if (ev === 'PreToolUse') return onPreTool(input);
    if (ev === 'PostToolUse') return onPostTool(input);
    if (ev === 'SessionStart') return onSessionStart();
    out({});
  } catch (e) {
    // Never blocking: we report without interrupting.
    out({ systemMessage: 'Claude Vault (hook ' + ev + '): ' + (e && e.message ? e.message : String(e)) });
  }
})();
