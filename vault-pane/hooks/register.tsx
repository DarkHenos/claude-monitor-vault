import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KeyOrder, NewKeyForm, OwnerStatus, Quota, VaultItem, VaultKey, VaultListing } from '../types'

// The Claude Vault, beside the chat. Everything comes from the vault's own
// read-only listing (list.js --groups): key names, groups, separators and MCP
// scopes. No code path here reads a stored value, and none is ever drawn. A new
// key's value is typed in the form's surface module (secret-form.tsx), masked, and
// crosses this file once, on Save, on its way to tools/store-key.js: never kept,
// logged or put on a command line. A surface without that module types it in a
// window of its own (tools/new-key.js). The bridge comes with the mod, so VS Code
// is not needed.
//
// What is the owner's alone (approving a request, deleting a key, the recovery
// phrase) is decided in such a window too (tools/owner.js), at a real console a
// command of Claude's does not have. A press here only opens it.

const PANE = 'claude-vault'
const COMMAND = 'vault'
const REFRESH_MS = 30_000
// The person closed the pane: it stays closed in later sessions until they open it.
const HIDDEN = 'hidden'
// The person hid the band above the prompt: the same, until the pane shows it again.
const BAND_HIDDEN = 'bandHidden'

// Change a tag when its value's fields change: an older value is then declined.
const listing = atom({ plugin: 'vault-pane', key: 'listing' } as const,
  { items: [], at: 0 } as VaultListing, { shape: 'listing-2' })
const quotas = atom({ plugin: 'vault-pane', key: 'quotas' } as const,
  [] as Quota[], { shape: 'quotas-1' })
const folded = atom({ plugin: 'vault-pane', key: 'folded' } as const,
  [] as string[], { shape: 'folded-1' })
// Whether the pane is drawn, and the band above the prompt: each opens the other.
const isShown = atom({ plugin: 'vault-pane', key: 'isShown' } as const,
  false, { shape: 'isShown-1' })
const isBandShown = atom({ plugin: 'vault-pane', key: 'isBandShown' } as const,
  true, { shape: 'isBandShown-1' })
const query = atom({ plugin: 'vault-pane', key: 'query' } as const,
  '', { shape: 'query-1' })
// The band's list of keys: the API has no searchable list, so a field over results.
const isPickerOpen = atom({ plugin: 'vault-pane', key: 'isPickerOpen' } as const,
  false, { shape: 'isPickerOpen-1' })
const pickerQuery = atom({ plugin: 'vault-pane', key: 'pickerQuery' } as const,
  '', { shape: 'pickerQuery-1' })
const PICKER_ROWS = 8
const order = atom({ plugin: 'vault-pane', key: 'order' } as const,
  'vault' as KeyOrder, { shape: 'order-1' })
const newKey = atom({ plugin: 'vault-pane', key: 'newKey' } as const,
  { isOpen: false } as NewKeyForm, { shape: 'newKey-2' })
// hasRecovery starts true: no warning until the vault has actually said so.
const owner = atom({ plugin: 'vault-pane', key: 'owner' } as const,
  { replaces: [], mcp: [], uses: [], hasRecovery: true, binned: 0 } as OwnerStatus, { shape: 'owner-1' })
const notice = atom({ plugin: 'vault-pane', key: 'notice' } as const,
  '', { shape: 'notice-1' })

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><g fill="none" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M16 62a48 48 0 0 1 96 0" stroke="#D97757" stroke-width="11"/><path d="M64 34v6M39 44l4 4M89 44l-4 4" stroke="#D97757" stroke-width="5"/>'
  + '<path d="M64 62l17-13" stroke="#D97757" stroke-width="8"/><circle cx="64" cy="62" r="6" fill="#D97757"/>'
  + '<path d="M58 82c-15-15-36-5-36 12s21 27 36 12" stroke="#D97757" stroke-width="11"/><path d="M70 82c15-15 36-5 36 12s-21 27-36 12" stroke="#62B5A5" stroke-width="11"/>'
  + '<path d="M64 95v7" stroke="#62B5A5" stroke-width="5"/><circle cx="64" cy="92" r="4" fill="#62B5A5"/></g></svg>'
// The person is typing in the new-key window: wait for them, within reason.
const NEW_KEY_TIMEOUT_MS = 10 * 60_000

const TEXTS = {
  en: {
    title: 'Claude Vault',
    describe: 'Show the Claude Vault pane: key names, groups, MCP access and quotas',
    opened: 'Claude Vault pane opened.',
    open: 'Open',
    secrets: 'SECRETS',
    search: 'Search keys',
    orderVault: 'Vault order',
    orderAz: 'Name A → Z',
    orderZa: 'Name Z → A',
    noMatch: 'No key matches.',
    shellOnly: 'secret · shell only',
    mcpScope: (scope: string) => `secret · MCP${scope === 'all' ? '' : `: ${scope}`}`,
    secret: 'secret',
    empty: 'The vault is empty. Press + to create a key.',
    setupTitle: 'The vault is not on this computer yet.',
    setupDetail: 'Activating adds the vault hooks to Claude Code (settings.json, backed up first). VS Code is not needed.',
    setupButton: 'Activate the vault',
    setupDone: 'Vault activated. Hooks apply from the next session at the latest.',
    newKeyName: 'KEY_NAME',
    newKeyCreate: 'Continue',
    newKeyCancel: 'Cancel',
    newKeyHint: 'The value is typed next, in a separate window: neither Claude nor this pane sees it.',
    newKeyInvalid: 'Capitals, digits and _ only, starting with a letter (2 to 64 characters).',
    newKeyWaiting: 'Type the value in the window that just opened.',
    newKeyNoWindow: (command: string) => `Run this in a terminal: ${command}`,
    newKeyFailed: 'The key was not created.',
    form: {
      name: 'Key name',
      value: 'Key value',
      show: 'Show',
      hide: 'Hide',
      mcpLabel: 'MCP access (all servers)',
      save: 'Save',
      cancel: 'Cancel',
      savedAs: 'Saved as',
      invalidName: 'The name must start with a letter: letters, digits and spaces, 2 to 64 characters.',
      emptyValue: 'Type or paste the key.',
    },
    keySaved: (name: string) => `${name} saved in the vault.`,
    keySavedMcp: (name: string) => `${name} saved in the vault, MCP on.`,
    keyTaken: (name: string) => `${name} already exists: nothing was changed.`,
    formNote: 'Created from the Claude Vault bar',
    bandPick: (n: number) => `Insert a key (${n})`,
    bandMore: (n: number) => `+${n}: narrow the search`,
    bandEmpty: 'empty',
    bandSetup: 'activate the vault',
    toApproveCount: (n: number) => `${n} to approve`,
    showBand: 'Show the bar above the prompt',
    hideBand: 'Hide the bar above the prompt',
    toApprove: 'TO APPROVE',
    askReplace: (name: string) => `Claude asks to replace ${name}`,
    askMcp: (who: string, names: string) => `${who} asks for MCP access to ${names}`,
    askMcpServers: (servers: string) => `Servers: ${servers}`,
    everyServer: 'every server',
    askUse: (who: string, name: string) => `${who} wants to use ${name} now`,
    says: (text: string) => `Says: ${text}`,
    review: 'Review',
    refuse: 'Refuse',
    deleteKey: 'Delete',
    vaultSection: 'VAULT',
    noRecovery: 'No recovery phrase: if this computer\'s key is lost, your keys are lost with it.',
    makePhrase: 'Create the recovery phrase',
    newPhrase: 'New phrase',
    restore: 'Restore',
    bin: (n: number) => `Bin (${n})`,
    ownerFailed: 'That did not work: try again from the pane.',
    guarded: 'vault-pane: its tools are the owner\'s, from the Claude Vault pane. Use {{vault:NAME}} markers, list.js, add.js or set.js.',
    guardFailed: 'vault-pane: its guard failed.',
    ungrouped: 'Ungrouped',
    refresh: 'Refresh',
    updated: 'updated',
    hint: 'Click a key to insert its marker in your message.',
    inserted: (name: string) => `{{vault:${name}}} inserted.`,
    noNode: 'Node.js was not found on the PATH: the vault cannot be listed.',
    remote: 'Cloud session: the vault stays on your computer and is not listed here. Quotas still show.',
    oldBridge: 'This vault bridge is old: no groups, and Claude cannot ask for MCP access.',
    upgrade: 'Update the bridge',
    upgradeDetail: 'Your vault is backed up first, and no value is read.',
    upgraded: 'Bridge updated, vault backed up. New sessions use it; restart this one to be sure.',
    upgradedOverExtension: (version: string) => `Bridge updated, vault backed up. Your VS Code extension (${version}) puts its old bridge back whenever VS Code opens: update or uninstall it.`,
    session: 'Session',
    week: 'Week',
    resets: (when: string) => `Resets ${when}`,
    resetsShort: (when: string) => `resets ${when}`,
    noQuota: 'Quotas show after the first reply.',
  },
  fr: {
    title: 'Claude Vault',
    describe: 'Affiche le panneau Claude Vault : noms des clés, groupes, accès MCP et quotas',
    opened: 'Panneau Claude Vault ouvert.',
    open: 'Ouvrir',
    secrets: 'SECRETS',
    search: 'Rechercher une clé',
    orderVault: 'Ordre du coffre',
    orderAz: 'Nom A → Z',
    orderZa: 'Nom Z → A',
    noMatch: 'Aucune clé ne correspond.',
    shellOnly: 'secret · shell uniquement',
    mcpScope: (scope: string) => `secret · MCP${scope === 'all' ? '' : ` : ${scope}`}`,
    secret: 'secret',
    empty: 'Le coffre est vide. Cliquez sur + pour créer une clé.',
    setupTitle: "Le coffre n'est pas encore sur cet ordinateur.",
    setupDetail: "L'activation ajoute les hooks du coffre à Claude Code (settings.json, sauvegardé avant). VS Code n'est pas nécessaire.",
    setupButton: 'Activer le coffre',
    setupDone: 'Coffre activé. Les hooks s\'appliquent au plus tard à la prochaine session.',
    newKeyName: 'NOM_DE_LA_CLE',
    newKeyCreate: 'Continuer',
    newKeyCancel: 'Annuler',
    newKeyHint: 'La valeur se tape ensuite, dans une fenêtre séparée : ni Claude ni ce panneau ne la voient.',
    newKeyInvalid: 'Majuscules, chiffres et _ uniquement, en commençant par une lettre (2 à 64 caractères).',
    newKeyWaiting: "Tapez la valeur dans la fenêtre qui vient de s'ouvrir.",
    newKeyNoWindow: (command: string) => `Lancez ceci dans un terminal : ${command}`,
    newKeyFailed: "La clé n'a pas été créée.",
    form: {
      name: 'Nom de la clé',
      value: 'Valeur de la clé',
      show: 'Afficher',
      hide: 'Masquer',
      mcpLabel: 'Accès MCP (tous les serveurs)',
      save: 'Enregistrer',
      cancel: 'Annuler',
      savedAs: 'Enregistrée sous',
      invalidName: 'Le nom doit commencer par une lettre : lettres, chiffres et espaces, 2 à 64 caractères.',
      emptyValue: 'Tapez ou collez la clé.',
    },
    keySaved: (name: string) => `${name} enregistrée dans le coffre.`,
    keySavedMcp: (name: string) => `${name} enregistrée dans le coffre, MCP activé.`,
    keyTaken: (name: string) => `${name} existe déjà : rien n'a été modifié.`,
    formNote: 'Créée depuis la barre Claude Vault',
    bandPick: (n: number) => `Insérer une clé (${n})`,
    bandMore: (n: number) => `+${n} : précisez la recherche`,
    bandEmpty: 'vide',
    bandSetup: 'activer le coffre',
    toApproveCount: (n: number) => `${n} à valider`,
    showBand: 'Afficher la barre au-dessus de la saisie',
    hideBand: 'Masquer la barre au-dessus de la saisie',
    toApprove: 'À VALIDER',
    askReplace: (name: string) => `Claude demande à remplacer ${name}`,
    askMcp: (who: string, names: string) => `${who} demande l'accès MCP à ${names}`,
    askMcpServers: (servers: string) => `Serveurs : ${servers}`,
    everyServer: 'tous les serveurs',
    askUse: (who: string, name: string) => `${who} veut utiliser ${name} maintenant`,
    says: (text: string) => `Dit : ${text}`,
    review: 'Examiner',
    refuse: 'Refuser',
    deleteKey: 'Supprimer',
    vaultSection: 'COFFRE',
    noRecovery: 'Aucune phrase de récupération : si la clé de cet ordinateur est perdue, vos clés le sont aussi.',
    makePhrase: 'Créer la phrase de récupération',
    newPhrase: 'Nouvelle phrase',
    restore: 'Restaurer',
    bin: (n: number) => `Corbeille (${n})`,
    ownerFailed: "Ça n'a pas marché : réessayez depuis le panneau.",
    guarded: "vault-pane : ses outils sont réservés au propriétaire, depuis le panneau Claude Vault. Utilisez les marqueurs {{vault:NOM}}, list.js, add.js ou set.js.",
    guardFailed: 'vault-pane : son garde-fou a échoué.',
    ungrouped: 'Sans groupe',
    refresh: 'Actualiser',
    updated: 'à jour',
    hint: 'Clic sur une clé : insère son marqueur dans le message.',
    inserted: (name: string) => `{{vault:${name}}} inséré.`,
    noNode: 'Node.js est introuvable dans le PATH : impossible de lister le coffre.',
    remote: 'Session cloud : le coffre reste sur votre ordinateur et ne peut pas être listé ici. Les quotas restent affichés.',
    oldBridge: "Ce pont du coffre est ancien : pas de groupes, et Claude ne peut pas demander d'accès MCP.",
    upgrade: 'Mettre à jour le pont',
    upgradeDetail: "Votre coffre est sauvegardé d'abord, et aucune valeur n'est lue.",
    upgraded: 'Pont mis à jour, coffre sauvegardé. Les nouvelles sessions l\'utilisent ; relancez celle-ci pour être sûr.',
    upgradedOverExtension: (version: string) => `Pont mis à jour, coffre sauvegardé. Votre extension VS Code (${version}) remet son ancien pont à chaque ouverture de VS Code : mettez-la à jour ou désinstallez-la.`,
    session: 'Session',
    week: 'Semaine',
    resets: (when: string) => `Réinitialisation : ${when}`,
    resetsShort: (when: string) => `réinit. ${when}`,
    noQuota: 'Les quotas apparaissent après la première réponse.',
  },
}

function locale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}

const T = locale().toLowerCase().startsWith('fr') ? TEXTS.fr : TEXTS.en

// list.js --groups, line by line: "# Group", "NAME<TAB>scope", "---<TAB>@P" or
// "--- label<TAB>@P". "# Ungrouped" always comes last.
export function parse(stdout: string): VaultItem[] {
  const items: VaultItem[] = []
  let group: Extract<VaultItem, { kind: 'group' }> | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line === 'Claude Vault is empty.') continue
    if (line.startsWith('# ')) {
      const name = line.slice(2)
      group = { kind: 'group', name, keys: [], isUngrouped: name === 'Ungrouped' }
      items.push(group)
      continue
    }
    const [head = '', tail = ''] = line.split('\t')
    if (head === '---' || head.startsWith('--- ')) {
      items.push({ kind: 'separator', label: head.slice(4) })
      group = undefined
      continue
    }
    const scope = tail.startsWith('mcp:') ? tail.slice(4) : 'none'
    const key: VaultKey = { name: head, mcp: scope }
    if (!group) {
      group = { kind: 'group', name: 'Ungrouped', keys: [], isUngrouped: true }
      items.push(group)
    }
    group.keys.push(key)
  }
  // The listing always ends on the ungrouped header: drop it when nothing is in it.
  return items.filter(it => it.kind !== 'group' || !it.isUngrouped || it.keys.length > 0)
}

async function bridge($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return `${config}/claude-vault-bridge/list.js`
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '~'
  return `${home}/.claude/claude-vault-bridge/list.js`
}

// A cloud session runs in a container: the bridge lives on the person's own
// computer, so its absence there is expected, not something to install.
async function missing($: EngineInterface): Promise<VaultListing> {
  return (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'
    ? { items: [], error: T.remote, at: Date.now() }
    : { items: [], needsSetup: true, at: Date.now() }
}

function tool($: EngineInterface, name: string): string {
  return `${$.plugin.root}/tools/${name}`
}

let isBusy = false

async function refresh($: EngineInterface): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const script = await bridge($)
    let next: VaultListing
    try {
      let ran = await $.process.run(['node', script, '--groups'], { timeoutMs: 15_000 })
      let isOld = false
      // A bridge older than groups refuses the option: its names, still worth showing.
      if (ran.exitCode !== 0 && /takes no argument/.test(ran.stderr)) {
        ran = await $.process.run(['node', script], { timeoutMs: 15_000 })
        isOld = true
      }
      if (ran.exitCode === 0) next = { items: parse(ran.stdout), note: isOld ? T.oldBridge : undefined, at: Date.now() }
      else if (/Cannot find module/.test(ran.stderr)) next = await missing($)
      else next = { items: [], error: ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`, at: Date.now() }
    } catch {
      next = { items: [], error: T.noNode, at: Date.now() }
    }
    await update($, listing, () => next)
    await readOwner($)
  } finally {
    isBusy = false
  }
}

// What waits for the owner. Silent on failure: the listing already says why.
async function readOwner($: EngineInterface): Promise<void> {
  const ran = await $.process.run(['node', tool($, 'owner.js'), 'status'], { timeoutMs: 15_000 }).catch(() => undefined)
  if (ran?.exitCode !== 0) return
  let next: OwnerStatus
  try {
    next = JSON.parse(ran.stdout) as OwnerStatus
  } catch {
    return
  }
  await update($, owner, () => next)
}

// Opens a decision in its window and waits for the person to close it. 6 means
// they read it and decided nothing, which needs no comment here.
async function decide($: EngineInterface, action: string, argument?: string): Promise<void> {
  await update($, notice, () => '')
  const args = argument === undefined ? [action] : [action, argument]
  const ran = await $.process.run(['node', tool($, 'owner.js'), '--window', ...args], { timeoutMs: NEW_KEY_TIMEOUT_MS })
  if (ran.exitCode === 3) await update($, notice, () => T.newKeyNoWindow(ran.stdout.trim()))
  else if (ran.exitCode !== 0 && ran.exitCode !== 6) await update($, notice, () => T.ownerFailed)
  await refresh($)
}

// A refusal gives nothing away, so it takes a press and no window.
async function refuse($: EngineInterface, action: string, argument: string): Promise<void> {
  await $.process.run(['node', tool($, 'owner.js'), action, argument], { timeoutMs: 15_000 })
  await refresh($)
}

// The tools decide what is the owner's, and the copy of the bridge sits outside
// the path the vault's own guard watches: Claude has no business in either.
function isOwnTools($: EngineInterface, command: string): boolean {
  const said = command.replace(/\\/g, '/').toLowerCase()
  const root = $.plugin.root.replace(/\\/g, '/').toLowerCase()
  return said.includes(`${root}/tools`) || said.includes(`${root}/bridge`)
    || /claude-monitor-vault\/+vault-pane/.test(said)
}

// A marker may be waiting on a key that asks before every use, within a minute:
// the next listing could be too late to show it.
function watchUse($: EngineInterface, command: string): void {
  if (/\{\{\s*vault/.test(command)) void $.clock.sleep(2_000).then(() => readOwner($))
}

// Installs the bridge the mod carries, on the person's own press.
async function activate($: EngineInterface): Promise<void> {
  const ran = await $.process.run(['node', tool($, 'setup.js'), '--activate'], { timeoutMs: 60_000 })
  if (ran.exitCode === 0) await $.ui.toast(T.setupDone)
  else await update($, listing, list => ({ ...list, error: ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}` }))
  await refresh($)
}

async function closePicker($: EngineInterface): Promise<void> {
  await update($, isPickerOpen, () => false)
  await update($, pickerQuery, () => '')
}

function namesIn(list: VaultListing): string[] {
  return list.items.flatMap(it => (it.kind === 'group' ? it.keys.map(k => k.name) : []))
}

// Enter takes the first match of what was typed, as a search box does.
async function pickFirst($: EngineInterface, typed: string): Promise<void> {
  const want = typed.trim().toLowerCase()
  const first = namesIn(await read($, listing)).find(name => name.toLowerCase().includes(want))
  if (first) await pickKey($, first)
}

// On Desktop the search is the same module field as the new-key form's; a terminal
// and VS Code keep their own Input, which they draw well or are the only one they have.
function keepsOwnInput(surface: string): boolean {
  return surface === 'terminal' || surface === 'vscode'
}

async function searched($: EngineInterface, element: string, data: { kind?: unknown; text?: unknown }): Promise<void> {
  const text = typeof data.text === 'string' ? data.text : ''
  if (element === 'search') await update($, query, () => text)
  else if (data.kind === 'submit') await pickFirst($, text)
  else await update($, pickerQuery, () => text)
}

async function pickKey($: EngineInterface, name: string): Promise<void> {
  await insertMarker($, name)
  await closePicker($)
}

// An older bridge of the extension's, taken over on the person's own press.
async function upgrade($: EngineInterface): Promise<void> {
  const ran = await $.process.run(['node', tool($, 'setup.js'), '--upgrade'], { timeoutMs: 120_000 })
  const said = ran.stdout.trim()
  if (ran.exitCode !== 0) await update($, notice, () => ran.stderr.trim().split('\n')[0] || T.ownerFailed)
  else if (said.startsWith('upgraded extension=')) await update($, notice, () => T.upgradedOverExtension(said.slice(19)))
  else if (said === 'upgraded') await update($, notice, () => T.upgraded)
  await refresh($)
}

// A bridge the mod installed follows the mod; one the extension installed is left alone.
async function follow($: EngineInterface): Promise<void> {
  const ran = await $.process.run(['node', tool($, 'setup.js'), '--update'], { timeoutMs: 60_000 }).catch(() => undefined)
  if (ran?.exitCode === 0 && ran.stdout.trim() === 'updated') await refresh($)
}

async function createKey($: EngineInterface, typed: string): Promise<void> {
  const name = typed.trim().replace(/[\s-]+/g, '_').toUpperCase()
  if (!NAME_RE.test(name)) {
    await update($, newKey, () => ({ isOpen: true, message: T.newKeyInvalid }))
    return
  }
  await update($, newKey, () => ({ isOpen: true, message: T.newKeyWaiting }))
  const ran = await $.process.run(['node', tool($, 'new-key.js'), name, '--window'], { timeoutMs: NEW_KEY_TIMEOUT_MS })
  if (ran.exitCode === 0) await update($, newKey, () => ({ isOpen: false }))
  else if (ran.exitCode === 3) await update($, newKey, () => ({ isOpen: true, message: T.newKeyNoWindow(ran.stdout.trim()) }))
  else await update($, newKey, () => ({ isOpen: true, message: T.newKeyFailed }))
  await refresh($)
}

// A real checkbox, as a picture: the API has none, and a text glyph looks like one.
function checkbox(isOn: boolean): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
  return isOn
    ? `${open}<rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.5" fill="#C4623F" stroke="#C4623F" stroke-width="1.5"/>`
      + '<path d="M4 8.3l2.7 2.7L12 5.4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : `${open}<rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.5" fill="#ffffff" stroke="#9a9a9a" stroke-width="1.5"/></svg>`
}

// The form's own buttons, drawn by the hook so they are the surface's native ones.
// Save only raises a tick: the fields' text is the form module's, which then posts it.
function newKeyActions($: EngineInterface, surface: string, table: any, form: NewKeyForm): JSX.Element {
  const { Box, Text, Button } = table
  const hasMcp = form.hasMcp === true
  const toggle = () => update($, newKey, f => ({ ...f, hasMcp: f.hasMcp !== true }))
  return (
    <Box flexDirection="row" alignItems="center" columnGap="sm" rowGap="xs" flexWrap="wrap" justifyContent="flex-end" flexGrow={1}>
      <Box flexDirection="row" alignItems="center" columnGap="xs">
        {surface !== 'terminal' && 'Svg' in table
          ? (
            <Box position="relative">
              <table.Svg source={checkbox(hasMcp)} alt={T.form.mcpLabel} width={16} height={16} />
              <Box position="absolute" top={0} left={0}>
                <Button key="form-mcp-box" plain onPress={toggle}>{'   '}</Button>
              </Box>
            </Box>
          )
          : null}
        <Button key="form-mcp" plain onPress={toggle}>
          {surface === 'terminal' ? (hasMcp ? '[x] ' : '[ ] ') : ''}<Text size="caption">{T.form.mcpLabel}</Text>
        </Button>
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0}>
        <Button key="form-cancel" onPress={() => update($, newKey, () => ({ isOpen: false }))}>{T.form.cancel}</Button>
        <Button key="form-save" variant="primary"
          onPress={() => update($, newKey, f => ({ ...f, saveTick: (f.saveTick ?? 0) + 1 }))}>{T.form.save}</Button>
      </Box>
    </Box>
  )
}

// What the form posts is code's word, not a fact: checked here, and the value goes
// nowhere but the stdin of tools/store-key.js. The name is handled again as typed.
async function saveFromForm($: EngineInterface, data: { name?: unknown; value?: unknown }): Promise<void> {
  const say = (message: string) => update($, newKey, f => ({ ...f, isOpen: true, message }))
  const name = String(data.name ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase()
  if (!NAME_RE.test(name)) {
    await say(T.form.invalidName)
    return
  }
  if (typeof data.value !== 'string' || !data.value) {
    await say(T.form.emptyValue)
    return
  }
  const hasMcp = (await read($, newKey)).hasMcp === true
  const ran = await $.process.run(['node', tool($, 'store-key.js')], {
    stdin: JSON.stringify({ name, value: data.value, note: T.formNote, hasMcp }),
    timeoutMs: 30_000,
  })
  if (ran.exitCode === 0) {
    await update($, newKey, () => ({ isOpen: false }))
    await $.ui.toast(hasMcp ? T.keySavedMcp(name) : T.keySaved(name))
  } else if (ran.exitCode === 7) {
    await say(T.keyTaken(name))
  } else {
    await say(T.newKeyFailed)
  }
  await refresh($)
}

function setQuotas($: EngineInterface, limits: readonly Quota[]): Promise<unknown> {
  const kept = limits.map(q => ({ kind: q.kind, percentUsed: q.percentUsed, resetsAt: q.resetsAt }))
  return update($, quotas, () => kept)
}

function clock(at: number | string, withSeconds = false): string {
  try {
    return new Date(at).toLocaleTimeString(locale(), {
      hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined,
    })
  } catch {
    return ''
  }
}

// When the quota starts over: the time alone within the day, the weekday beyond it.
function resetWhen(resetsAt?: string): string {
  if (!resetsAt) return ''
  const when = new Date(resetsAt)
  if (Number.isNaN(when.getTime())) return ''
  if (when.getTime() - Date.now() < 20 * 3600_000) return clock(resetsAt)
  try {
    return `${when.toLocaleDateString(locale(), { weekday: 'short' })} ${clock(resetsAt)}`
  } catch {
    return ''
  }
}

function resetText(resetsAt?: string): string {
  const when = resetWhen(resetsAt)
  return when ? T.resets(when) : ''
}

// Non-breaking spaces: in the band a figure and its unit never part over two lines.
function glued(text: string): string {
  return text.replace(/ /g, ' ')
}

function resetShort(resetsAt?: string): string {
  const when = resetWhen(resetsAt)
  return when ? glued(T.resetsShort(when)) : ''
}

async function insertMarker($: EngineInterface, name: string): Promise<void> {
  const filled = await $.prompt.fill({ text: `{{vault:${name}}}`, mode: 'insert' })
  if (filled.isFilled) await $.ui.toast(T.inserted(name))
}

function severity(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'success'
}

// The quota bar as an image, for the surfaces that draw Svg. Raw colors: an image
// cannot read the theme, and these hold on a light or a dark one.
const BAR_COLORS = { success: '#3fb950', warning: '#d9a441', error: '#f14c4c' }

function barSvg(percent: number, width = 400, height = 6): string {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 100 * width)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
    + `<rect width="${width}" height="${height}" rx="${height / 2}" fill="#8888887a"/>`
    + `<rect width="${filled}" height="${height}" rx="${height / 2}" fill="${BAR_COLORS[severity(percent)]}"/>`
    + '</svg>'
}

// What the search and the sort leave of a group's keys.
function shown(keys: readonly VaultKey[], search: string, how: KeyOrder): VaultKey[] {
  const wanted = search.trim().toLowerCase()
  const kept = keys.filter(k => k.name.toLowerCase().includes(wanted))
  if (how === 'vault') return kept
  const sorted = kept.sort((a, b) => a.name.localeCompare(b.name))
  return how === 'az' ? sorted : sorted.reverse()
}

// Opened on its own (session start), a pane is only drawn on a wide enough
// window; a press on the band or /vault places it at any width.
async function open($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: T.title, columns: 42 })
  await update($, isShown, () => opened.isPlaced)
}

// From the band: asked for by a press, so it comes back in later sessions too.
async function openAsked($: EngineInterface): Promise<void> {
  await $.store.set(HIDDEN, false)
  await open($)
}

async function setBand($: EngineInterface, isOn: boolean): Promise<void> {
  await $.store.set(BAND_HIDDEN, !isOn)
  await update($, isBandShown, () => isOn)
}

function quotaLabel(kind: string): string {
  return kind === 'five_hour' ? T.session : kind === 'seven_day' ? T.week : kind
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: T.describe })
    const usage = await $.session.usage().catch(() => undefined)
    if (usage) await setQuotas($, usage.rateLimits)
    await update($, isBandShown, () => true)
    if ((await $.store.get(BAND_HIDDEN)) === true) await update($, isBandShown, () => false)
    void refresh($).then(() => follow($))
    $.clock.every(REFRESH_MS, () => refresh($))
    if ((await $.store.get(HIDDEN)) !== true) void open($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.store.set(HIDDEN, false)
    await open($)
    void refresh($)

    return { text: T.opened }
  }).catch(() => ({ text: T.opened }))

  // A failure here must never keep a pane open, this one or another plugin's.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isShown, () => false)
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(HIDDEN, true)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The new-key form and the search fields: only this plugin's hooks hear what they post.
  on('ui.message', async ($, e, next) => {
    const data = (e.data ?? {}) as { kind?: unknown; name?: unknown; value?: unknown; text?: unknown }
    if (e.element === 'band-form' || e.element === 'pane-form') {
      if (data.kind === 'save') await saveFromForm($, data)

      return {}
    }
    if (e.element === 'search' || e.element === 'band-search') {
      await searched($, e.element, data)

      return {}
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await setQuotas($, e.rateLimits)

    return next(e)
  })

  // A key added, moved or regrouped by Claude shows at once, not 30 s later.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command)
    if (isOwnTools($, command)) return { deny: T.guarded }
    watchUse($, command)
    const ran = await next(e)
    if (command.includes('claude-vault-bridge')) void refresh($)

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: T.guardFailed }))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const command = String(e.command)
    if (isOwnTools($, command)) return { deny: T.guarded }
    watchUse($, command)
    const ran = await next(e)
    if (command.includes('claude-vault-bridge')) void refresh($)

    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: T.guardFailed }))

  // The band above the prompt, one row that earns its place: the vault, a list that
  // puts a key's marker in the message, a new key, what waits for the owner, the
  // quotas and when they reset. It yields to a survey; the pane hides it. Its Buttons
  // are plain, so Desktop draws no chip, and carry no `label`, which would replace
  // their children.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const limits = await read($, quotas)
    const isOpen = await read($, isShown)
    const waiting = await read($, owner)
    const requests = waiting.replaces.length + waiting.mcp.length + waiting.uses.length
    const list = await read($, listing)
    const names = namesIn(list)
    const columns = e.props.bodyColumns
    // Too narrow for everything: the bars go first, then the quotas' names. When a
    // quota starts over stays, as what the band is most often read for.
    const hasBars = columns >= 100
    const hasNames = columns >= 50
    const toPane = (key: string, shown: JSX.Element) => (isOpen
      ? shown
      : <Button key={key} plain onPress={() => openAsked($)}>{shown}</Button>)
    // The new-key form draws here, unless the pane is open and already holds it.
    const form = await read($, newKey)
    const isAdding = form.isOpen && !isOpen && !list.needsSetup && !list.error
    const isPicking = await read($, isPickerOpen) && names.length > 0
    const typed = await read($, pickerQuery)
    const wanted = typed.trim().toLowerCase()
    const found = names.filter(name => name.toLowerCase().includes(wanted))

    return (
      <Box flexDirection="column" rowGap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap="sm" paddingX="xs">
        <Box flexDirection="row" alignItems="center" columnGap="xs" flexShrink={1}>
          {e.surface !== 'terminal' && 'Svg' in table
            ? <table.Svg source={LOGO} alt={T.title} width={20} height={20} />
            : <Text>🔐</Text>}
          {isOpen
            ? <Text weight="semibold" wrap="truncate-end">{T.title}</Text>
            : <Button key="launch" plain onPress={() => openAsked($)}><Text weight="semibold">{T.title}</Text></Button>}
          {list.needsSetup
            ? toPane('band-setup', <Text color="warning" size="caption" weight="medium">{T.bandSetup}</Text>)
            : null}
          {!list.needsSetup && !list.error && names.length === 0 && list.at > 0
            ? <Text dimColor size="caption">{T.bandEmpty}</Text>
            : null}
          {names.length > 0 && 'Input' in table && (
            <Button key="band-keys" plain onPress={async () => {
              if (isPicking) return closePicker($)
              await update($, newKey, f => ({ ...f, isOpen: false }))
              return update($, isPickerOpen, () => true)
            }}>
              <Text size="caption">{T.bandPick(names.length)} {isPicking ? '▴' : '▾'}</Text>
            </Button>
          )}
          {!list.needsSetup && !list.error && (
            <Button key="band-add" plain onPress={async () => {
              await closePicker($)
              await update($, newKey, f => ({ isOpen: !f.isOpen }))
            }}>+</Button>
          )}
          {requests > 0 && toPane('band-approve', <Text color="warning" size="caption" weight="semibold">{T.toApproveCount(requests)}</Text>)}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap="sm" flexShrink={0}>
          {limits.map(q => (
            <Box flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0}>
              {hasNames && <Text dimColor size="caption" wrap="truncate">{quotaLabel(q.kind)}</Text>}
              {hasBars && e.surface !== 'terminal' && 'Svg' in table
                ? <table.Svg source={barSvg(q.percentUsed, 44, 5)} alt={`${quotaLabel(q.kind)} ${Math.round(q.percentUsed)} %`} width={44} height={5} />
                : null}
              <Text color={severity(q.percentUsed)} size="caption" weight="semibold" tabular wrap="truncate">{glued(`${Math.round(q.percentUsed)} %`)}</Text>
              {q.resetsAt ? <Text dimColor size="caption" tabular wrap="truncate">{resetShort(q.resetsAt)}</Text> : null}
            </Box>
          ))}
        </Box>
      </Box>
      {isAdding && e.surface !== 'mobile' && e.surface !== 'vscode' && 'Client' in table && (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="sm" rowGap="xs" flexWrap="wrap" paddingX="xs">
          <table.Client key="band-form" module="./secret-form.tsx"
            props={{ texts: T.form, message: form.message ?? '', saveTick: form.saveTick ?? 0 }} />
          {newKeyActions($, e.surface, table, form)}
        </Box>
      )}
      {isPicking && 'Input' in table && (
        <Box flexDirection="column" rowGap="xs" paddingX="xs">
          {!keepsOwnInput(e.surface) && 'Client' in table
            ? <table.Client key="band-search" module="./key-search.tsx" props={{ placeholder: T.search, initial: typed, hasFocus: true }} />
            : (
              <table.Input key="band-search" placeholder={T.search} value={typed} autoFocus submitLabel={' '}
                onInput={value => update($, pickerQuery, () => value)}
                onSubmit={value => pickFirst($, value)} />
            )}
          {found.length === 0 ? <Text dimColor size="caption">{T.noMatch}</Text> : null}
          {found.slice(0, PICKER_ROWS).map(name => (
            <Button key={`band-k:${name}`} plain onPress={() => pickKey($, name)}>
              <Text mono size="caption">{name}</Text>
            </Button>
          ))}
          {found.length > PICKER_ROWS ? <Text dimColor size="caption">{T.bandMore(found.length - PICKER_ROWS)}</Text> : null}
        </Box>
      )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const list = await read($, listing)
    const limits = await read($, quotas)
    const closed = new Set(await read($, folded))
    const search = await read($, query)
    const how = await read($, order)
    const form = await read($, newKey)
    const waiting = await read($, owner)
    const said = await read($, notice)
    const hasBand = await read($, isBandShown)
    // A window cannot be raised from the phone: its person is at the computer.
    const canDecide = e.surface !== 'mobile'
    const keys = list.items.flatMap(it => (it.kind === 'group' ? it.keys : []))
    const mcp = keys.filter(k => k.mcp !== 'none').length
    // An older bridge prints names alone: nothing is known of their MCP access.
    const hasScopes = !list.note
    const isSearching = search.trim() !== ''

    const quotaRows = limits.length === 0
      ? [<Text dimColor>{T.noQuota}</Text>]
      : limits.map(q => {
        const percent = Math.round(q.percentUsed)
        const cells = Math.round(Math.max(0, Math.min(100, percent)) / 100 * e.props.bodyColumns)
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text>{quotaLabel(q.kind)}</Text>
              <Text color={severity(q.percentUsed)} bold tabular>{percent} %</Text>
            </Box>
            {e.surface !== 'terminal' && 'Svg' in table
              ? <table.Svg source={barSvg(q.percentUsed)} alt={`${quotaLabel(q.kind)} ${percent} %`} height={6} />
              : (
                <Text color={severity(q.percentUsed)} wrap="truncate-end">
                  {'█'.repeat(cells)}<Text dimColor>{'░'.repeat(e.props.bodyColumns - cells)}</Text>
                </Text>
              )}
            {q.resetsAt ? <Text dimColor size="caption">{resetText(q.resetsAt)}</Text> : null}
          </Box>
        )
      })

    const keyRow = (k: VaultKey) => (
      <Box flexDirection="column">
        <Button key={`k:${k.name}`} plain onPress={() => insertMarker($, k.name)}>
          <Text mono weight="semibold">{k.name}</Text>
        </Button>
        <Text dimColor size="caption">
          {!hasScopes ? T.secret : k.mcp === 'none' ? T.shellOnly : T.mcpScope(k.mcp)}
        </Text>
        {canDecide && (
          <Box flexDirection="row" gap={1}>
            <Button key={`mcp:${k.name}`} plain dimColor onPress={() => decide($, 'mcp', k.name)}>MCP</Button>
            <Button key={`del:${k.name}`} plain dimColor onPress={() => decide($, 'delete', k.name)}>{T.deleteKey}</Button>
          </Box>
        )}
      </Box>
    )

    const decision = (key: string, onReview: () => unknown, onRefuse: () => unknown) => (
      <Box flexDirection="row" gap={1}>
        {canDecide && <Button key={`review:${key}`} variant="primary" onPress={onReview}>{T.review}</Button>}
        <Button key={`refuse:${key}`} onPress={onRefuse}>{T.refuse}</Button>
      </Box>
    )
    const requests = [
      ...waiting.replaces.map(p => (
        <Box flexDirection="column">
          <Text weight="semibold">{T.askReplace(p.name)}</Text>
          {p.note ? <Text dimColor size="caption">{T.says(p.note)}</Text> : null}
          {decision(`replace:${p.name}`, () => decide($, 'replace', p.name), () => refuse($, 'refuse-replace', p.name))}
        </Box>
      )),
      ...waiting.mcp.map(r => (
        <Box flexDirection="column">
          <Text weight="semibold">{T.askMcp(r.by ?? 'Claude', r.names.join(', '))}</Text>
          <Text dimColor size="caption">{T.askMcpServers(r.servers ? r.servers.join(', ') : T.everyServer)}</Text>
          {r.reason ? <Text dimColor size="caption">{T.says(r.reason)}</Text> : null}
          {decision(`mcp:${r.rid}`, () => decide($, 'mcp-request', r.rid), () => refuse($, 'refuse-mcp', r.rid))}
        </Box>
      )),
      ...waiting.uses.map(u => (
        <Box flexDirection="column">
          <Text weight="semibold">{T.askUse(u.who ?? 'Claude', u.name)}</Text>
          {decision(`use:${u.id}`, () => decide($, 'use', u.id), () => refuse($, 'refuse-use', u.id))}
        </Box>
      )),
    ]

    // A vault with no group at all reads as a plain list, without a header for nothing.
    const isFlat = list.items.length === 1 && list.items[0]?.kind === 'group' && list.items[0].isUngrouped
    const rows = list.items.map((it, i) => {
      if (it.kind === 'separator') {
        if (isSearching) return null
        return <Text dimColor size="caption">{it.label ? `── ${it.label} ──` : '──────'}</Text>
      }
      const found = shown(it.keys, search, how)
      if (isSearching && found.length === 0) return null
      if (isFlat) return <Box flexDirection="column" gap={1}>{found.map(keyRow)}</Box>
      const name = it.isUngrouped ? T.ungrouped : it.name
      const isFolded = closed.has(it.name)
      return (
        <Box flexDirection="column">
          <Button key={`g:${i}:${it.name}`} plain
            onPress={() => update($, folded, names =>
              names.includes(it.name) ? names.filter(n => n !== it.name) : [...names, it.name])}>
            <Text bold>{isFolded ? '▸' : '▾'} {name}</Text>
            <Text dimColor> ({found.length})</Text>
          </Button>
          {!isFolded && found.map(k => <Box paddingLeft={2}>{keyRow(k)}</Box>)}
        </Box>
      )
    })
    const hasMatch = list.items.some(it => it.kind === 'group' && shown(it.keys, search, how).length > 0)

    return (
      <Box flexDirection="column" gap={1}>
        {requests.length > 0 && (
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" size="caption" weight="semibold">{T.toApprove}  {requests.length}</Text>
            {requests}
          </Box>
        )}
        {said ? <Text color="warning">{said}</Text> : null}
        <Box flexDirection="column" gap={1}>{quotaRows}</Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {list.at > 0 ? <Text dimColor size="caption">{T.updated} {clock(list.at, true)}</Text> : <Text> </Text>}
          <Button key="refresh" plain onPress={() => refresh($)}>↻ {T.refresh}</Button>
        </Box>
        {list.error ? <Text color="error">{list.error}</Text> : null}
        {list.needsSetup
          ? (
            <Box flexDirection="column" gap={1}>
              <Text weight="semibold">{T.setupTitle}</Text>
              <Text dimColor size="caption">{T.setupDetail}</Text>
              <Box><Button key="activate" variant="primary" onPress={() => activate($)}>{T.setupButton}</Button></Box>
            </Box>
          )
          : null}
        {list.error || list.needsSetup
          ? null
          : (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Text dimColor size="caption" weight="semibold">
                  {T.secrets}  {keys.length}{hasScopes && mcp > 0 ? ` · ${mcp} MCP` : ''}
                </Text>
                {e.surface !== 'mobile' && (
                  <Button key="add" variant="primary"
                    onPress={() => update($, newKey, f => ({ isOpen: !f.isOpen }))}>+</Button>
                )}
              </Box>
              {form.isOpen && e.surface !== 'mobile' && e.surface !== 'vscode' && 'Client' in table && (
                <Box flexDirection="column" rowGap="xs">
                  <table.Client key="pane-form" module="./secret-form.tsx"
                    props={{ texts: T.form, message: form.message ?? '', saveTick: form.saveTick ?? 0 }} />
                  {newKeyActions($, e.surface, table, form)}
                </Box>
              )}
              {form.isOpen && e.surface === 'vscode' && 'Input' in table && (
                <Box flexDirection="column" gap={1}>
                  <table.Input key="new-key" placeholder={T.newKeyName} submitLabel={T.newKeyCreate} autoFocus
                    onSubmit={value => createKey($, value)} />
                  <Text dimColor size="caption">{form.message ?? T.newKeyHint}</Text>
                  <Box><Button key="add-cancel" plain onPress={() => update($, newKey, () => ({ isOpen: false }))}>{T.newKeyCancel}</Button></Box>
                </Box>
              )}
              {e.surface !== 'mobile' && 'Input' in table && keys.length > 0 && (
                <Box flexDirection="row" gap={1}>
                  <Box flexGrow={1}>
                    {!keepsOwnInput(e.surface) && 'Client' in table
                      ? <table.Client key="search" module="./key-search.tsx" props={{ placeholder: T.search, initial: search, hasFocus: false }} />
                      : (
                        <table.Input key="search" placeholder={T.search} value={search} submitLabel={' '}
                          onInput={value => update($, query, () => value)}
                          onSubmit={value => update($, query, () => value)} />
                      )}
                  </Box>
                  <table.Select key="order" value={how}
                    options={[
                      { value: 'vault', label: T.orderVault },
                      { value: 'az', label: T.orderAz },
                      { value: 'za', label: T.orderZa },
                    ]}
                    onSelect={value => update($, order, () => value as KeyOrder)} />
                </Box>
              )}
              {keys.length === 0 && list.at > 0 ? <Text dimColor>{T.empty}</Text> : null}
              {isSearching && !hasMatch ? <Text dimColor>{T.noMatch}</Text> : null}
              <Box flexDirection="column" gap={1}>{rows}</Box>
              {list.note
                ? (
                  <Box flexDirection="column">
                    <Text color="warning" size="caption">{list.note}</Text>
                    {canDecide && (
                      <Box flexDirection="column">
                        <Box><Button key="bridge-upgrade" variant="primary" onPress={() => upgrade($)}>{T.upgrade}</Button></Box>
                        <Text dimColor size="caption">{T.upgradeDetail}</Text>
                      </Box>
                    )}
                  </Box>
                )
                : null}
              {canDecide && (
                <Box flexDirection="column" gap={1}>
                  <Text dimColor size="caption" weight="semibold">{T.vaultSection}</Text>
                  {!waiting.hasRecovery && keys.length > 0
                    ? <Text color="warning" size="caption">{T.noRecovery}</Text>
                    : null}
                  <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    <Button key="phrase" variant={waiting.hasRecovery ? 'secondary' : 'primary'} onPress={() => decide($, 'phrase')}>
                      {waiting.hasRecovery ? T.newPhrase : T.makePhrase}
                    </Button>
                    <Button key="restore" onPress={() => decide($, 'restore')}>{T.restore}</Button>
                    {waiting.binned > 0 && <Button key="bin" onPress={() => decide($, 'bin')}>{T.bin(waiting.binned)}</Button>}
                  </Box>
                </Box>
              )}
            </Box>
          )}
        <Text dimColor size="caption">{T.hint}</Text>
        {(e.surface === 'desktop' || e.surface === 'terminal') && (
          <Box>
            <Button key="band-toggle" plain dimColor onPress={() => setBand($, !hasBand)}>
              {hasBand ? T.hideBand : T.showBand}
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
