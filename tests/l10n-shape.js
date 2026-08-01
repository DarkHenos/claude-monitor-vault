// A translation that lost its accents reads as broken to the person it was
// written for, and nothing else catches it: the bundles stay aligned, every
// placeholder is present, every test passes. Twenty entries shipped that way
// before someone looking at the settings page said so.
//
// This checks the shape of the translations rather than their presence:
// diacritics where the language requires them, apostrophes where French elides,
// and placeholders that survived the trip.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => results.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  → ' + x : ''));

const LANGS = ['fr', 'es', 'pt', 'de'];
const DIACRITICS = {
  fr: /[àâçéèêëîïôùûüÀÂÇÉÈÊËÎÏÔÙÛÜ]/,
  es: /[áéíóúñüÁÉÍÓÚÑ¿¡]/,
  pt: /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/,
  de: /[äöüßÄÖÜ]/
};

// Words that carry a diacritic in that language, always. A value holding one of
// them in bare ASCII, and no diacritic anywhere else, has lost them.
const NEEDS = {
  fr: /\b(cle|cles|acces|cree|creee|creer|reglage|reglages|chiffre|chiffree|reecrit|perime|deplace|memorise|securite|verifie|apres|derniere|premiere|systeme|etat|deja|operation|etait|ete|ecrit|revocation|expiree)\b/i,
  es: /\b(maquina|maquinas|dia|dias|asi|aqui|unico|unica|recuperacion|operacion|configuracion|informacion|version|codigo|ultimo|estan|Todavia|Aun|Anade|escribio|numero)\b/,
  pt: /\b(nao|definicoes|informacao|configuracao|versao|maquina|ultimo|codigo|proprio|estao|alteracao|sitio|recuperacao|unico|unica|ilegiveis|reversivel|salvaguardas)\b/,
  de: /(oeffn|aendern|Aenderung|schluessel|Schluessel|verschluessel|zurueck|fuer|ueberall|laesst|geloescht|beschaedigt|waehrend|koennen|muessen)/
};

// French elides before a vowel: a bare "l apostrophe" means the mark was lost.
// The opening character is spelled out rather than using \b, because JavaScript
// does not count an accented letter as a word character: \b would find a
// boundary inside "Effacée" and read its final "e" as a word of its own, so
// "Effacée après" looked like a missing apostrophe.
const FR_ELISION = /(^|[\s('"«])([dlncsjmt]|qu|jusqu|lorsqu) [aeiouyhàâéèêîïôûAEIOUY]/;

const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.json'), 'utf8'));
check('the source bundle loads', Object.keys(en).length > 0, Object.keys(en).length + ' entries');

for (const l of LANGS) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'bundle.l10n.' + l + '.json'), 'utf8'));

  const stripped = Object.entries(j).filter(([, v]) =>
    typeof v === 'string' && !DIACRITICS[l].test(v) && NEEDS[l].test(v));
  check(l + ': no translation lost its diacritics', stripped.length === 0,
    stripped.length ? stripped.map(([, v]) => v.slice(0, 50)).join(' | ') : Object.keys(j).length + ' entries');

  if (l === 'fr') {
    const elided = Object.entries(j).filter(([, v]) =>
      typeof v === 'string' && FR_ELISION.test(v));
    check('fr: no elision lost its apostrophe', elided.length === 0,
      elided.length ? elided.map(([, v]) => v.slice(0, 50)).join(' | ') : 'clean');
  }

  // A value identical to its English key is a string nobody translated. Short
  // ones are legitimately identical, "Copy" is "Copy" in no language but proper
  // nouns and abbreviations are, so only sentences count here. One shipped that
  // way and only showed up when someone looked at the settings page.
  const untranslated = Object.keys(en).filter(k => j[k] === k && k.length > 25);
  check(l + ': no sentence left untranslated', untranslated.length === 0,
    untranslated.map(k => k.slice(0, 60)).join(' | '));

  // A placeholder dropped in translation prints a raw {0} or, worse, nothing.
  const holes = [];
  for (const [k, v] of Object.entries(j)) {
    if (typeof v !== 'string' || !(k in en)) continue;
    const want = (k.match(/\{\d\}/g) || []).sort().join(',');
    const got = (v.match(/\{\d\}/g) || []).sort().join(',');
    if (want !== got) holes.push(k.slice(0, 40) + ' [' + want + ' vs ' + got + ']');
  }
  check(l + ': every placeholder survived translation', holes.length === 0, holes.join(' | '));
}

// The em dash is banned from anything shipped, interface included.
for (const f of ['l10n/bundle.l10n.json', 'l10n/bundle.l10n.fr.json', 'l10n/bundle.l10n.es.json',
                 'l10n/bundle.l10n.pt.json', 'l10n/bundle.l10n.de.json',
                 'README.md', 'CHANGELOG.md']) {
  const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
  check('no em dash in ' + f, txt.indexOf('—') === -1);
}

console.log(results.join('\n'));
const pass = results.filter(r => r.startsWith('PASS')).length;
console.log('\n' + pass + ' OK, ' + (results.length - pass) + ' FAIL');
process.exit(pass === results.length ? 0 : 1);
