import { expect, mock, test } from 'claude-code/testing'

import KeySearch from '../hooks/key-search'
import SecretForm, { keyName, unmask } from '../hooks/secret-form'

const PANE = {
  plugin: 'vault-pane',
  component: 'Pane',
  requestId: 'claude-vault',
  props: {
    title: 'Claude Vault',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// What list.js --groups prints: names and scopes only. The names are made up.
const LISTING = [
  '# Cloud',
  'DEMO_ACCESS_KEY\tmcp:all',
  'DEMO_DB_PASSWORD\t-',
  '--- prod\t@2',
  '# Database',
  'DEMO_SECRET\tmcp:supabase',
  '# Ungrouped',
  'DEMO_LOOSE\t-',
  '',
].join('\n')

function world(on: any, env: Record<string, string> = {}) {
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/me', ...env })
  return mock.clock(on)
}

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function engine(on: any, argvs: string[][], fills: string[]) {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: {} }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [
        { kind: 'five_hour', percentUsed: 7 },
        { kind: 'seven_day', percentUsed: 91 },
      ],
    },
  }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    argvs.push(e.argv)
    return { value: { exitCode: 0, stdout: LISTING, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return clock
}

test('the pane lists groups, keys and quotas on every surface', async ($, on) => {
  const argvs: string[][] = []
  const clock = engine(on, argvs, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(argvs[0]).toEqual(['node', 'C:/Users/me/.claude/claude-vault-bridge/list.js', '--groups'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Cloud/ })).toBeDefined()
    expect(await ui.find({ key: 'k:DEMO_ACCESS_KEY' })).toBeDefined()
    expect(await ui.find({ key: 'k:DEMO_LOOSE' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /MCP ?: supabase/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /SECRETS\s+4 · 2 MCP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /91\s%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /prod/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a key pressed inserts its marker, a group pressed folds', async ($, on) => {
  const fills: string[] = []
  const clock = engine(on, [], fills)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'k:DEMO_LOOSE' })
    expect(fills.at(-1)).toBe('{{' + 'vault:DEMO_LOOSE}}')

    await ui.press({ key: 'g:0:Cloud' })
    expect(await ui.find({ key: 'k:DEMO_ACCESS_KEY' })).toBeUndefined()
    await ui.press({ key: 'g:0:Cloud' })
    expect(await ui.find({ key: 'k:DEMO_ACCESS_KEY' })).toBeDefined()
    await ui.unmount()
  }
})

test('the search narrows the keys and the sort orders them', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.post({ kind: 'query', text: 'secret' })
  expect(await ui.find({ key: 'k:DEMO_SECRET' })).toBeDefined()
  expect(await ui.find({ key: 'k:DEMO_LOOSE' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /prod/ })).toBeUndefined()

  await ui.post({ kind: 'query', text: 'nothing here' })
  expect(await ui.find({ type: 'Text', text: /No key matches|Aucune clé/ })).toBeDefined()

  await ui.post({ kind: 'query', text: '' })
  await ui.select({ key: 'order', value: 'za' })
  const pressable = await ui.findAll({ type: 'Button' })
  const cloud = pressable.map(b => b.key).filter(k => k === 'k:DEMO_ACCESS_KEY' || k === 'k:DEMO_DB_PASSWORD')
  expect(cloud).toEqual(['k:DEMO_DB_PASSWORD', 'k:DEMO_ACCESS_KEY'])
  await ui.unmount()
})

test('the search is the form field on Desktop, and a terminal keeps its own Input', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Client', key: 'search' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Input', key: 'search' })).toBeDefined()
  await terminal.input({ key: 'search', text: 'secret', kind: 'change' })
  expect(await terminal.find({ key: 'k:DEMO_LOOSE' })).toBeUndefined()
  await terminal.input({ key: 'search', text: '', kind: 'change' })
  await terminal.unmount()
})

test('the search field keeps what is typed and posts it, without a value of its own', () => {
  const stand = (type: string) => (props: Record<string, unknown>) => ({ type, props })
  let state: any
  const posted: unknown[] = []
  const surface: any = {
    elements: { Box: stand('Box'), Input: stand('Input') },
    get state() { return state },
    setState: (next: unknown) => { state = next },
    post: (data: unknown) => posted.push(data),
  }
  // Finds the field wherever the JSX runtime put it.
  const find = (node: any, seen = new Set()): any => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined
    seen.add(node)
    if (node.key === 'search-field' || node.props?.key === 'search-field') return node
    for (const value of Object.values(node)) {
      const hit = find(value, seen)
      if (hit) return hit
    }
    return undefined
  }
  const field = () => find((KeySearch as any)({ placeholder: 'p', initial: 'old', hasFocus: false }, surface)).props
  expect(field().value).toBe('old')
  expect('autoFocus' in field()).toBe(false)
  field().onInput('new')
  expect(field().value).toBe('new')
  field().onSubmit('new')
  expect(posted).toEqual([{ kind: 'query', text: 'new' }, { kind: 'submit', text: 'new' }])
})

test('the quota bar is an image on a graphical surface, characters in a terminal', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /█/ })).toBeDefined()
  await terminal.unmount()
})

test('without a bridge the pane offers to activate the one it carries, and asks first', async ($, on) => {
  const clock = world(on)
  const runs: string[][] = []
  let isInstalled = false
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const isSetup = e.argv.some(a => a.endsWith('setup.js'))
    if (e.argv.includes('--activate')) isInstalled = true
    const isMissing = !isSetup && !isInstalled
    return {
      value: {
        exitCode: isMissing ? 1 : 0,
        stdout: isSetup ? 'installed\n' : isMissing ? '' : 'DEMO_ONE\t-\n',
        stderr: isMissing ? "Error: Cannot find module 'list.js'" : '',
        isStdoutTruncated: false, isStderrTruncated: false,
      },
    }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // Nothing is installed until the press: --update alone never installs.
  expect(runs.some(a => a.includes('--activate'))).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'activate' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /VS Code is not needed|VS Code n'est pas nécessaire/ })).toBeDefined()

  await ui.press({ key: 'activate' })
  await clock.settle()
  expect(runs.some(a => a.includes('--activate'))).toBe(true)
  expect(await ui.find({ key: 'activate' })).toBeUndefined()
  expect(await ui.find({ key: 'k:DEMO_ONE' })).toBeDefined()
  await ui.unmount()
})

test('the form masks what is typed, and the name takes underscores', () => {
  expect(keyName('  my new-key ')).toBe('MY_NEW_KEY')
  // Typing, at the end and in the middle, and pasting over bullets.
  expect(unmask('', 'a')).toBe('a')
  expect(unmask('abc', '•••d')).toBe('abcd')
  expect(unmask('abc', '•x••')).toBe('axbc')
  expect(unmask('abc', 'pasted')).toBe('pasted')
  expect(unmask('abc', '•••pasted')).toBe('abcpasted')
  // Deleting, and clearing.
  expect(unmask('abc', '••')).toBe('ab')
  expect(unmask('abc', '')).toBe('')
})

test('the form holds the value masked, shows it on request and posts it once, on Save', () => {
  const stand = (type: string) => (props: Record<string, unknown>) => ({ type, props })
  let state: any
  const posted: any[] = []
  const surface: any = {
    elements: { Box: stand('Box'), Text: stand('Text'), Button: stand('Button'), Input: stand('Input') },
    get state() { return state },
    setState: (next: unknown) => { state = next },
    post: (data: unknown) => posted.push(data),
  }
  const texts = {
    name: 'n', value: 'v', show: 'show', hide: 'hide', mcpLabel: 'ml', save: 's', cancel: 'c',
    savedAs: 'as', invalidName: 'bad name', emptyValue: 'no value',
  }
  let tick = 0
  const draw = () => (SecretForm as any)({ texts, message: '', saveTick: tick }, surface)
  // The hook's Save button raises the tick; the instance answers on its next draw.
  const pressSave = () => {
    tick++
    draw()
  }
  // Finds a keyed element wherever the JSX runtime put it.
  const find = (node: any, key: string, seen = new Set()): any => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined
    seen.add(node)
    if (node.key === key || node.props?.key === key) return node
    for (const value of Object.values(node)) {
      const hit = find(value, key, seen)
      if (hit) return hit
    }
    return undefined
  }
  const props = (key: string) => find(draw(), key).props
  const words = (node: any): string => JSON.stringify(node)

  // Save with nothing refuses, and posts nothing.
  pressSave()
  expect(words(draw())).toContain('bad name')
  props('name-field').onInput('my new-key')
  expect(words(draw())).toContain('MY_NEW_KEY')
  pressSave()
  expect(words(draw())).toContain('no value')
  expect(posted.length).toBe(0)

  // Typed and pasted, it is bullets in the field; nothing but bullets is drawn.
  const VALUE = 'made-up-value'
  props('value-field').onInput('made-up')
  props('value-field').onInput('•••••••-value')
  expect(props('value-field').value).toBe('•'.repeat(VALUE.length))
  expect(words(draw())).not.toContain('made-up')

  // Shown on request, hidden again.
  props('show-value').onPress()
  expect(props('value-field').value).toBe(VALUE)
  props('show-value').onPress()
  expect(props('value-field').value).toBe('•'.repeat(VALUE.length))

  // No symbol or second word beside the fields.
  expect(props('value-field').submitLabel.trim()).toBe('')

  // Save posts the whole key, once, and a redraw does not post it again.
  pressSave()
  expect(posted).toEqual([{ kind: 'save', name: 'MY_NEW_KEY', value: VALUE }])
  draw()
  expect(posted.length).toBe(1)

  // Enter in a field saves too.
  props('value-field').onSubmit(VALUE)
  expect(posted.length).toBe(2)
})

test('where no form module can run, a new key hands a name to the window, never a value', async ($, on) => {
  const argvs: string[][] = []
  const clock = engine(on, argvs, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'add' })
  await ui.input({ key: 'new-key', text: '9 bad name', kind: 'submit' })
  await clock.settle()
  expect(argvs.some(a => a.some(x => x.endsWith('new-key.js')))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /_/ })).toBeDefined()

  await ui.input({ key: 'new-key', text: 'demo_new', kind: 'submit' })
  await clock.settle()
  const opened = argvs.find(a => a.some(x => x.endsWith('new-key.js')))
  expect(opened?.slice(2)).toEqual(['DEMO_NEW', '--window'])
  expect(await ui.find({ key: 'add-cancel' })).toBeUndefined()
  await ui.unmount()
})

// A vault with something waiting, as tools/owner.js status prints it.
function ownerWorld(on: any, runs: string[][], isPlaced = () => true) {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: isPlaced() ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const isStatus = e.argv.at(-1) === 'status'
    return {
      value: {
        exitCode: 0,
        stdout: isStatus
          ? JSON.stringify({
            replaces: [{ name: 'DEMO_LOOSE', kind: 'secret', length: 12, note: 'rotation' }],
            mcp: [{ rid: 'req1', names: ['DEMO_LOOSE'], servers: ['github'], by: 'claude', reason: null }],
            uses: [{ id: 'use1', name: 'DEMO_LOOSE', who: null }],
            hasRecovery: false,
            binned: 2,
          })
          : LISTING,
        stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      },
    }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return clock
}

test('what waits for the owner shows, and approving only ever opens the window', async ($, on) => {
  const runs: string[][] = []
  const clock = ownerWorld(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /DEMO_LOOSE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /github/ })).toBeDefined()
  expect(await ui.find({ key: 'review:replace:DEMO_LOOSE' })).toBeDefined()

  const window = (action: string, argument?: string) => runs.some(a =>
    a.includes('--window') && a.includes(action) && (argument === undefined || a.includes(argument)))

  await ui.press({ key: 'review:replace:DEMO_LOOSE' })
  await clock.settle()
  expect(window('replace', 'DEMO_LOOSE')).toBe(true)
  await ui.press({ key: 'review:mcp:req1' })
  await clock.settle()
  expect(window('mcp-request', 'req1')).toBe(true)
  await ui.press({ key: 'review:use:use1' })
  await clock.settle()
  expect(window('use', 'use1')).toBe(true)

  // A refusal gives nothing away: no window.
  await ui.press({ key: 'refuse:replace:DEMO_LOOSE' })
  await clock.settle()
  expect(runs.some(a => a.includes('refuse-replace') && !a.includes('--window'))).toBe(true)
  await ui.unmount()
})

test('each key can be deleted or opened to MCP, and the recovery phrase is offered', async ($, on) => {
  const runs: string[][] = []
  const clock = ownerWorld(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /recovery phrase|phrase de récupération/ })).toBeDefined()
  for (const [key, action] of [['del:DEMO_LOOSE', 'delete'], ['mcp:DEMO_LOOSE', 'mcp'], ['phrase', 'phrase'], ['restore', 'restore'], ['bin', 'bin']] as const) {
    await ui.press({ key })
    await clock.settle()
    expect(runs.some(a => a.includes('--window') && a.includes(action))).toBe(true)
  }
  await ui.unmount()

  // No decision can be raised from a phone: its window would open out of sight.
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ key: 'del:DEMO_LOOSE' })).toBeUndefined()
  expect(await phone.find({ key: 'phrase' })).toBeUndefined()
  expect(await phone.find({ key: 'review:replace:DEMO_LOOSE' })).toBeUndefined()
  await phone.unmount()
})

test('a command of Claude\'s cannot reach the tools or the copy of the bridge', async ($, on) => {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  let ran = 0
  on('tool.call', () => { ran++; return { result: {} } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const call = (tool: string, command: string) => ($ as any).tool.call({ tool, command, input: { command } })
  for (const tool of ['Bash', 'PowerShell']) {
    const denied = await call(tool, 'node C:\\Users\\me\\.claude\\plugins\\cache\\claude-monitor-vault\\vault-pane\\0.3.0\\tools\\owner.js phrase')
    expect(denied.deny).toBeDefined()
    expect((await call(tool, 'node ~/.claude/plugins/marketplaces/claude-monitor-vault/vault-pane/bridge/get.js X')).deny).toBeDefined()
  }
  expect(ran).toBe(0)
  await call('Bash', 'echo fine')
  expect(ran).toBe(1)
})

test('a cloud session says the vault stays on the computer, and keeps the quotas', async ($, on) => {
  const clock = world(on, { CLAUDE_CODE_REMOTE: 'true', HOME: '/root' })
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] },
  }))
  on('process.run', () => ({
    value: {
      exitCode: 1, stdout: '', stderr: "Error: Cannot find module '/root/.claude/claude-vault-bridge/list.js'",
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cloud|cloud/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bridge is not installed|pont du coffre/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /42\s%/ })).toBeDefined()
  await ui.unmount()
})

test('the band icon opens the pane, and the pane shows and hides the band', async ($, on) => {
  const clock = world(on)
  const opens: unknown[] = []
  let isAsked = false
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', (_: unknown, e: unknown) => {
    opens.push(e)
    return { value: isAsked ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] },
  }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Stands for the engine's own band once the launcher steps aside.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const BAND = { plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 100 } } as any
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /12\s%/ })).toBeDefined()
  expect(await band.find({ type: 'Svg' })).toBeDefined()

  // The logo beside the name, which opens the pane; no label, which Desktop would
  // draw in place of the children.
  const launch = await band.find({ key: 'launch' })
  expect(launch?.text).toBe('Claude Vault')
  expect(launch?.props.label ?? 'Claude Vault').toBe('Claude Vault')
  expect(((await band.findAll({ type: 'Svg' }))[0]?.props.source as string)).toContain('#62B5A5')
  expect(await band.find({ key: 'band-hide' })).toBeUndefined()

  // Opened, the icon goes: the band opens the pane, the pane closes itself.
  isAsked = true
  await band.press({ key: 'launch' })
  await clock.settle()
  expect(opens.length).toBe(2)
  expect(await band.find({ key: 'launch' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /12\s%/ })).toBeDefined()

  // The pane hides the band, and brings it back.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'band-toggle' }))?.text).toMatch(/Hide the bar|Masquer la barre/)
  await pane.press({ key: 'band-toggle' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /12\s%/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /engine/ })).toBeDefined()
  expect((await pane.find({ key: 'band-toggle' }))?.text).toMatch(/Show the bar|Afficher la barre/)

  // Hidden stays hidden for the next session.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /12\s%/ })).toBeUndefined()

  await pane.press({ key: 'band-toggle' })
  await clock.settle()
  await pane.unmount()
  await band.unmount()

  // A band too narrow for everything keeps the figures.
  const narrow = await $.ui.mount({ ...BAND, props: { hasSurvey: false, bodyColumns: 40 } })
  expect((await narrow.findAll({ type: 'Svg' })).length).toBe(1)
  expect(await narrow.find({ type: 'Text', text: /12\s%/ })).toBeDefined()
  await narrow.unmount()
})

test('the band names the vault, and its keys go into the message from there', async ($, on) => {
  const fills: string[] = []
  const clock = engine(on, [], fills)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const mount = (bodyColumns: number) => $.ui.mount({
    plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns },
  } as any)

  // The pane is open here, and the band still says what it is about.
  const wide = await mount(160)
  expect(await wide.find({ type: 'Text', text: /Claude Vault/ })).toBeDefined()

  // Closed, the list takes one control; open, a search field over every key.
  expect((await wide.find({ key: 'band-keys' }))?.text).toMatch(/\(4\) ▾/)
  expect(await wide.find({ key: 'band-search' })).toBeUndefined()
  await wide.press({ key: 'band-keys' })
  for (const name of ['DEMO_ACCESS_KEY', 'DEMO_DB_PASSWORD', 'DEMO_SECRET', 'DEMO_LOOSE']) {
    expect(await wide.find({ key: `band-k:${name}` })).toBeDefined()
  }

  // Typing narrows it, whatever the case.
  await wide.post({ kind: 'query', text: 'secr' })
  expect(await wide.find({ key: 'band-k:DEMO_SECRET' })).toBeDefined()
  expect(await wide.find({ key: 'band-k:DEMO_LOOSE' })).toBeUndefined()

  // A press inserts the marker, closes the list and forgets the search.
  await wide.press({ key: 'band-k:DEMO_SECRET' })
  expect(fills.at(-1)).toBe('{{' + 'vault:DEMO_SECRET}}')
  expect(await wide.find({ key: 'band-search' })).toBeUndefined()
  await wide.press({ key: 'band-keys' })
  expect(await wide.find({ key: 'band-k:DEMO_LOOSE' })).toBeDefined()

  // Enter takes the first match; with none, nothing goes in and it says so.
  const before = fills.length
  await wide.post({ kind: 'query', text: 'nothing here' })
  expect(await wide.find({ type: 'Text', text: /No key matches|Aucune clé/ })).toBeDefined()
  await wide.post({ kind: 'submit', text: 'nothing here' })
  expect(fills.length).toBe(before)
  await wide.post({ kind: 'submit', text: 'loose' })
  expect(fills.at(-1)).toBe('{{' + 'vault:DEMO_LOOSE}}')
  expect(await wide.find({ key: 'band-search' })).toBeUndefined()

  // The arrow closes it too, with nothing inserted.
  await wide.press({ key: 'band-keys' })
  await wide.press({ key: 'band-keys' })
  expect(await wide.find({ key: 'band-search' })).toBeUndefined()
  await wide.unmount()

  // No room problem any more: narrow, the list and the figures remain.
  const narrow = await mount(44)
  expect(await narrow.find({ key: 'band-keys' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /91\s%/ })).toBeDefined()
  await narrow.unmount()
})

test('when a quota resets shows in the band and the pane, at any width', async ($, on) => {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'DEMO_ONE\t-\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const bodyColumns of [160, 80, 40]) {
    const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns } } as any)
    expect(await band.find({ type: 'Text', text: /^(resets|réinit\.)\s\S/ })).toBeDefined()
    await band.unmount()
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^(Resets|Réinitialisation : )/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /reprise/ })).toBeUndefined()
  await pane.unmount()
})

test('with the pane open, the band fills the form the pane already holds', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 100 } } as any)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Client', key: 'pane-form' })).toBeUndefined()
  await band.press({ key: 'band-add' })
  await clock.settle()
  expect(await pane.find({ type: 'Client', key: 'pane-form' })).toBeDefined()
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeUndefined()
  await pane.unmount()
  await band.unmount()
})

test('with the pane closed, the band creates a key without opening it', async ($, on) => {
  const clock = world(on)
  const runs: string[][] = []
  const stdins: string[] = []
  const VALUE = 'made-up-value'
  let taken = false
  let opens = 0
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.toast', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', (_: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    runs.push(e.argv)
    if (e.init?.stdin) stdins.push(e.init.stdin)
    const isStore = e.argv.some(a => a.endsWith('store-key.js'))
    return { value: { exitCode: isStore && taken ? 7 : 0, stdout: LISTING, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const opensAtStart = opens

  const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 100 } } as any)
  await band.press({ key: 'band-add' })
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeDefined()

  // One open at a time: the list of keys closes the form, and the other way round.
  await band.press({ key: 'band-keys' })
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeUndefined()
  expect(await band.find({ key: 'band-search' })).toBeDefined()
  await band.press({ key: 'band-add' })
  expect(await band.find({ key: 'band-search' })).toBeUndefined()

  const saves = () => runs.filter(a => a.some(x => x.endsWith('store-key.js')))

  const formProps = async () => (await band.find({ type: 'Client', key: 'band-form' }))?.props.props as { message?: string; saveTick?: number }

  // The hook's Save only raises a tick: the value is the form's, and comes back posted.
  expect((await formProps()).saveTick).toBe(0)
  await band.press({ key: 'form-save' })
  expect((await formProps()).saveTick).toBe(1)
  expect(saves().length).toBe(0)

  // What the form posts is not trusted: a bad name stores nothing, and says why.
  await band.post({ kind: 'save', name: '9 bad', value: VALUE })
  await clock.settle()
  expect(saves().length).toBe(0)
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeDefined()

  // The box is a picture; it and its label both toggle, and it decides, not the post.
  const checkBox = async () => (await band.findAll({ type: 'Svg' })).map(x => String(x.props.source)).find(s => s.includes('width="16"'))
  expect(await checkBox()).not.toContain('<path')
  await band.press({ key: 'form-mcp' })
  expect(await checkBox()).toContain('<path')
  await band.press({ key: 'form-mcp-box' })
  expect(await checkBox()).not.toContain('<path')
  await band.press({ key: 'form-mcp' })

  // A name with spaces becomes underscores; the value is on no command line.
  await band.post({ kind: 'save', name: 'my new-key', value: VALUE, hasMcp: false })
  await clock.settle()
  expect(saves().length).toBe(1)
  expect(saves().flat().join(' ')).not.toContain(VALUE)
  expect(JSON.parse(stdins.at(-1) ?? '{}')).toMatchObject({ name: 'MY_NEW_KEY', value: VALUE, hasMcp: true })
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeUndefined()

  // A name already taken keeps the form open and says so.
  taken = true
  await band.press({ key: 'band-add' })
  await band.post({ kind: 'save', name: 'DEMO_LOOSE', value: VALUE })
  await clock.settle()
  expect(String((await formProps()).message)).toContain('DEMO_LOOSE')

  // Cancel closes it. The side panel was never asked for.
  await band.press({ key: 'form-cancel' })
  await clock.settle()
  expect(await band.find({ type: 'Client', key: 'band-form' })).toBeUndefined()
  expect(opens).toBe(opensAtStart)
  await band.unmount()
})

test('without a bridge the band says so, and a press opens the pane that activates it', async ($, on) => {
  const clock = world(on)
  let isAsked = false
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: isAsked ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: "Error: Cannot find module 'list.js'", isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 100 } } as any)
  expect((await band.find({ key: 'band-setup' }))?.text).toMatch(/activate|activer/)
  isAsked = true
  await band.press({ key: 'band-setup' })
  await clock.settle()
  expect(await band.find({ key: 'band-setup' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /activate|activer/ })).toBeDefined()
  await band.unmount()
})

test('the pane draws its icons, not a label in their place', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const [key, text] of [['add', /^\+$/], ['refresh', /^↻ /]] as const) {
    const found = await ui.find({ key })
    expect(found?.text).toMatch(text)
    // The engine fills in a one-string child as the label: nothing else may take its place.
    expect(found?.props.label ?? found?.text).toBe(found?.text)
  }
  await ui.unmount()
})

test('the band says what waits, and a press on it opens the pane', async ($, on) => {
  const runs: string[][] = []
  let isAsked = false
  const clock = ownerWorld(on, runs, () => isAsked)
  on('ui.toast', () => ({ value: {} }))
  // Stands for the engine's own band, which a survey holds.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // The pane is closed: the count opens it.
  const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 100 } } as any)
  const count = /3 (to approve|à valider)/
  expect(await band.find({ type: 'Text', text: count })).toBeDefined()
  isAsked = true
  await band.press({ key: 'band-approve' })
  await clock.settle()

  // Open: the count stays, with nothing left to press.
  expect(await band.find({ key: 'band-approve' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: count })).toBeDefined()
  await band.unmount()

  // A survey holds the band: the mod steps aside.
  const survey = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: true, bodyColumns: 100 } } as any)
  expect(await survey.find({ type: 'Text', text: count })).toBeUndefined()
  await survey.unmount()
})

test('an older bridge is updated only on a press, and an older extension is named', async ($, on) => {
  const clock = world(on)
  const runs: string[][] = []
  let isUpgraded = false
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('--upgrade')) {
      isUpgraded = true
      return ok('upgraded extension=1.0.0\n')
    }
    if (e.argv.includes('--groups') && !isUpgraded) {
      return { value: { exitCode: 1, stdout: '', stderr: 'claude-vault: list takes no argument\n', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return ok('DEMO_ONE\t-\n')
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(runs.some(a => a.includes('--upgrade'))).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'bridge-upgrade' })
  await clock.settle()
  expect(runs.some(a => a.includes('--upgrade'))).toBe(true)
  expect(await ui.find({ key: 'bridge-upgrade' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1\.0\.0/ })).toBeDefined()
  await ui.unmount()
})

test('an older bridge still lists the names', async ($, on) => {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => ({
    value: e.argv.includes('--groups')
      ? { exitCode: 1, stdout: '', stderr: 'claude-vault: list takes no argument\n', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: 'DEMO_ONE\nDEMO_TWO\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'k:DEMO_ONE' })).toBeDefined()
    expect(await ui.find({ key: 'k:DEMO_TWO' })).toBeDefined()
    // The note says why MCP access is missing, and no count claims there is none.
    expect(await ui.find({ type: 'Text', text: /MCP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /SECRETS\s+2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /shell/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('in the band a figure and its unit never part over two lines', async ($, on) => {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'seven_day', percentUsed: 4, resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString() }] },
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'vault-pane', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, bodyColumns: 120 } } as any)
  const percent = await band.find({ type: 'Text', text: /^4\s%$/ })
  expect(percent?.text).not.toContain(' ')
  expect(percent?.props.wrap).toBe('truncate')
  const reset = await band.find({ type: 'Text', text: /^(resets|réinit\.)/ })
  expect(reset?.text).not.toContain(' ')
  expect(reset?.props.wrap).toBe('truncate')
  await band.unmount()
})
