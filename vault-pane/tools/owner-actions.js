// What the vault's owner decides, without VS Code: each action shows what is at
// stake, read fresh from the vault rather than from what the caller says, and asks.
// `ui` is the window (owner.js) or a script of answers (the tests). Every action
// returns true when it changed something. None of them prints a key's value; the
// recovery phrase and a transfer password stay in that window, with the person
// who asked for them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    phraseActive: (when, word) => `Current phrase: active since ${when}, last word: ${word}.`,
    phraseActiveOld: when => `Current phrase: active since ${when}. It dates from before copies were kept, so it cannot be displayed.`,
    phraseOverwrite: 'Your current phrase is not needed. Once replaced, it stops opening this vault and the backup file. It stays in the phrase history, where it can be made active again.',
    phraseOverwriteOld: 'Your current phrase is not needed. Once replaced, it stops opening this vault and the backup file, and this cannot be undone: it was never kept, so only its date stays in the history.',
    phraseLeak: 'If you are replacing it because it leaked: copies of the backup file made earlier still open with it, and the master key does not change. Delete those copies.',
    phraseConfirm: 'Create a new phrase? yes / no: ',
    phraseShow: 'Write it down now, somewhere safe and off this computer:',
    phraseKept: 'A sealed copy stays on this computer, so it can be displayed again while this vault opens. If the computer is lost, only what you wrote down remains.',
    phraseDone: 'Press Enter once it is written down: this window clears.',
    phraseNone: 'No recovery phrase has been created yet.',
    phraseNotKept: 'This phrase was not kept, so it cannot be displayed. If you no longer have it, generate a new one: the old one is not asked for.',
    phraseScreen: 'Check that nobody can see your screen: no screen sharing, no recording. The display is recorded in the log.',
    phraseShowConfirm: 'Display the phrase? yes / no: ',
    historyActive: (i, when, word) => `${i}. Active, since ${when}${word ? `, last word: ${word}` : ''}`,
    historyOld: (i, replaced, word) => `${i}. Replaced ${replaced}, ${word ? `last word: ${word}` : 'not kept'}`,
    historyChoice: 'Number of the phrase to display, Enter to leave: ',
    historyReactivate: 'Make this phrase active again? It opens this vault and the backup file again, and the phrase active today stops doing so. yes / no: ',
    historyDone: 'That phrase is active again.',
    fileBehind: file => `The backup file ${file} could not be rewritten: it still opens with the previous phrase. It catches up at the next change once that location is reachable.`,
    enterClose: 'Enter to close.',
    transferEmpty: 'The vault holds no key to transfer.',
    transferOutWhy: count => `Every key (${count}) leaves this vault in one line of text, protected only by the password you choose next. Anyone holding both can read them all. This is recorded in the log.`,
    transferOutConfirm: 'Create the string? yes / no: ',
    passwordAsk: 'Password, 12 characters or more. It is stored nowhere and nothing can recover it (nothing shows, Enter to confirm): ',
    passwordAgain: 'The same password again: ',
    passwordDiffer: 'The two passwords differ: nothing was created.',
    transferFailed: names => `These keys could not be decrypted and are not in the string: ${names}`,
    transferReady: (count, length) => `Transfer string ready: ${count} key(s), ${length} characters. On the other machine, copy it, then use Import a string.`,
    transferAdvice: 'Send the password another way than the string, and paste neither into an assistant chat. The string shows the keys as they are now: it does not follow later changes.',
    transferOutChoice: '1 = copy to the clipboard, 2 = save to a file, Enter = done: ',
    transferCopied: 'String copied to the clipboard.',
    transferCopyFailed: 'The clipboard is not reachable from here: save it to a file instead.',
    transferSaveAsk: file => `File to write, Enter for ${file}: `,
    transferSaved: file => `String saved to ${file}.`,
    transferFromClipboard: 'Transfer string found in the clipboard.',
    transferAsk: 'Path of the .txt file holding the string, or the string itself, Enter to leave: ',
    transferPassword: 'Password of this string (nothing shows, Enter to leave): ',
    wrongPassword: 'Wrong password.',
    previewCreated: when => `String created ${when}.`,
    previewNew: names => `New: ${names}`,
    previewConflict: names => `Different value here: ${names}`,
    previewSame: count => `Already here, same value: ${count}`,
    previewExpired: names => `Expired, not imported: ${names}`,
    previewInvalid: names => `Unreadable, not imported: ${names}`,
    previewMcp: count => `${count} new key(s) arrive already allowed for MCP, as on the other machine.`,
    previewBin: days => `A replaced key waits ${days} days in the bin.`,
    previewKeeps: 'This computer keeps its master key, its settings and its other keys.',
    previewNothing: count => `Nothing to import: the ${count} key(s) of this string are already here with the same value.`,
    transferInConfirm: 'Import them? yes / no: ',
    transferInChoice: '1 = keep the ones here, 2 = use the ones from the string, Enter = cancel: ',
    transferInDone: (added, replaced, kept) => `Transfer done: ${added} added, ${replaced} replaced, ${kept} kept as they were.`,
    errors: {},
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
    phraseActive: (when, word) => `Phrase actuelle : active depuis le ${when}, dernier mot : ${word}.`,
    phraseActiveOld: when => `Phrase actuelle : active depuis le ${when}. Elle date d'avant la conservation des copies : elle ne peut pas être affichée.`,
    phraseOverwrite: "Votre phrase actuelle n'est pas demandée. Une fois remplacée, elle n'ouvre plus ce coffre ni le fichier de sauvegarde. Elle reste dans l'historique des phrases, d'où elle peut être réactivée.",
    phraseOverwriteOld: "Votre phrase actuelle n'est pas demandée. Une fois remplacée, elle n'ouvre plus ce coffre ni le fichier de sauvegarde, et c'est irréversible : elle n'a jamais été conservée, seule sa date reste dans l'historique.",
    phraseLeak: "Si vous la remplacez parce qu'elle a fuité : les copies plus anciennes du fichier de sauvegarde s'ouvrent encore avec elle, et la clé maîtresse ne change pas. Supprimez ces copies.",
    phraseConfirm: 'Créer une nouvelle phrase ? oui / non : ',
    phraseShow: 'Notez-la maintenant, en lieu sûr et hors de cet ordinateur :',
    phraseKept: "Une copie scellée reste sur cet ordinateur : elle peut être réaffichée tant que ce coffre s'ouvre. Si l'ordinateur est perdu, il ne reste que ce que vous avez noté.",
    phraseDone: "Appuyez sur Entrée une fois notée : cette fenêtre s'efface.",
    phraseNone: "Aucune phrase de récupération n'a encore été créée.",
    phraseNotKept: "Cette phrase n'a pas été conservée : elle ne peut pas être affichée. Si vous ne l'avez plus, générez-en une nouvelle : l'ancienne n'est pas demandée.",
    phraseScreen: "Vérifiez que personne ne voit votre écran : ni partage d'écran, ni enregistrement. L'affichage est inscrit au journal.",
    phraseShowConfirm: 'Afficher la phrase ? oui / non : ',
    historyActive: (i, when, word) => `${i}. Active depuis le ${when}${word ? `, dernier mot : ${word}` : ''}`,
    historyOld: (i, replaced, word) => `${i}. Remplacée le ${replaced}, ${word ? `dernier mot : ${word}` : 'non conservée'}`,
    historyChoice: 'Numéro de la phrase à afficher, Entrée pour quitter : ',
    historyReactivate: "Réactiver cette phrase ? Elle rouvre ce coffre et le fichier de sauvegarde, et la phrase active aujourd'hui ne les ouvre plus. oui / non : ",
    historyDone: 'Cette phrase est de nouveau active.',
    fileBehind: file => `Le fichier de sauvegarde ${file} n'a pas pu être réécrit : il s'ouvre encore avec la phrase précédente. Il se mettra à jour au prochain changement, dès que cet emplacement sera accessible.`,
    enterClose: 'Entrée pour fermer.',
    transferEmpty: 'Le coffre ne contient aucune clé à transférer.',
    transferOutWhy: count => `Toutes les clés (${count}) sortent de ce coffre dans une seule ligne de texte, protégées uniquement par le mot de passe que vous allez choisir. Quiconque détient les deux peut toutes les lire. L'opération est inscrite au journal.`,
    transferOutConfirm: 'Créer la chaîne ? oui / non : ',
    passwordAsk: "Mot de passe, 12 caractères ou plus. Il n'est stocké nulle part et rien ne peut le retrouver (rien ne s'affiche, Entrée pour valider) : ",
    passwordAgain: 'Le même mot de passe : ',
    passwordDiffer: "Les deux mots de passe sont différents : rien n'a été créé.",
    transferFailed: names => `Ces clés n'ont pas pu être déchiffrées et ne sont pas dans la chaîne : ${names}`,
    transferReady: (count, length) => `Chaîne de transfert prête : ${count} clé(s), ${length} caractères. Sur l'autre machine, copiez-la, puis utilisez Importer une chaîne.`,
    transferAdvice: "Transmettez le mot de passe par un autre canal que la chaîne, et ne collez aucun des deux dans le chat d'un assistant. La chaîne contient les clés telles qu'elles sont maintenant : elle ne suit pas les changements ultérieurs.",
    transferOutChoice: '1 = copier dans le presse-papiers, 2 = enregistrer dans un fichier, Entrée = terminé : ',
    transferCopied: 'Chaîne copiée dans le presse-papiers.',
    transferCopyFailed: "Le presse-papiers n'est pas accessible d'ici : enregistrez-la plutôt dans un fichier.",
    transferSaveAsk: file => `Fichier à écrire, Entrée pour ${file} : `,
    transferSaved: file => `Chaîne enregistrée dans ${file}.`,
    transferFromClipboard: 'Chaîne de transfert trouvée dans le presse-papiers.',
    transferAsk: 'Chemin du fichier .txt qui contient la chaîne, ou la chaîne elle-même, Entrée pour quitter : ',
    transferPassword: "Mot de passe de cette chaîne (rien ne s'affiche, Entrée pour quitter) : ",
    wrongPassword: 'Mot de passe incorrect.',
    previewCreated: when => `Chaîne créée le ${when}.`,
    previewNew: names => `Nouvelles : ${names}`,
    previewConflict: names => `Valeur différente ici : ${names}`,
    previewSame: count => `Déjà ici, même valeur : ${count}`,
    previewExpired: names => `Expirées, non importées : ${names}`,
    previewInvalid: names => `Illisibles, non importées : ${names}`,
    previewMcp: count => `${count} nouvelle(s) clé(s) arrivent déjà autorisées pour MCP, comme sur l'autre machine.`,
    previewBin: days => `Une clé remplacée attend ${days} jours dans la corbeille.`,
    previewKeeps: 'Cet ordinateur garde sa clé maîtresse, ses réglages et ses autres clés.',
    previewNothing: count => `Rien à importer : les ${count} clé(s) de cette chaîne sont déjà ici avec la même valeur.`,
    transferInConfirm: 'Les importer ? oui / non : ',
    transferInChoice: "1 = garder celles d'ici, 2 = prendre celles de la chaîne, Entrée = annuler : ",
    transferInDone: (added, replaced, kept) => `Transfert terminé : ${added} ajoutée(s), ${replaced} remplacée(s), ${kept} gardée(s) telles quelles.`,
    // The vault speaks English: these are the messages this window shows as they are.
    errors: {
      'the password cannot start or end with a space': 'le mot de passe ne peut ni commencer ni finir par une espace',
      'the password needs at least {0} characters': 'le mot de passe doit contenir au moins {0} caractères',
      'this password is too repetitive: use more different characters': 'ce mot de passe est trop répétitif : utilisez des caractères plus variés',
      'this is not a transfer string': "ce n'est pas une chaîne de transfert",
      'this transfer string is incomplete: copy it again, all of it': 'cette chaîne de transfert est incomplète : copiez-la de nouveau, en entier',
      'this transfer string comes from a newer version of the extension': "cette chaîne de transfert vient d'une version plus récente de l'extension",
    },
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

const when = ms => new Date(ms).toLocaleString();

function phraseState(d, T) {
  return d.last ? T.phraseActive(when(d.at), d.last) : T.phraseActiveOld(when(d.at));
}

function sayWords(ui, words, T) {
  ui.say(T.phraseShow);
  ui.say('');
  ui.say('  ' + words.join(' '));
  ui.say('');
}

// The rewrite that failed was silent; what was just written down depends on it.
function warnIfFileBehind({ vault, ui, T }) {
  const st = has(vault, 'exportStatus') ? vault.exportStatus() : null;
  if (st && st.path && st.phraseBehind) ui.say(T.fileBehind(st.path));
}

// The current phrase is not asked for: whoever replaces it has often lost it. What
// protects instead is saying what is being replaced, and that it can be undone.
async function phrase(context) {
  const { vault, ui, T } = context;
  if (!has(vault, 'recoveryEnable')) { ui.say(T.unsupported); return false; }
  ui.say(T.phraseWhy);
  const details = has(vault, 'recoveryDetails') ? vault.recoveryDetails() : null;
  if (vault.recoveryStatus().enabled) {
    if (details && details.at) ui.say(phraseState(details, T));
    ui.say(details && details.canShow ? T.phraseOverwrite : T.phraseOverwriteOld);
    ui.say(T.phraseLeak);
    if ((await ui.ask(T.phraseConfirm)).toLowerCase() !== T.yes) { ui.say(T.cancelled); return false; }
  }
  const made = vault.recoveryEnable();
  sayWords(ui, Array.isArray(made) ? made : [String(made)], T);
  if (details) ui.say(T.phraseKept);
  warnIfFileBehind(context);
  await ui.ask(T.phraseDone);
  ui.clear();
  return true;
}

async function phraseDisplay({ vault, ui, T }) {
  if (!has(vault, 'recoveryDetails')) { ui.say(T.unsupported); return false; }
  const d = vault.recoveryDetails();
  if (!d.enabled) { ui.say(T.phraseNone); return false; }
  ui.say(phraseState(d, T));
  if (!d.canShow) { ui.say(T.phraseNotKept); return false; }
  ui.say(T.phraseScreen);
  if ((await ui.ask(T.phraseShowConfirm)).toLowerCase() !== T.yes) { ui.say(T.cancelled); return false; }
  ui.clear();
  sayWords(ui, vault.recoveryShow(d.id), T);
  await ui.ask(T.phraseDone);
  ui.clear();
  return true;
}

// Earlier phrases still open earlier copies of the backup file, and bringing one
// back undoes a replacement nobody meant to make.
async function phraseHistory(context) {
  const { vault, ui, T } = context;
  if (!has(vault, 'recoveryDetails')) { ui.say(T.unsupported); return false; }
  const { history } = vault.recoveryDetails();
  if (!history.length) { ui.say(T.phraseNone); return false; }
  history.forEach((h, i) => ui.say(h.current
    ? T.historyActive(i + 1, when(h.createdAt), h.last)
    : T.historyOld(i + 1, when(h.replacedAt), h.last)));
  ui.say(T.phraseScreen);
  const h = history[Number(await ui.ask(T.historyChoice)) - 1];
  if (!h) { ui.say(T.cancelled); return false; }
  if (!h.canShow) { ui.say(T.phraseNotKept); return false; }
  ui.clear();
  sayWords(ui, vault.recoveryShow(h.id), T);
  if (h.current) {
    await ui.ask(T.phraseDone);
    ui.clear();
    return true;
  }
  const again = (await ui.ask(T.historyReactivate)).toLowerCase() === T.yes;
  ui.clear();
  if (!again) return true;
  vault.recoveryActivate(h.id);
  ui.say(T.historyDone);
  warnIfFileBehind(context);
  await ui.ask(T.enterClose);
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

// Said in the window's language when it can be, in the vault's English otherwise.
function coreText(e, T) {
  const known = e && e.tpl && T.errors[e.tpl];
  if (!known) return e && e.message ? e.message : String(e);
  return known.replace(/\{(\d+)\}/g, (_, i) => (e.args || [])[i]);
}

async function transferOut({ vault, ui, T }) {
  if (!has(vault, 'transferBuild')) { ui.say(T.unsupported); return false; }
  const count = vault.listFast().filter(k => !k.expired).length;
  if (!count) { ui.say(T.transferEmpty); return false; }
  ui.say(T.transferOutWhy(count));
  if ((await ui.ask(T.transferOutConfirm)).toLowerCase() !== T.yes) { ui.say(T.cancelled); return false; }

  let password = '';
  for (;;) {
    password = await ui.askHidden(T.passwordAsk);
    if (!password) { ui.say(T.cancelled); return false; }
    const weak = vault.transferPasswordIssue(password);
    if (!weak) break;
    ui.say(coreText(weak, T));
  }
  if ((await ui.askHidden(T.passwordAgain)) !== password) { ui.say(T.passwordDiffer); return false; }

  const built = await vault.transferBuild(password);
  if (built.failed.length) ui.say(T.transferFailed(built.failed.join(', ')));
  ui.say(T.transferReady(built.count, built.text.length));
  ui.say(T.transferAdvice);
  for (;;) {
    const choice = await ui.ask(T.transferOutChoice);
    if (choice === '1') {
      ui.say((await ui.copy(built.text)) ? T.transferCopied : T.transferCopyFailed);
    } else if (choice === '2') {
      const fallback = path.join(os.homedir(), 'claude-vault-transfer.txt');
      const file = (await ui.ask(T.transferSaveAsk(fallback))).replace(/^"|"$/g, '') || fallback;
      try {
        fs.writeFileSync(file, built.text, { encoding: 'utf8', mode: 0o600 });
        ui.say(T.transferSaved(file));
      } catch (e) { ui.say(e.message); }
    } else {
      return true;
    }
  }
}

// A person at this prompt gives a path far more often than 20 000 characters.
function stringFrom(typed) {
  const file = typed.replace(/^"|"$/g, '');
  try {
    if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8');
  } catch (e) { /* not a path: the string itself */ }
  return typed;
}

function listed(names) {
  return names.length > 12 ? names.slice(0, 12).join(', ') + ' +' + (names.length - 12) : names.join(', ');
}

async function transferIn({ vault, ui, T }) {
  if (!has(vault, 'transferOpen')) { ui.say(T.unsupported); return false; }
  const isString = text => { try { return vault.transferCheck(text); } catch (e) { return false; } };
  let text = await ui.paste();
  if (isString(text)) {
    ui.say(T.transferFromClipboard);
  } else {
    const typed = await ui.ask(T.transferAsk);
    if (!typed) { ui.say(T.cancelled); return false; }
    text = stringFrom(typed);
    try { vault.transferCheck(text); }
    catch (e) { ui.say(coreText(e, T)); return false; }
  }

  let data = null;
  while (!data) {
    const password = await ui.askHidden(T.transferPassword);
    if (!password) { ui.say(T.cancelled); return false; }
    try { data = await vault.transferOpen(text, password); }
    catch (e) {
      if (!e.wrongPassword) throw e;
      ui.say(T.wrongPassword);
    }
  }

  const p = vault.transferPreview(data);
  if (!p.fresh.length && !p.conflicts.length) { ui.say(T.previewNothing(p.same.length)); return false; }
  ui.say(T.previewCreated(when(p.at)));
  if (p.fresh.length) ui.say(T.previewNew(listed(p.fresh)));
  if (p.conflicts.length) ui.say(T.previewConflict(listed(p.conflicts)));
  if (p.same.length) ui.say(T.previewSame(p.same.length));
  if (p.expired.length) ui.say(T.previewExpired(listed(p.expired)));
  if (p.invalid.length) ui.say(T.previewInvalid(listed(p.invalid)));
  if (p.mcp) ui.say(T.previewMcp(p.mcp));
  if (p.conflicts.length) ui.say(T.previewBin(vault.TRASH_DAYS || 30));
  ui.say(T.previewKeeps);

  let side = 'keep';
  if (p.conflicts.length) {
    const choice = await ui.ask(T.transferInChoice);
    if (choice !== '1' && choice !== '2') { ui.say(T.cancelled); return false; }
    side = choice === '2' ? 'replace' : 'keep';
  } else if ((await ui.ask(T.transferInConfirm)).toLowerCase() !== T.yes) {
    ui.say(T.cancelled);
    return false;
  }
  const r = vault.transferApply(data, side);
  ui.say(T.transferInDone(r.added, r.replaced, r.kept + r.same));
  return r.added + r.replaced > 0;
}

module.exports = {
  TEXTS, status, replace, mcpRequest, use, remove, mcpKey, bin, phrase, restore,
  phraseDisplay, phraseHistory, transferOut, transferIn,
};
