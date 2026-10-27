import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Quota, VaultItem, VaultKey, VaultListing } from '../types'

// The Claude Vault, beside the chat. Everything comes from the vault's own
// read-only listing (list.js --groups): key names, groups, separators and MCP
// scopes. No code path here reads a value, and none is ever drawn.

const PANE = 'claude-vault'
const COMMAND = 'vault'
const REFRESH_MS = 30_000
// The person closed the pane: it stays closed in later sessions until /vault.
const HIDDEN = 'hidden'

// Change a tag when its value's fields change: an older value is then declined.
const listing = atom({ plugin: 'vault-pane', key: 'listing' } as const,
  { items: [], at: 0 } as VaultListing, { shape: 'listing-1' })
const quotas = atom({ plugin: 'vault-pane', key: 'quotas' } as const,
  [] as Quota[], { shape: 'quotas-1' })
const folded = atom({ plugin: 'vault-pane', key: 'folded' } as const,
  [] as string[], { shape: 'folded-1' })

const TEXTS = {
  en: {
    title: 'Claude Vault',
    describe: 'Show the Claude Vault pane: key names, groups, MCP access and quotas',
    opened: 'Claude Vault pane opened.',
    keys: (n: number, mcp: number) => `${n} key${n === 1 ? '' : 's'} · ${mcp} for MCP`,
    empty: 'The vault is empty. Create a key in the Claude Vault view.',
    ungrouped: 'Ungrouped',
    refresh: 'Refresh',
    updated: 'updated',
    hint: 'Click a key to insert its marker in your message.',
    inserted: (name: string) => `{{vault:${name}}} inserted.`,
    noNode: 'Node.js was not found on the PATH: the vault cannot be listed.',
    noBridge: 'The vault bridge is not installed: open VS Code once with the extension.',
    oldBridge: 'Groups and MCP access show once the extension has updated the vault bridge.',
    session: 'Session',
    week: 'Week',
    resets: 'resets',
    noQuota: 'Quotas show after the first reply.',
  },
  fr: {
    title: 'Claude Vault',
    describe: 'Affiche le panneau Claude Vault : noms des clés, groupes, accès MCP et quotas',
    opened: 'Panneau Claude Vault ouvert.',
    keys: (n: number, mcp: number) => `${n} clé${n > 1 ? 's' : ''} · ${mcp} pour MCP`,
    empty: 'Le coffre est vide. Créez une clé dans la vue Claude Vault.',
    ungrouped: 'Sans groupe',
    refresh: 'Actualiser',
    updated: 'à jour',
    hint: 'Clic sur une clé : insère son marqueur dans le message.',
    inserted: (name: string) => `{{vault:${name}}} inséré.`,
    noNode: 'Node.js est introuvable dans le PATH : impossible de lister le coffre.',
    noBridge: "Le pont du coffre n'est pas installé : ouvrez VS Code une fois avec l'extension.",
    oldBridge: "Groupes et accès MCP s'afficheront quand l'extension aura mis à jour le pont du coffre.",
    session: 'Session',
    week: 'Semaine',
    resets: 'reprise',
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
      else if (/Cannot find module/.test(ran.stderr)) next = { items: [], error: T.noBridge, at: Date.now() }
      else next = { items: [], error: ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`, at: Date.now() }
    } catch {
      next = { items: [], error: T.noNode, at: Date.now() }
    }
    await update($, listing, () => next)
  } finally {
    isBusy = false
  }
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

function resetText(resetsAt?: string): string {
  if (!resetsAt) return ''
  const when = new Date(resetsAt)
  if (Number.isNaN(when.getTime())) return ''
  if (when.getTime() - Date.now() < 20 * 3600_000) return `${T.resets} ${clock(resetsAt)}`
  try {
    return `${T.resets} ${when.toLocaleDateString(locale(), { weekday: 'short' })} ${clock(resetsAt)}`
  } catch {
    return ''
  }
}

function severity(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'success'
}

async function open($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: T.title })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: T.describe })
    const usage = await $.session.usage().catch(() => undefined)
    if (usage) await setQuotas($, usage.rateLimits)
    void refresh($)
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
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(HIDDEN, true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await setQuotas($, e.rateLimits)

    return next(e)
  })

  // A key added, moved or regrouped by Claude shows at once, not 30 s later.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (String(e.command).includes('claude-vault-bridge')) void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, listing)
    const limits = await read($, quotas)
    const closed = new Set(await read($, folded))
    const keys = list.items.flatMap(it => (it.kind === 'group' ? it.keys : []))
    const mcp = keys.filter(k => k.mcp !== 'none').length

    const quotaRows = limits.length === 0
      ? [<Text dimColor>{T.noQuota}</Text>]
      : limits.map(q => (
        <Text>
          {q.kind === 'five_hour' ? T.session : q.kind === 'seven_day' ? T.week : q.kind}{' '}
          <Text color={severity(q.percentUsed)} bold>{Math.round(q.percentUsed)} %</Text>
          <Text dimColor> {resetText(q.resetsAt)}</Text>
        </Text>
      ))

    const rows = list.items.map((it, i) => {
      if (it.kind === 'separator') {
        return <Text dimColor>{it.label ? `── ${it.label} ──` : '──────'}</Text>
      }
      const name = it.isUngrouped ? T.ungrouped : it.name
      const isFolded = closed.has(it.name)
      return (
        <Box flexDirection="column">
          <Button key={`g:${i}:${it.name}`} plain
            onPress={() => update($, folded, names =>
              names.includes(it.name) ? names.filter(n => n !== it.name) : [...names, it.name])}>
            <Text bold>{isFolded ? '▸' : '▾'} {name}</Text>
            <Text dimColor> ({it.keys.length})</Text>
          </Button>
          {!isFolded && it.keys.map(k => (
            <Box paddingLeft={2}>
              <Button key={`k:${k.name}`} plain dimColor
                onPress={async () => {
                  const filled = await $.prompt.fill({ text: `{{vault:${k.name}}}`, mode: 'insert' })
                  if (filled.isFilled) await $.ui.toast(T.inserted(k.name))
                }}>
                {k.name}
                {k.mcp !== 'none' && <Text color="suggestion"> MCP{k.mcp === 'all' ? '' : `: ${k.mcp}`}</Text>}
              </Button>
            </Box>
          ))}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">{quotaRows}</Box>
        {list.error
          ? <Text color="error">{list.error}</Text>
          : (
            <Box flexDirection="column">
              <Text dimColor>{keys.length === 0 && list.at > 0 ? T.empty : T.keys(keys.length, mcp)}</Text>
              {list.note ? <Text color="warning">{list.note}</Text> : null}
              {rows}
            </Box>
          )}
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="refresh" onPress={() => refresh($)}>{T.refresh}</Button>
            {list.at > 0 && <Text dimColor>{T.updated} {clock(list.at, true)}</Text>}
          </Box>
          <Text dimColor>{T.hint}</Text>
        </Box>
      </Box>
    )
  })
}
