// A key as list.js --groups prints it: its name and its MCP scope, never a value.
export type VaultKey = { name: string; mcp: 'none' | 'all' | string }

export type VaultItem =
  | { kind: 'group'; name: string; keys: VaultKey[]; isUngrouped: boolean }
  | { kind: 'separator'; label: string }

// The last listing, or why there is none; `note` when it is only partial;
// `needsSetup` when this computer has no bridge yet and the pane can install it.
export type VaultListing = { items: VaultItem[]; error?: string; note?: string; needsSetup?: boolean; at: number }

// What waits for the owner, as tools/owner.js status prints it: never a value.
export type OwnerStatus = {
  replaces: { name: string; kind: string; length: number; note: string | null }[]
  mcp: { rid: string; names: string[]; servers: string[] | null; by: string | null; reason: string | null }[]
  uses: { id: string; name: string; who: string | null }[]
  hasRecovery: boolean
  binned: number
}

// The new-key form: closed, or open with what it last had to say, the MCP box, and
// how many times Save was pressed. The fields' text is never here.
export type NewKeyForm = { isOpen: boolean; message?: string; hasMcp?: boolean; saveTick?: number }

export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

// How keys sort within a group: the vault's own order, or by name.
export type KeyOrder = 'vault' | 'az' | 'za'

declare module 'claude-code' {
  interface PluginState {
    'vault-pane': {
      listing: Shaped<VaultListing>
      quotas: Shaped<Quota[]>
      folded: Shaped<string[]>
      isShown: Shaped<boolean>
      isBandShown: Shaped<boolean>
      query: Shaped<string>
      isPickerOpen: Shaped<boolean>
      pickerQuery: Shaped<string>
      order: Shaped<KeyOrder>
      newKey: Shaped<NewKeyForm>
      owner: Shaped<OwnerStatus>
      notice: Shaped<string>
    }
  }
}
