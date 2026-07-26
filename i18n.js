// Translation, independent of the VS Code display language.
//
// vscode.l10n resolves its bundle once, at activation, from the editor's own
// language. That is fine for an extension that only ever follows the editor,
// but it makes an in-extension language picker impossible: nothing can change
// what l10n.t() returns while VS Code is running.
//
// So we read the same bundles ourselves. Same files, same keys, same {0}
// substitution; the difference is that the choice belongs to this extension and
// takes effect immediately, without reloading anything.
//
// One thing stays outside our reach: the strings declared in package.json
// (command titles, settings descriptions). VS Code resolves those from
// package.nls.<lang>.json before the extension is even loaded, so the command
// palette follows the editor, not this setting.

'use strict';

const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'fr', 'es', 'de', 'pt'];
const NAMES = { en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch', pt: 'Português' };
const DIR = path.join(__dirname, 'l10n');

let bundle = {};
let code = 'en';

// 'auto' means: follow the editor. Anything unknown, including a locale we do
// not translate, falls back to English rather than to a half translated view.
function normalize(want, editorLanguage) {
  const raw = String(want === 'auto' || !want ? (editorLanguage || 'en') : want).toLowerCase();
  const base = raw.split(/[-_]/)[0];
  return LANGS.indexOf(base) === -1 ? 'en' : base;
}

function load(want, editorLanguage) {
  code = normalize(want, editorLanguage);
  bundle = {};
  if (code === 'en') return code;      // English is the source, no bundle needed
  try {
    bundle = JSON.parse(fs.readFileSync(path.join(DIR, 'bundle.l10n.' + code + '.json'), 'utf8'));
  } catch (e) {
    // A missing or broken bundle must not take the interface down with it:
    // English is always readable, an exception is not.
    bundle = {};
    code = 'en';
  }
  return code;
}

// Same contract as vscode.l10n.t: the English source string is the key, {0} and
// {1} are positional. An argument that is not supplied leaves its placeholder
// alone rather than printing "undefined".
function t(message, ...args) {
  const src = String(message);
  const out = bundle[src] !== undefined ? bundle[src] : src;
  if (!args.length) return out;
  return out.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
}

function current() { return code; }
function name(c) { return NAMES[c] || c; }

module.exports = { load, t, current, name, LANGS, NAMES };
