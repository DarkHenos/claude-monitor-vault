// What the vault's owner decides, without VS Code: each action shows what is at
// stake, read fresh from the vault rather than from what the caller says, and asks.
// `ui` is the window (owner.js) or a script of answers (the tests). Every action
// returns true when it changed something. None of them prints a key's value; the
// recovery phrase is shown once, to the person who asked for it, in that window.
'use strict';

const SERVER_RE = /^[A-Za-z0-9._-]{1,64}$/;

const TEXTS = {
  en: {
    yes: 'yes',
    no: 'no',
    choose: 'choose',
    nothing: 'This request is no longer waiting.',
    noKey: name => `${name} is not in the vault.`,
    replaceAsk: name => `Claude asks to replace ${name}.`,
    replaceFacts: (kind, length) => `New value: ${kind}, ${length} characters. Neither you nor Claude has seen it.`,
    says: note => `Claude says: ${note}`,
    replaceLost: 'The current value is destroyed and cannot be recovered.',
    replaceMcp: scope => `This key is allowed for MCP (${scope}); the new value inherits it.`,
    replaceChoice: '1 = replace, 2 = replace without MCP access, 3 = keep the current value: ',
    replaceYesNo: 'Replace? yes = replace, no = keep the current value: ',
    replaced: name => `${name} replaced.`,
    kept: name => `${name} kept, the request is refused.`,
    undecided: 'Nothing decided: the request is still waiting.',
    everyServer: 'every server',
    mcpAsk: (who, count) => `${who} asks for MCP access to ${count} key(s):`,
    mcpServers: list => `Servers: ${list}`,
    mcpEffect: 'In an MCP call the value is placed in the tool arguments and sent to that server.',
    mcpWrap: 'Allowing also routes your local MCP servers through the vault (~/.claude.json, backed up first).',
    mcpChoice: 'yes = allow what is listed, choose = pick the servers, no = refuse: ',
    mcpServersAsk: 'Allowed servers, separated by commas: ',
    mcpBadServers: 'Those server names are not valid.',
    mcpGranted: 'MCP access granted.',
    mcpRefused: 'MCP request refused.',
    useAsk: (name, who) => `${who || 'Claude'} wants to use ${name} now.`,
    useChoice: 'Allow this one use? yes / no: ',
    useDone: ok => (ok ? 'Allowed, once.' : 'Refused.'),
    deleteAsk: (name, days) => `Delete ${name}? It waits ${days} days in the bin, then it is gone.`,
    deleteConfirm: name => `Type ${name} to confirm: `,
    deleted: name => `${name} moved to the bin.`,
    cancelled: 'Cancelled: nothing changed.',
    mcpKeyNow: (name, scope) => `${name}, MCP today: ${scope}`,
    mcpKeyNone: 'not allowed',
    mcpKeyChoice: 'Allowed servers: * = every server, names separated by commas, - = none, Enter = no change: ',
    mcpKeySaved: 'MCP access updated.',
    binEmpty: 'The bin is empty.',
    binLine: (i, name, days) => `${i}. ${name} (${days} days left)`,
    binChoice: 'Number of the key to bring back, Enter to leave: ',
    binBack: name => `${name} is back in the vault.`,
    binRenamed: (from, name) => `${from} came back as ${name}, since the name was taken. Update any marker that points at it.`,
    phraseWhy: 'This phrase reopens your vault if this computer\'s key is lost, for example after reinstalling the system. Anyone who holds it and your vault files can read your keys.',
    phraseOverwrite: 'A phrase already exists: a new one makes the old one useless.',
    phraseConfirm: 'Create a new phrase? yes / no: ',
    phraseShow: 'Write it down now, somewhere safe and off this computer. It is shown only once:',
    phraseDone: 'Press Enter once it is written down: this window clears.',
    restoreAsk: 'Recovery phrase (nothing shows, Enter to confirm): ',
    restored: count => `Vault reopened: ${count} key(s).`,
    unsupported: 'This vault bridge is too old for that: update the extension.',
  },
  fr: {
    yes: 'oui',
    no: 'non',
    choose: 'choisir',
    nothing: "Cette demande n'est plus en attente.",
    noKey: name => `${name} n'est pas dans le coffre.`,
    replaceAsk: name => `Claude demande à remplacer ${name}.`,
    replaceFacts: (kind, length) => `Nouvelle valeur : ${kind}, ${length} caractères. Ni vous ni Claude ne l'avez vue.`,
    says: note => `Claude dit : ${note}`,
    replaceLost: 'La valeur actuelle est détruite et ne peut pas être récupérée.',
    replaceMcp: scope => `Cette clé est autorisée pour MCP (${scope}) ; la nouvelle valeur en hérite.`,
    replaceChoice: '1 = remplacer, 2 = remplacer sans accès MCP, 3 = garder la valeur actuelle : ',
    replaceYesNo: 'Remplacer ? oui = remplacer, non = garder la valeur actuelle : ',
    replaced: name => `${name} remplacée.`,
    kept: name => `${name} conservée, la demande est refusée.`,
    undecided: 'Rien de décidé : la demande reste en attente.',
    everyServer: 'tous les serveurs',
    mcpAsk: (who, count) => `${who} demande l'accès MCP à ${count} clé(s) :`,
    mcpServers: list => `Serveurs : ${list}`,
    mcpEffect: "Dans un appel MCP, la valeur est placée dans les arguments de l'outil et envoyée à ce serveur.",
    mcpWrap: 'Autoriser fait aussi passer vos serveurs MCP locaux par le coffre (~/.claude.json, sauvegardé avant).',
    mcpChoice: 'oui = autoriser ce qui est listé, choisir = choisir les serveurs, non = refuser : ',
    mcpServersAsk: 'Serveurs autorisés, séparés par des virgules : ',
    mcpBadServers: 'Ces noms de serveurs ne sont pas valides.',
    mcpGranted: 'Accès MCP accordé.',
    mcpRefused: 'Demande MCP refusée.',
    useAsk: (name, who) => `${who || 'Claude'} veut utiliser ${name} maintenant.`,
    useChoice: 'Autoriser cette utilisation ? oui / non : ',
    useDone: ok => (ok ? 'Autorisé, une fois.' : 'Refusé.'),
    deleteAsk: (name, days) => `Supprimer ${name} ? Elle reste ${days} jours dans la corbeille, puis elle disparaît.`,
    deleteConfirm: name => `Tapez ${name} pour confirmer : `,
    deleted: name => `${name} placée dans la corbeille.`,
    cancelled: 'Annulé : rien n\'a changé.',
    mcpKeyNow: (name, scope) => `${name}, MCP aujourd'hui : ${scope}`,
    mcpKeyNone: 'non autorisée',
    mcpKeyChoice: 'Serveurs autorisés : * = tous, noms séparés par des virgules, - = aucun, Entrée = ne rien changer : ',
    mcpKeySaved: 'Accès MCP mis à jour.',
    binEmpty: 'La corbeille est vide.',
    binLine: (i, name, days) => `${i}. ${name} (encore ${days} jours)`,
    binChoice: 'Numéro de la clé à restaurer, Entrée pour quitter : ',
    binBack: name => `${name} est de retour dans le coffre.`,
    binRenamed: (from, name) => `${from} revient sous le nom ${name}, car le nom était pris. Mettez à jour les marqueurs qui la citent.`,
    phraseWhy: "Cette phrase rouvre votre coffre si la clé de cet ordinateur est perdue, par exemple après une réinstallation du système. Quiconque la détient avec les fichiers du coffre peut lire vos clés.",
    phraseOverwrite: "Une phrase existe déjà : en créer une nouvelle rend l'ancienne inutile.",
    phraseConfirm: 'Créer une nouvelle phrase ? oui / non : ',
    phraseShow: "Notez-la maintenant, en lieu sûr et hors de cet ordinateur. Elle ne s'affiche qu'une seule fois :",
    phraseDone: "Appuyez sur Entrée une fois notée : cette fenêtre s'efface.",
    restoreAsk: 'Phrase de récupération (rien ne s\'affiche, Entrée pour valider) : ',
    restored: count => `Coffre rouvert : ${count} clé(s).`,
    unsupported: "Ce pont du coffre est trop ancien pour ça : mettez l'extension à jour.",
  },
};

const has = (vault, name) => typeof vault[name] === 'function';

// What the pane draws: names, sizes and what Claude said, never a value.
function status(vault) {
  const attempt = (name, fallback) => {
    try { return has(vault, name) ? vault[name]() : fallback; }
    catch (e) { return fallback; }
  };
  return {
    replaces: attempt('pendingReplacements', []).map(p => ({
      name: p.name, kind: p.kind, length: p.length, note: p.note || null,
    })),
    mcp: attempt('pendingMcp', []).map(r => ({
      rid: r.rid, names: r.names || [], servers: r.servers || null, by: r.by || null, reason: r.reason || null,
    })),
    uses: attempt('pendingUses', []).map(u => ({ id: u.id, name: u.name, who: u.who || null })),
    hasRecovery: attempt('recoveryStatus', { enabled: false }).enabled === true,
    binned: attempt('listTrash', []).length,
  };
}

function servers(typed) {
  const list = typed.split(',').map(s => s.trim()).filter(Boolean);
  return list.length && list.every(s => SERVER_RE.test(s)) ? list : null;
}

async function replace({ vault, ui, T }, name) {
  const p = vault.pendingReplacements().find(x => x.name === name);
  if (!p) { ui.say(T.nothing); return false; }
  ui.say(T.replaceAsk(p.name));
  ui.say(T.replaceFacts(p.kind, p.length));
  if (p.note) ui.say(T.says(p.note));
  ui.say(T.replaceLost);
  let answer;
  if (p.mcp) {
    ui.say(T.replaceMcp(p.mcpServers && p.mcpServers.length ? p.mcpServers.join(', ') : T.everyServer));
    answer = await ui.ask(T.replaceChoice);
  } else {
    const typed = (await ui.ask(T.replaceYesNo)).toLowerCase();
    answer = typed === T.yes ? '1' : typed === T.no ? '3' : '';
  }
  if (answer === '1' || answer === '2') {
    vault.approveReplace(p.name, p.at, answer === '2' ? { dropMcp: true } : undefined);
    ui.say(T.replaced(p.name));
    return true;
  }
  if (answer === '3') {
    vault.rejectReplace(p.name);
    ui.say(T.kept(p.name));
    return true;
  }
  ui.say(T.undecided);
  return false;
}

async function mcpRequest({ vault, wrap, ui, T }, rid) {
  const r = (has(vault, 'pendingMcp') ? vault.pendingMcp() : []).find(x => x.rid === rid);
  if (!r) { ui.say(T.nothing); return false; }
  ui.say(T.mcpAsk(r.by || 'Claude', r.names.length));
  for (const n of r.names) ui.say('  ' + n);
  ui.say(T.mcpServers(r.servers ? r.servers.join(', ') : T.everyServer));
  if (r.reason) ui.say(T.says(r.reason));
  ui.say(T.mcpEffect);
  ui.say(T.mcpWrap);
  const answer = (await ui.ask(T.mcpChoice)).toLowerCase();
  if (answer === T.no) {
    vault.rejectMcp(r.rid);
    ui.say(T.mcpRefused);
    return true;
  }
  let shown;
  if (answer === T.yes) {
    shown = { names: r.names.slice(), servers: r.servers || null, chosen: false };
  } else if (answer === T.choose) {
    const picked = servers(await ui.ask(T.mcpServersAsk));
    if (!picked) { ui.say(T.mcpBadServers); ui.say(T.undecided); return false; }
    shown = { names: r.names.slice(), servers: picked, chosen: true };
  } else {
    ui.say(T.undecided);
    return false;
  }
  try {
    vault.approveMcp(r.rid, shown);
  } catch (e) {
    // Left pending it would hold the one request slot while the AI waits: the
    // same answer the extension gives. Refused, the AI files a fresh one.
    try { vault.rejectMcp(r.rid); } catch (e2) { /* already answered */ }
    throw e;
  }
  try { wrap(); } catch (e) { /* the grant stands; a server can be wrapped by hand */ }
  ui.say(T.mcpGranted);
  return true;
}

async function use({ vault, ui, T }, id) {
  const u = vault.pendingUses().find(x => x.id === id);
  if (!u) { ui.say(T.nothing); return false; }
  ui.say(T.useAsk(u.name, u.who));
  const ok = (await ui.ask(T.useChoice)).toLowerCase() === T.yes;
  vault.answerUse(u.id, ok);
  ui.say(T.useDone(ok));
  return true;
}

async function remove({ vault, ui, T }, name) {
  if (!vault.listFast().some(s => s.name === name)) { ui.say(T.noKey(name)); return false; }
  ui.say(T.deleteAsk(name, vault.TRASH_DAYS || 30));
  if ((await ui.ask(T.deleteConfirm(name))) !== name) { ui.say(T.cancelled); return false; }
  vault.remove(name);
  ui.say(T.deleted(name));
  return true;
}

async function mcpKey({ vault, wrap, ui, T }, name) {
  const key = vault.listFast().find(s => s.name === name);
  if (!key) { ui.say(T.noKey(name)); return false; }
  const scope = !key.mcp ? T.mcpKeyNone
    : key.mcpServers && key.mcpServers.length ? key.mcpServers.join(', ') : T.everyServer;
  ui.say(T.mcpKeyNow(name, scope));
  ui.say(T.mcpEffect);
  ui.say(T.mcpWrap);
  const typed = await ui.ask(T.mcpKeyChoice);
  if (!typed) { ui.say(T.cancelled); return false; }
  if (typed === '-') {
    vault.setMcp(name, false);
  } else {
    const picked = typed === '*' ? undefined : servers(typed);
    if (picked === null) { ui.say(T.mcpBadServers); return false; }
    vault.setMcp(name, true, picked);
    try { wrap(); } catch (e) { /* the grant stands; a server can be wrapped by hand */ }
  }
  ui.say(T.mcpKeySaved);
  return true;
}

async function bin({ vault, ui, T }) {
  const items = vault.listTrash();
  if (!items.length) { ui.say(T.binEmpty); return false; }
  items.forEach((it, i) => ui.say(T.binLine(i + 1, it.name, Math.ceil(it.expiresIn / 86400000))));
  const it = items[Number(await ui.ask(T.binChoice)) - 1];
  if (!it) { ui.say(T.cancelled); return false; }
  const r = vault.restoreTrashed(it.id);
  ui.say(r.renamed ? T.binRenamed(r.from, r.name) : T.binBack(r.name));
  return true;
}

async function phrase({ vault, ui, T }) {
  if (!has(vault, 'recoveryEnable')) { ui.say(T.unsupported); return false; }
  ui.say(T.phraseWhy);
  if (vault.recoveryStatus().enabled) {
    ui.say(T.phraseOverwrite);
    if ((await ui.ask(T.phraseConfirm)).toLowerCase() !== T.yes) { ui.say(T.cancelled); return false; }
  }
  const made = vault.recoveryEnable();
  const words = Array.isArray(made) ? made.join(' ') : String(made);
  ui.say(T.phraseShow);
  ui.say('');
  ui.say('  ' + words);
  ui.say('');
  await ui.ask(T.phraseDone);
  ui.clear();
  return true;
}

async function restore({ vault, ui, T }) {
  if (!has(vault, 'recoveryRestore')) { ui.say(T.unsupported); return false; }
  const words = await ui.askHidden(T.restoreAsk);
  if (!words) { ui.say(T.cancelled); return false; }
  const r = vault.recoveryRestore(words);
  ui.say(T.restored(r.secrets));
  return true;
}

module.exports = { TEXTS, status, replace, mcpRequest, use, remove, mcpKey, bin, phrase, restore };
