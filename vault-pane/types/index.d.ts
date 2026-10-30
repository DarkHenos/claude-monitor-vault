// A key as list.js --groups prints it: its name and its MCP scope, never a value.
export type VaultKey = { name: string; mcp: 'none' | 'all' | string }

export type VaultItem =
  | { kind: 'group'; name: string; keys: VaultKey[]; isUngrouped: boolean }
  | { kind: 'separator'; label: string }

// The last listing, or why there is none; `note` when it is only partial.
export type VaultListing = { items: VaultItem[]; error?: string; note?: string; at: number }

export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'vault-pane': {
      listing: Shaped<VaultListing>
      quotas: Shaped<Quota[]>
      folded: Shaped<string[]>
      isShown: Shaped<boolean>
    }
  }
}
