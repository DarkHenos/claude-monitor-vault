// The part of the VS Code API this extension uses, rebuilt for another IDE.
//
// extension.js, companion/ and vault/ are loaded unchanged: require('vscode')
// lands here instead of in VS Code. Everything that has no screen to show
// (configuration, mementos, events, URIs, commands) is implemented in this
// process. Everything the user sees or answers (messages, pickers, input boxes,
// webviews, the status bar, terminals, editors) is a request to the IDE over
// the JSON-RPC connection, and the IDE draws it with its own components.
//
// Scope is deliberate: this is the surface the extension calls today, checked
// by tests/host-shim.js. A new vscode.* call in the extension must be added
// here too, or it throws in the other IDE while working in VS Code.

'use strict';

const fs = require('fs');
const path = require('path');

let rpc = null;
let host = null;          // what the IDE told us at initialize
let root = null;          // the extension folder
let pkg = null;

// ------------------------------------------------------------------ basics

class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() {
    const f = this._fn;
    this._fn = null;
    if (f) f();
  }
  static from(...items) {
    return new Disposable(() => {
      for (const d of items) { try { if (d && d.dispose) d.dispose(); } catch (e) { /* keep going */ } }
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const l = thisArg ? listener.bind(thisArg) : listener;
      this._listeners.add(l);
      const d = new Disposable(() => this._listeners.delete(l));
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(data) {
    for (const l of Array.from(this._listeners)) {
      try { l(data); } catch (e) { console.error('[host] listener failed:', e); }
    }
  }
  dispose() { this._listeners.clear(); }
}

const isWin = process.platform === 'win32';

class Uri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = p || '/';
    this.query = query || '';
    this.fragment = fragment || '';
  }
  get fsPath() {
    if (this.scheme !== 'file') return this.path;
    let p = this.path;
    if (isWin) {
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      p = p.replace(/\//g, '\\');
    }
    return p;
  }
  with(change) {
    const c = change || {};
    return new Uri(c.scheme !== undefined ? c.scheme : this.scheme,
      c.authority !== undefined ? c.authority : this.authority,
      c.path !== undefined ? c.path : this.path,
      c.query !== undefined ? c.query : this.query,
      c.fragment !== undefined ? c.fragment : this.fragment);
  }
  toString() {
    return this.scheme + ':' + (this.authority || this.scheme === 'file' ? '//' + this.authority : '') +
      this.path + (this.query ? '?' + this.query : '') + (this.fragment ? '#' + this.fragment : '');
  }
  toJSON() { return this.toString(); }
  static file(p) {
    let s = String(p).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(s)) s = '/' + s;
    if (!s.startsWith('/')) s = '/' + s;
    return new Uri('file', '', s);
  }
  static parse(value) {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
    if (!m) return Uri.file(value);
    return new Uri(m[1], m[2] || '', m[3] || '/', m[4] || '', m[5] || '');
  }
  static joinPath(base, ...parts) {
    return base.with({ path: path.posix.join(base.path, ...parts.map(x => String(x).replace(/\\/g, '/'))) });
  }
  static isUri(x) { return x instanceof Uri; }
}

class ThemeColor { constructor(id) { this.id = id; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class MarkdownString {
  constructor(value, supportThemeIcons) {
    this.value = value || '';
    this.supportThemeIcons = !!supportThemeIcons;
    this.isTrusted = false;
    this.supportHtml = false;
  }
  appendMarkdown(v) { this.value += v; return this; }
  appendText(v) { this.value += String(v).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&'); return this; }
  appendCodeblock(code, lang) { this.value += '\n```' + (lang || '') + '\n' + code + '\n```\n'; return this; }
}

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(a, b) {
    if (a && typeof a === 'object') return new Position(this.line + (a.lineDelta || 0), this.character + (a.characterDelta || 0));
    return new Position(this.line + (a || 0), this.character + (b || 0));
  }
  with(a, b) {
    if (a && typeof a === 'object') return new Position(a.line !== undefined ? a.line : this.line, a.character !== undefined ? a.character : this.character);
    return new Position(a !== undefined ? a : this.line, b !== undefined ? b : this.character);
  }
  isEqual(o) { return o && o.line === this.line && o.character === this.character; }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
  get isEmpty() { return this.start.isEqual(this.end); }
}

class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}

class SnippetString { constructor(value) { this.value = value || ''; } }

class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }

const CompletionItemKind = { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
  Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13,
  Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20,
  Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const QuickPickItemKind = { Separator: -1, Default: 0 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const UIKind = { Desktop: 1, Web: 2 };
const InputBoxValidationSeverity = { Info: 1, Warning: 2, Error: 3 };

// ------------------------------------------------------------ JSON files

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Atomic, like the extension's own cache: several projects run one host each,
// and a reader must never see half a file.
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch (e) { fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } }
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// globalState and workspaceState. One host runs per open project, and they all
// share globalState: every write re-reads the file and changes only its own
// key, so two windows cannot erase each other's values.
class Memento {
  constructor(file) {
    this._file = file;
    this._stamp = '';
    this._data = {};
    this._load();
  }
  _load() {
    let st = null;
    try { st = fs.statSync(this._file); } catch (e) { this._data = {}; this._stamp = ''; return; }
    const stamp = st.mtimeMs + ':' + st.size;
    if (stamp === this._stamp) return;
    this._data = readJson(this._file, {}) || {};
    this._stamp = stamp;
  }
  keys() { this._load(); return Object.keys(this._data); }
  get(key, def) {
    this._load();
    return Object.prototype.hasOwnProperty.call(this._data, key) ? clone(this._data[key]) : def;
  }
  update(key, value) {
    this._stamp = '';
    this._load();
    if (value === undefined) delete this._data[key];
    else this._data[key] = clone(value);
    try { writeJson(this._file, this._data); } catch (e) { return Promise.reject(e); }
    this._stamp = '';
    return Promise.resolve();
  }
  setKeysForSync() { /* no settings sync outside VS Code */ }
}

// ---------------------------------------------------------- configuration
//
// settings.json, one per IDE installation, flat keys as in VS Code's own file.
// The IDE's settings page writes the same file: it is watched, and a change
// made there reaches onDidChangeConfiguration like one made from here.

const configChanged = new EventEmitter();
let settingsFile = null;
let settings = {};
let defaults = {};

function loadDefaults() {
  defaults = {};
  const props = (((pkg || {}).contributes || {}).configuration || {}).properties || {};
  for (const k of Object.keys(props)) if (props[k].default !== undefined) defaults[k] = props[k].default;
  // Read by the status bar pill colour flow. No theme name: the colours it
  // writes then apply to every theme, which is the only honest scope here.
  defaults['workbench.colorTheme'] = '';
  defaults['workbench.colorCustomizations'] = {};
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function fireConfig(keys) {
  if (!keys.length) return;
  configChanged.fire({
    affectsConfiguration: section => keys.some(k => k === section || k.startsWith(section + '.'))
  });
}

function reloadSettings() {
  const next = readJson(settingsFile, {}) || {};
  const keys = changedKeys(settings, next);
  settings = next;
  fireConfig(keys);
}

let settingsWatch = null;
function watchSettings() {
  let timer = null;
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    settingsWatch = fs.watch(path.dirname(settingsFile), (ev, name) => {
      if (name && name !== path.basename(settingsFile)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reloadSettings(); }, 150);
    });
    settingsWatch.on('error', () => { try { settingsWatch.close(); } catch (e) { /* gone */ } settingsWatch = null; });
  } catch (e) { /* no watch: changes made here still apply */ }
}

function getConfiguration(section) {
  const full = key => (section ? section + '.' + key : key);
  return {
    get(key, def) {
      const k = full(key);
      if (Object.prototype.hasOwnProperty.call(settings, k)) return clone(settings[k]);
      if (Object.prototype.hasOwnProperty.call(defaults, k)) return clone(defaults[k]);
      return def;
    },
    has(key) {
      const k = full(key);
      return Object.prototype.hasOwnProperty.call(settings, k) || Object.prototype.hasOwnProperty.call(defaults, k);
    },
    inspect(key) {
      const k = full(key);
      return { key: k, defaultValue: clone(defaults[k]), globalValue: clone(settings[k]) };
    },
    update(key, value) {
      const k = full(key);
      const before = settings;
      const next = Object.assign({}, readJson(settingsFile, {}) || {});
      if (value === undefined || value === null) delete next[k];
      else next[k] = clone(value);
      try { writeJson(settingsFile, next); } catch (e) { return Promise.reject(e); }
      settings = next;
      fireConfig(changedKeys(before, next));
      return Promise.resolve();
    }
  };
}

// --------------------------------------------------------------- display

// Codicons ($(name)) are VS Code's icon font. The IDE has its own icon next to
// the status text, so they are dropped, except the warning sign which carries
// meaning on its own.
function stripIcons(s) {
  return String(s == null ? '' : s)
    .replace(/\$\(warning\)/g, '⚠')
    .replace(/\$\([a-z0-9-]+(?:~[a-z]+)?\)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

// The markdown the extension writes in tooltips: bold, italics, rules and
// paragraphs. Turned into the HTML Swing tooltips understand.
function markdownToHtml(md) {
  let s = escHtml(stripIcons(md));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,])/g, '$1<i>$2</i>');
  s = s.replace(/\n*\n---\n\n*/g, '<hr>');
  s = s.replace(/\n\n/g, '<br>').replace(/\n/g, '<br>');
  return s;
}

function tooltipOf(t) {
  if (!t) return null;
  if (typeof t === 'string') return escHtml(stripIcons(t)).replace(/\n/g, '<br>');
  if (typeof t.value === 'string') return markdownToHtml(t.value);
  return null;
}

// A theme colour id, a colour the user wrote over it in
// workbench.colorCustomizations, or a literal. The IDE maps ids to its theme.
function colorOf(c) {
  if (!c) return null;
  const id = typeof c === 'string' ? c : c.id;
  if (!id) return null;
  if (id.startsWith('#')) return id;
  const custom = getConfiguration('workbench').get('colorCustomizations') || {};
  if (typeof custom[id] === 'string') return custom[id];
  return id;
}

// ---------------------------------------------------------------- messages

function showMessage(severity, message, ...rest) {
  let options = {};
  if (rest.length && rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) options = rest.shift();
  const items = rest.filter(x => x !== undefined && x !== null);
  const labels = items.map(i => (typeof i === 'string' ? i : String(i.title)));
  return rpc.request('window.showMessage', {
    severity, message: String(message), modal: !!options.modal,
    detail: options.detail ? String(options.detail) : null, items: labels
  }).then(i => (typeof i === 'number' && i >= 0 && i < items.length ? items[i] : undefined), () => undefined);
}

async function showQuickPick(items, options, token) {
  const opts = options || {};
  const list = await Promise.resolve(items);
  if (!Array.isArray(list) || !list.length) return undefined;
  const sent = list.map(it => {
    const o = typeof it === 'string' ? { label: it } : (it || {});
    return {
      label: stripIcons(o.label), description: stripIcons(o.description || ''), detail: stripIcons(o.detail || ''),
      separator: o.kind === QuickPickItemKind.Separator, picked: !!o.picked
    };
  });
  let res;
  try {
    res = await rpc.request('window.showQuickPick', {
      items: sent, title: opts.title || null, placeHolder: opts.placeHolder || null,
      canPickMany: !!opts.canPickMany, matchOnDescription: !!opts.matchOnDescription,
      matchOnDetail: !!opts.matchOnDetail
    });
  } catch (e) { return undefined; }
  if (res === null || res === undefined) return undefined;
  if (opts.canPickMany) return (Array.isArray(res) ? res : []).filter(i => list[i] !== undefined).map(i => list[i]);
  return list[res];
}

// validateInput runs here, in the extension's own code. The IDE asks for it on
// every keystroke (input.validate), and the final value is checked once more
// before it is handed back, so a dialog that skipped a check cannot let an
// invalid value through.
const validators = new Map();
let nextToken = 1;

async function runValidator(fn, value) {
  try {
    let r = await fn(value);
    if (r && typeof r === 'object') r = r.message;
    return r ? String(r) : null;
  } catch (e) { return null; }
}

async function showInputBox(options) {
  const opts = options || {};
  const token = String(nextToken++);
  const validate = typeof opts.validateInput === 'function' ? opts.validateInput : null;
  if (validate) validators.set(token, validate);
  let value = opts.value === undefined ? '' : String(opts.value);
  let error = null;
  try {
    for (;;) {
      let res;
      try {
        res = await rpc.request('window.showInputBox', {
          token, title: opts.title || null, prompt: opts.prompt || null, value,
          placeHolder: opts.placeHolder || null, password: !!opts.password,
          validate: !!validate, error
        });
      } catch (e) { return undefined; }
      if (res === null || res === undefined) return undefined;
      res = String(res);
      if (validate) {
        const msg = await runValidator(validate, res);
        if (msg) { value = res; error = msg; continue; }
      }
      return res;
    }
  } finally { validators.delete(token); }
}

async function showOpenDialog(options) {
  const o = options || {};
  try {
    const paths = await rpc.request('window.showOpenDialog', {
      canSelectMany: !!o.canSelectMany, canSelectFiles: o.canSelectFiles !== false,
      canSelectFolders: !!o.canSelectFolders, filters: o.filters || null,
      title: o.title || o.openLabel || null, defaultPath: o.defaultUri ? o.defaultUri.fsPath : null
    });
    return Array.isArray(paths) && paths.length ? paths.map(p => Uri.file(p)) : undefined;
  } catch (e) { return undefined; }
}

async function showSaveDialog(options) {
  const o = options || {};
  try {
    const p = await rpc.request('window.showSaveDialog', {
      filters: o.filters || null, title: o.title || o.saveLabel || null,
      defaultPath: o.defaultUri ? o.defaultUri.fsPath : null
    });
    return p ? Uri.file(p) : undefined;
  } catch (e) { return undefined; }
}

// ---------------------------------------------------------------- webviews

const webviews = new Map();        // id -> Webview
let nextPanel = 1;

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.css': 'text/css', '.js': 'text/javascript' }[ext] || 'application/octet-stream';
  try { return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64'); } catch (e) { return ''; }
}

class Webview {
  constructor(id) {
    this._id = id;
    this._html = '';
    this._msg = new EventEmitter();
    this.onDidReceiveMessage = this._msg.event;
    this.options = {};
    // Local resources are inlined as data: URIs (asWebviewUri), so this is what
    // a page's CSP has to allow for them.
    this.cspSource = 'data:';
  }
  get html() { return this._html; }
  set html(v) {
    this._html = String(v);
    rpc.notify('webview.setHtml', { id: this._id, html: this._html });
  }
  postMessage(message) {
    rpc.notify('webview.post', { id: this._id, message: message === undefined ? null : message });
    return Promise.resolve(true);
  }
  asWebviewUri(uri) {
    const s = uri && uri.scheme === 'file' ? dataUri(uri.fsPath) : String(uri);
    return { scheme: 'data', toString: () => s, toJSON: () => s };
  }
}

class WebviewView {
  constructor(viewType) {
    this.viewType = viewType;
    this.webview = new Webview(viewType);
    webviews.set(viewType, this.webview);
    this._visible = false;
    this._vis = new EventEmitter();
    this.onDidChangeVisibility = this._vis.event;
    this._disp = new EventEmitter();
    this.onDidDispose = this._disp.event;
    this._title = undefined;
    this._description = undefined;
    this._badge = undefined;
  }
  get visible() { return this._visible; }
  get title() { return this._title; }
  set title(v) { this._title = v; this._update(); }
  get description() { return this._description; }
  set description(v) { if (v === this._description) return; this._description = v; this._update(); }
  get badge() { return this._badge; }
  set badge(v) {
    if (JSON.stringify(v || null) === JSON.stringify(this._badge || null)) return;
    this._badge = v; this._update();
  }
  _update() {
    rpc.notify('view.update', { id: this.viewType, title: this._title || null,
      description: this._description || null, badge: this._badge ? { value: this._badge.value, tooltip: this._badge.tooltip || '' } : null });
  }
  show() { rpc.notify('view.focus', { id: this.viewType }); }
}

class WebviewPanel {
  constructor(viewType, title, options) {
    this.viewType = viewType;
    this._id = 'panel:' + (nextPanel++);
    this.webview = new Webview(this._id);
    this.webview.options = options || {};
    webviews.set(this._id, this.webview);
    this._title = title;
    this._disposed = false;
    this._disp = new EventEmitter();
    this.onDidDispose = this._disp.event;
    this._state = new EventEmitter();
    this.onDidChangeViewState = this._state.event;
    this.visible = true;
    this.active = true;
    rpc.notify('panel.create', { id: this._id, viewType, title: String(title || '') });
  }
  get title() { return this._title; }
  set title(v) { this._title = v; rpc.notify('panel.update', { id: this._id, title: String(v || '') }); }
  reveal() { if (!this._disposed) rpc.notify('panel.reveal', { id: this._id }); }
  dispose() {
    if (this._disposed) return;
    rpc.notify('panel.dispose', { id: this._id });
    this._closed();
  }
  _closed() {
    if (this._disposed) return;
    this._disposed = true;
    webviews.delete(this._id);
    panels.delete(this._id);
    this._disp.fire();
  }
}

const panels = new Map();          // id -> WebviewPanel
const viewProviders = new Map();   // view id -> provider
const views = new Map();           // view id -> WebviewView

function createWebviewPanel(viewType, title, showOptions, options) {
  const p = new WebviewPanel(viewType, title, options);
  panels.set(p._id, p);
  return p;
}

function registerWebviewViewProvider(viewId, provider) {
  viewProviders.set(viewId, provider);
  return new Disposable(() => viewProviders.delete(viewId));
}

// The IDE has ONE tool window. VS Code's twin ids (left side bar, secondary
// side bar) both resolve to it.
function resolveView(id) {
  let provider = viewProviders.get(id);
  if (!provider) {
    for (const [k, p] of viewProviders) { if (k.endsWith('.panel')) { provider = p; break; } }
  }
  if (!provider) throw new Error('no view provider for ' + id);
  let view = views.get(id);
  if (!view) { view = new WebviewView(id); views.set(id, view); }
  view._visible = true;
  provider.resolveWebviewView(view, { state: undefined },
    { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) });
  return true;
}

// A tree view the extension keeps only for its badge and description, next to
// the panel in VS Code. Here those two land on the same tool window.
function createTreeView(id) {
  const vis = new EventEmitter();
  const state = { description: undefined, badge: undefined, title: undefined, message: undefined };
  const push = () => rpc.notify('view.update', { id, title: null, description: state.description || null,
    badge: state.badge ? { value: state.badge.value, tooltip: state.badge.tooltip || '' } : null });
  return {
    get description() { return state.description; },
    set description(v) { if (v === state.description) return; state.description = v; push(); },
    get badge() { return state.badge; },
    set badge(v) {
      if (JSON.stringify(v || null) === JSON.stringify(state.badge || null)) return;
      state.badge = v; push();
    },
    get title() { return state.title; }, set title(v) { state.title = v; },
    get message() { return state.message; }, set message(v) { state.message = v; },
    visible: false,
    onDidChangeVisibility: vis.event,
    onDidChangeSelection: new EventEmitter().event,
    onDidExpandElement: new EventEmitter().event,
    onDidCollapseElement: new EventEmitter().event,
    reveal: () => Promise.resolve(),
    dispose() { vis.dispose(); }
  };
}

// -------------------------------------------------------------- status bar

let nextStatus = 1;

class StatusBarItem {
  constructor(alignment, priority, id) {
    this._id = 'status:' + (id || nextStatus++);
    this.alignment = alignment;
    this.priority = priority;
    this._s = { text: '', tooltip: undefined, color: undefined, backgroundColor: undefined, command: undefined, name: undefined };
    this._visible = false;
    this._queued = false;
    this._disposed = false;
  }
  _dirty() {
    if (this._queued || this._disposed) return;
    this._queued = true;
    queueMicrotask(() => {
      this._queued = false;
      if (this._disposed) return;
      const s = this._s;
      const bg = colorOf(s.backgroundColor);
      let fg = colorOf(s.color);
      // A background slot comes with its own foreground in VS Code.
      if (s.backgroundColor && s.backgroundColor.id) fg = colorOf(s.backgroundColor.id.replace(/Background$/, 'Foreground'));
      const cmd = typeof s.command === 'string' ? s.command : (s.command && s.command.command) || null;
      rpc.notify('statusBar.update', {
        id: this._id, visible: this._visible, text: stripIcons(s.text), tooltip: tooltipOf(s.tooltip),
        color: fg, background: bg, command: cmd, name: s.name || null
      });
    });
  }
  show() { this._visible = true; this._dirty(); }
  hide() { this._visible = false; this._dirty(); }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    rpc.notify('statusBar.dispose', { id: this._id });
  }
}
for (const k of ['text', 'tooltip', 'color', 'backgroundColor', 'command', 'name', 'accessibilityInformation']) {
  Object.defineProperty(StatusBarItem.prototype, k, {
    get() { return this._s[k]; },
    set(v) { if (this._s[k] === v) return; this._s[k] = v; this._dirty(); }
  });
}

function createStatusBarItem(a, b, c) {
  // (alignment, priority) or (id, alignment, priority)
  if (typeof a === 'string') return new StatusBarItem(b, c, a);
  return new StatusBarItem(a, b);
}

function setStatusBarMessage(text, hide) {
  rpc.notify('statusBar.message', { text: stripIcons(text), timeout: typeof hide === 'number' ? hide : 0 });
  const d = new Disposable(() => rpc.notify('statusBar.message', { text: '', timeout: 0 }));
  if (hide && typeof hide.then === 'function') hide.then(() => d.dispose(), () => d.dispose());
  return d;
}

// --------------------------------------------------------------- terminals

const terminals = [];
let activeTerminal;
let nextTerminal = 1;
const terminalOpened = new EventEmitter();
const terminalClosed = new EventEmitter();
const terminalActive = new EventEmitter();

function createTerminal(a, b, c) {
  const opts = a && typeof a === 'object' ? a : { name: a, shellPath: b, shellArgs: c };
  const id = 'terminal:' + (nextTerminal++);
  const cwd = opts.cwd ? (typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath) : workspaceRoot();
  const args = Array.isArray(opts.shellArgs) ? opts.shellArgs.map(String) : (opts.shellArgs ? [String(opts.shellArgs)] : []);
  const env = opts.env && Object.keys(opts.env).length ? opts.env : null;
  let command = null;
  if (env) {
    // The IDE's terminal takes a command line but no environment, so a small
    // launcher sets it. The values here are vault markers, never secrets:
    // env.js resolves them inside the terminal process.
    const spec = { command: opts.shellPath || host.shell || process.env.COMSPEC || '/bin/sh', args: opts.shellPath ? args : [], env, cwd };
    command = [process.execPath, path.join(__dirname, 'launch.js'), Buffer.from(JSON.stringify(spec), 'utf8').toString('base64')];
  } else if (opts.shellPath) {
    command = [opts.shellPath, ...args];
  }
  const term = {
    name: opts.name || 'Terminal',
    creationOptions: Object.freeze(Object.assign({}, opts)),
    processId: Promise.resolve(undefined),
    exitStatus: undefined,
    state: { isInteractedWith: false },
    show() { rpc.notify('terminal.show', { id }); },
    hide() {},
    sendText(text, addNewLine) {
      rpc.notify('terminal.sendText', { id, text: String(text) + (addNewLine === false ? '' : '\r') });
    },
    dispose() { rpc.notify('terminal.dispose', { id }); closeTerminal(id); }
  };
  term._id = id;
  terminals.push(term);
  activeTerminal = term;
  rpc.notify('terminal.create', { id, name: term.name, cwd, command });
  terminalOpened.fire(term);
  terminalActive.fire(term);
  return term;
}

function closeTerminal(id) {
  const i = terminals.findIndex(t => t._id === id);
  if (i === -1) return;
  const [term] = terminals.splice(i, 1);
  if (activeTerminal === term) { activeTerminal = terminals[terminals.length - 1]; terminalActive.fire(activeTerminal); }
  terminalClosed.fire(term);
}

// --------------------------------------------------------------- documents

const contentProviders = new Map();   // scheme -> provider
const docSaved = new EventEmitter();
let untitled = 1;

function makeDoc(uri, text, languageId, isUntitled) {
  const lines = () => String(text).split(/\r?\n/);
  return {
    uri, fileName: uri.fsPath, languageId: languageId || 'plaintext', isUntitled: !!isUntitled,
    isDirty: false, isClosed: false, version: 1, eol: 1,
    get lineCount() { return lines().length; },
    getText() { return String(text); },
    lineAt(at) {
      const n = typeof at === 'number' ? at : at.line;
      const t = lines()[n] || '';
      return { lineNumber: n, text: t, range: new Range(n, 0, n, t.length), isEmptyOrWhitespace: !t.trim() };
    },
    save: () => Promise.resolve(false)
  };
}

async function openTextDocument(arg) {
  if (arg && typeof arg === 'object' && !(arg instanceof Uri) && !arg.scheme) {
    const content = arg.content === undefined ? '' : String(arg.content);
    return makeDoc(new Uri('untitled', '', '/Untitled-' + (untitled++)), content, arg.language, true);
  }
  const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
  if (uri.scheme === 'file') return makeDoc(uri, fs.readFileSync(uri.fsPath, 'utf8'));
  const p = contentProviders.get(uri.scheme);
  const text = p ? await p.provideTextDocumentContent(uri, { isCancellationRequested: false }) : '';
  return makeDoc(uri, text || '');
}

async function showTextDocument(docOrUri) {
  const doc = docOrUri instanceof Uri ? await openTextDocument(docOrUri) : docOrUri;
  if (doc.uri.scheme === 'file') {
    rpc.notify('editor.openFile', { path: doc.uri.fsPath });
  } else {
    const first = doc.getText().split(/\r?\n/).find(l => l.trim()) || 'Untitled';
    rpc.notify('editor.openText', { title: first.trim().slice(0, 60), content: doc.getText(), language: doc.languageId });
  }
  return { document: doc, selection: undefined, viewColumn: 1 };
}

async function textOf(uri) {
  if (uri.scheme === 'file') { try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch (e) { return ''; } }
  const p = contentProviders.get(uri.scheme);
  return p ? String((await p.provideTextDocumentContent(uri, { isCancellationRequested: false })) || '') : '';
}

// ------------------------------------------------------------- completion

const completionProviders = [];

async function provideCompletion(params) {
  const p = params || {};
  const line = Number(p.line) || 0;
  const character = Number(p.character) || 0;
  const lineText = String(p.lineText || '');
  const lines = [];
  lines[line] = lineText;
  const doc = makeDoc(Uri.file(p.path || 'untitled'), lines.map(l => l || '').join('\n'), p.languageId);
  const pos = new Position(line, character);
  const out = [];
  for (const { provider } of completionProviders) {
    let items;
    try { items = await provider.provideCompletionItems(doc, pos, { isCancellationRequested: false }, { triggerKind: 0 }); }
    catch (e) { continue; }
    if (items && !Array.isArray(items)) items = items.items;
    for (const it of items || []) {
      const label = typeof it.label === 'string' ? it.label : (it.label && it.label.label) || '';
      const insert = it.insertText === undefined ? label : (typeof it.insertText === 'string' ? it.insertText : it.insertText.value);
      const r = it.range ? (it.range.start ? it.range : it.range.inserting) : null;
      out.push({
        label, insertText: insert, filterText: it.filterText || label, detail: it.detail || '',
        documentation: it.documentation ? (typeof it.documentation === 'string' ? it.documentation : it.documentation.value) : '',
        replaceStart: r ? r.start.character : character, replaceEnd: r ? r.end.character : character
      });
    }
  }
  return out;
}

// --------------------------------------------------------------- commands

const commands = new Map();

function registerCommand(id, fn, thisArg) {
  commands.set(id, thisArg ? fn.bind(thisArg) : fn);
  return new Disposable(() => { if (commands.get(id)) commands.delete(id); });
}

async function executeCommand(id, ...args) {
  const fn = commands.get(id);
  if (fn) return fn(...args);
  if (id === 'setContext') return undefined;
  if (/\.focus$/.test(id)) { rpc.notify('view.focus', { id: id.replace(/\.focus$/, '') }); return undefined; }
  if (id === 'vscode.diff') {
    const [left, right, title] = args;
    const label = u => {
      const parts = u.path.split('/').filter(Boolean);
      return parts.length > 2 ? parts[1] + ' · ' + parts.slice(2).join('/') : parts.join('/');
    };
    rpc.notify('editor.diff', { title: String(title || ''), left: await textOf(left), right: await textOf(right),
      leftTitle: label(left), rightTitle: label(right) });
    return undefined;
  }
  if (id === 'vscode.open') {
    const u = args[0];
    if (u && u.scheme === 'file') rpc.notify('editor.openFile', { path: u.fsPath });
    else if (u) await rpc.request('env.openExternal', { url: String(u) });
    return undefined;
  }
  if (id === 'workbench.action.openSettings') { rpc.notify('settings.open', { query: args[0] || '' }); return undefined; }
  throw new Error('command \'' + id + '\' not found');
}

// ---------------------------------------------------------------- the API

const windowState = new EventEmitter();
const trustGranted = new EventEmitter();
const foldersChanged = new EventEmitter();
let focused = true;
let trusted = true;

function workspaceRoot() {
  return host && host.workspaceFolders && host.workspaceFolders[0] ? host.workspaceFolders[0] : undefined;
}

const vscode = {
  version: '1.106.0',
  Disposable, EventEmitter, Uri, ThemeColor, ThemeIcon, MarkdownString, Position, Range,
  CompletionItem, CompletionItemKind, SnippetString, TreeItem, TreeItemCollapsibleState,
  StatusBarAlignment, ViewColumn, ConfigurationTarget, QuickPickItemKind, ProgressLocation,
  ExtensionMode, UIKind, InputBoxValidationSeverity,
  CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  },

  l10n: {
    t(message, ...args) {
      const m = typeof message === 'object' ? message.message : message;
      const a = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return String(m).replace(/\{(\d+)\}/g, (x, i) => (a[i] === undefined ? x : String(a[i])));
    },
    bundle: undefined,
    uri: undefined
  },

  env: {
    get language() { return (host && host.language) || 'en'; },
    get shell() { return (host && host.shell) || process.env.COMSPEC || process.env.SHELL || ''; },
    get appName() { return (host && host.appName) || 'JetBrains IDE'; },
    appHost: 'desktop',
    uiKind: UIKind.Desktop,
    uriScheme: 'jetbrains',
    machineId: 'jetbrains',
    sessionId: String(process.pid),
    remoteName: undefined,
    clipboard: {
      writeText: text => rpc.request('env.clipboard.write', { text: String(text) }).then(() => undefined),
      readText: () => rpc.request('env.clipboard.read').then(t => (t == null ? '' : String(t)))
    },
    openExternal: uri => rpc.request('env.openExternal', { url: String(uri) }).then(() => true, () => false)
  },

  workspace: {
    getConfiguration,
    onDidChangeConfiguration: configChanged.event,
    get isTrusted() { return trusted; },
    onDidGrantWorkspaceTrust: trustGranted.event,
    get workspaceFolders() {
      const list = (host && host.workspaceFolders) || [];
      return list.length ? list.map((p, index) => ({ uri: Uri.file(p), name: path.basename(p), index })) : undefined;
    },
    get name() { const r = workspaceRoot(); return r ? path.basename(r) : undefined; },
    get rootPath() { return workspaceRoot(); },
    onDidChangeWorkspaceFolders: foldersChanged.event,
    textDocuments: [],
    openTextDocument,
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return new Disposable(() => contentProviders.delete(scheme));
    },
    onDidSaveTextDocument: docSaved.event,
    onDidOpenTextDocument: new EventEmitter().event,
    onDidCloseTextDocument: new EventEmitter().event,
    onDidChangeTextDocument: new EventEmitter().event,
    getWorkspaceFolder(uri) {
      const f = (vscode.workspace.workspaceFolders || []).find(x => uri.fsPath.startsWith(x.uri.fsPath));
      return f;
    }
  },

  window: {
    showInformationMessage: (m, ...r) => showMessage('info', m, ...r),
    showWarningMessage: (m, ...r) => showMessage('warning', m, ...r),
    showErrorMessage: (m, ...r) => showMessage('error', m, ...r),
    showQuickPick,
    showInputBox,
    showOpenDialog,
    showSaveDialog,
    showTextDocument,
    createStatusBarItem,
    setStatusBarMessage,
    createWebviewPanel,
    registerWebviewViewProvider,
    createTreeView,
    createTerminal,
    get terminals() { return terminals.slice(); },
    get activeTerminal() { return activeTerminal; },
    onDidOpenTerminal: terminalOpened.event,
    onDidCloseTerminal: terminalClosed.event,
    onDidChangeActiveTerminal: terminalActive.event,
    get state() { return { focused, active: focused }; },
    onDidChangeWindowState: windowState.event,
    async withProgress(options, task) {
      const id = 'progress:' + (nextToken++);
      rpc.notify('progress.start', { id, title: String((options && options.title) || '') });
      try {
        return await task({ report() {} },
          { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) });
      } finally { rpc.notify('progress.end', { id }); }
    },
    createOutputChannel(name) {
      const log = (...a) => console.error('[' + name + ']', ...a);
      return { name, append: log, appendLine: log, replace() {}, clear() {}, show() {}, hide() {}, dispose() {},
        trace: log, debug: log, info: log, warn: log, error: log };
    }
  },

  commands: {
    registerCommand,
    executeCommand,
    getCommands: () => Promise.resolve([...commands.keys()])
  },

  languages: {
    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      const entry = { selector, provider, triggerCharacters };
      completionProviders.push(entry);
      return new Disposable(() => {
        const i = completionProviders.indexOf(entry);
        if (i !== -1) completionProviders.splice(i, 1);
      });
    }
  },

  extensions: {
    getExtension: () => undefined,
    all: [],
    onDidChange: new EventEmitter().event
  }
};

// ------------------------------------------------------------------ wiring

// Called once by main.js, with the parameters of the IDE's initialize request.
function init(connection, params, extensionRoot) {
  rpc = connection;
  host = params || {};
  root = extensionRoot;
  pkg = readJson(path.join(root, 'package.json'), {});
  focused = host.focused !== false;
  trusted = host.trusted !== false;
  settingsFile = path.join(host.storagePath, 'settings.json');
  loadDefaults();
  settings = readJson(settingsFile, {}) || {};
  watchSettings();

  rpc.onNotification('window.state', p => {
    const f = !!(p && p.focused);
    if (f === focused) return;
    focused = f;
    windowState.fire({ focused, active: focused });
  });
  rpc.onNotification('workspace.trusted', () => {
    if (trusted) return;
    trusted = true;
    trustGranted.fire();
  });
  rpc.onNotification('webview.message', p => {
    const w = p && webviews.get(p.id);
    if (w) w._msg.fire(p.message);
  });
  rpc.onNotification('webview.visible', p => {
    if (!p) return;
    const v = views.get(p.id);
    if (v && v._visible !== !!p.visible) { v._visible = !!p.visible; v._vis.fire(); }
    const pn = panels.get(p.id);
    if (pn) { pn.visible = !!p.visible; pn.active = !!p.visible; pn._state.fire({ webviewPanel: pn }); }
  });
  rpc.onNotification('webview.disposed', p => {
    if (!p) return;
    const pn = panels.get(p.id);
    if (pn) pn._closed();
    const v = views.get(p.id);
    if (v) { views.delete(p.id); webviews.delete(p.id); v._visible = false; v._disp.fire(); }
  });
  rpc.onNotification('terminal.closed', p => { if (p) closeTerminal(p.id); });
  rpc.onNotification('document.saved', p => {
    if (!p || !p.path || typeof p.text !== 'string') return;
    docSaved.fire(makeDoc(Uri.file(p.path), p.text, p.languageId));
  });
  rpc.onRequest('view.resolve', p => resolveView(p && p.id));
  rpc.onRequest('input.validate', p => {
    const fn = p && validators.get(p.token);
    return fn ? runValidator(fn, String(p.value == null ? '' : p.value)) : null;
  });
  rpc.onRequest('completion.provide', provideCompletion);
}

function dispose() {
  if (settingsWatch) { try { settingsWatch.close(); } catch (e) { /* gone */ } settingsWatch = null; }
}

module.exports = vscode;
Object.defineProperty(module.exports, '__host', {
  enumerable: false,
  value: { init, dispose, Memento, markdownToHtml, stripIcons, colorOf, commands }
});
