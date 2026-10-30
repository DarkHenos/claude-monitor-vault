import type { ClientModule } from 'claude-code'

// The new-key form's two fields, as a surface module: what is typed lives in this
// instance's local state and raises no ui.input, so no other plugin's hook sees it.
// The value leaves once, on Save, in a post only this plugin's hooks receive, and
// goes with the form when it closes. An Input has no masked mode, so it is drawn
// bullets. The buttons are the hook's, drawn natively: a press there raises saveTick.

export type SecretFormTexts = {
  name: string
  value: string
  show: string
  hide: string
  savedAs: string
  invalidName: string
  emptyValue: string
}

export type SecretFormProps = { texts: SecretFormTexts; message: string; saveTick: number }

type FormState = { name: string; value: string; isShown: boolean; lastTick: number; problem?: string }

const EMPTY: FormState = { name: '', value: '', isShown: false, lastTick: 0 }
const BULLET = '•'
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
// An Input draws its submitLabel beside itself: a non-breaking space shows no word.
// Save is said once, on its own button.
const NO_LABEL = '\u00a0'
// In cells, so a field is the size of a field whatever the width of the window.
const FIELD_CELLS = 22

// Spaces and dashes are welcome in what is typed: the key's name has underscores.
export function keyName(typed: string): string {
  return typed.trim().replace(/[\s-]+/g, '_').toUpperCase()
}

// The field holds bullets, so its text says what changed: bullets kept on either
// side of whatever was typed or pasted. All bullets and shorter means a deletion,
// which is taken from the end, since nothing says where the cursor was.
export function unmask(real: string, seen: string): string {
  let before = 0
  while (before < seen.length && seen[before] === BULLET) before++
  if (before === seen.length) return real.slice(0, Math.min(seen.length, real.length))
  let after = 0
  while (after < seen.length - before && seen[seen.length - 1 - after] === BULLET) after++
  const typed = seen.slice(before, seen.length - after)
  return real.slice(0, before) + typed + (after > 0 ? real.slice(-after) : '')
}

const SecretForm: ClientModule<SecretFormProps & Record<string, never>, FormState> = (props, surface) => {
  const { Box, Text, Button, Input } = surface.elements
  const { texts: T, message, saveTick } = props as unknown as SecretFormProps
  const state = surface.state ?? EMPTY
  const current = () => surface.state ?? EMPTY
  const final = keyName(state.name)

  const save = () => {
    const now = current()
    const name = keyName(now.name)
    if (!NAME_RE.test(name)) return surface.setState({ ...now, lastTick: saveTick, problem: T.invalidName })
    if (!now.value) return surface.setState({ ...now, lastTick: saveTick, problem: T.emptyValue })
    surface.setState({ ...now, lastTick: saveTick, problem: undefined })
    return surface.post({ kind: 'save', name, value: now.value })
  }

  // The hook's Save button: a new tick asks for what only this instance holds.
  if (saveTick > state.lastTick) save()

  // Said only when there is something to say: the form stays one row otherwise.
  const note = state.problem ?? (message || undefined)
    ?? (final && final !== state.name.trim() ? `${T.savedAs} ${final}` : undefined)

  // A plain fill behind the field, the same as the search field's (key-search.tsx). Only
  // a border rounds a Box: it takes the fill's color so that no line shows, and paddingY
  // replaces the large padding Desktop gives a border. inverseText is the theme's
  // background-like color.
  return (
    <Box flexDirection="column" rowGap="xs">
      <Box flexDirection="row" alignItems="center" columnGap="xs" rowGap="xs" flexWrap="wrap">
        <Box width={FIELD_CELLS} backgroundColor="inverseText" borderStyle="round" borderColor="inverseText" paddingX="xs" paddingY="xs">
          <Input key="name-field" placeholder={T.name} value={state.name} autoFocus submitLabel={NO_LABEL}
            onInput={value => surface.setState({ ...current(), name: value, problem: undefined })}
            onSubmit={save} />
        </Box>
        <Box width={FIELD_CELLS} backgroundColor="inverseText" borderStyle="round" borderColor="inverseText" paddingX="xs" paddingY="xs">
          <Input key="value-field" placeholder={T.value} submitLabel={NO_LABEL}
            value={state.isShown ? state.value : BULLET.repeat(state.value.length)}
            onInput={seen => {
              const now = current()
              surface.setState({ ...now, value: now.isShown ? seen : unmask(now.value, seen), problem: undefined })
            }}
            onSubmit={save} />
        </Box>
        <Button key="show-value" plain dimColor onPress={() => surface.setState({ ...current(), isShown: !current().isShown })}>
          <Text size="caption">{state.isShown ? T.hide : T.show}</Text>
        </Button>
      </Box>
      {note ? <Text color={state.problem ? 'error' : undefined} dimColor={!state.problem} size="caption">{note}</Text> : null}
    </Box>
  )
}

export default SecretForm
