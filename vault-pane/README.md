# vault-pane

A Claude Code pane that sits beside the chat and shows your Claude Vault: key names, their groups and separators, which keys MCP tools may use, and your Claude session and weekly quotas. It works in the terminal, in VS Code and in the Code tab of Claude Desktop.

It never reads a secret. Everything comes from the vault's own read-only listing (`list.js --groups` in `~/.claude/claude-vault-bridge`), which prints names and MCP scopes only. Quotas come from Claude Code itself.

## Use

- The pane opens with each session. Close it and it stays closed; `/vault` brings it back.
- Click a key to insert its `{{vault:NAME}}` marker in your message.
- Click a group to fold or unfold it.
- It refreshes every 30 seconds, after any command that touches the vault bridge, and with *Refresh*.

## Requirements

- The Claude Monitor & Vault extension, opened at least once in VS Code or a JetBrains IDE: it installs the vault bridge.
- Node.js on the `PATH`.
