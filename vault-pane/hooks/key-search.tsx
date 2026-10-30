import type { ClientModule } from 'claude-code'

// The search field, as a surface module so that it is the same field in the same frame
// as the new-key form's (secret-form.tsx). Only names are searched, so what is typed
// goes to the hook, which does the filtering.

export type KeySearchProps = { placeholder: string; initial: string; hasFocus: boolean }

type SearchState = { text: string }

// As in secret-form.tsx: no word beside the field, and the same size.
const NO_LABEL = '\u00a0'
const FIELD_CELLS = 22

const KeySearch: ClientModule<KeySearchProps & Record<string, never>, SearchState> = (props, surface) => {
  const { Box, Input } = surface.elements
  const { placeholder, initial, hasFocus } = props as unknown as KeySearchProps
  const text = surface.state?.text ?? initial

  // The same frame as the new-key form's fields: see secret-form.tsx.
  return (
    <Box width={FIELD_CELLS} backgroundColor="inverseText" borderStyle="round" borderColor="inverseText" paddingX="xs" paddingY="xs">
      <Input key="search-field" placeholder={placeholder} value={text} submitLabel={NO_LABEL}
        {...(hasFocus ? { autoFocus: true as const } : {})}
        onInput={value => {
          surface.setState({ text: value })
          surface.post({ kind: 'query', text: value })
        }}
        onSubmit={value => surface.post({ kind: 'submit', text: value })} />
    </Box>
  )
}

export default KeySearch
