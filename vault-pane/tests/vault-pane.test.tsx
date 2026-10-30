import { expect, mock, test } from 'claude-code/testing'

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
    expect(await ui.find({ type: 'Text', text: /MCP: supabase/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4 / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /91 %/ })).toBeDefined()
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

test('a missing bridge is said in the pane', async ($, on) => {
  const clock = world(on)
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({
    value: {
      exitCode: 1, stdout: '', stderr: "Error: Cannot find module 'list.js'",
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /bridge|pont/ })).toBeDefined()
  await ui.unmount()
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
  expect(await ui.find({ type: 'Text', text: /42 %/ })).toBeDefined()
  await ui.unmount()
})

test('a pane left undrawn at start says to type /vault, and /vault clears it', async ($, on) => {
  const clock = world(on)
  const statuses: (string | undefined)[] = []
  let isAsked = false
  on('command.register', () => ({ value: { command: 'vault' } }))
  on('ui.open', () => ({ value: isAsked ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    statuses.push(e.text)
    return { value: {} }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(statuses.at(-1)).toMatch(/\/vault/)

  isAsked = true
  await $.command.run({ command: 'vault', args: '' })
  await clock.settle()
  expect(statuses.at(-1)).toBeUndefined()
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
    expect(await ui.find({ type: 'Text', text: /MCP/ })).toBeDefined()
    await ui.unmount()
  }
})
