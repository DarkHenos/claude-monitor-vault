# vault-pane

A Claude Code pane that sits beside the chat and shows your Claude Vault: key names, their groups and separators, which keys MCP tools may use, and your Claude session and weekly quotas. It works in the terminal, in VS Code and in the Code tab of Claude Desktop.

It never reads a secret. Everything comes from the vault's own read-only listing (`list.js --groups` in `~/.claude/claude-vault-bridge`), which prints names and MCP scopes only. Quotas come from Claude Code itself.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install vault-pane --marketplace DarkHenos/claude-monitor-vault
```

From a shell:

```sh
claude plugin install vault-pane --marketplace DarkHenos/claude-monitor-vault
```

Answer `y` to add the marketplace, then pick a scope (user is the first one).

In Claude Desktop, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `DarkHenos/claude-monitor-vault`, then **Add plugin**.

## Use

- The pane opens with each session, docked beside the chat when the window is wide enough.
- When it is not shown, a **🔐 Claude Vault** button sits above the prompt with the quotas beside it: click it to open the pane. `/vault` does the same.
- Close the pane and it stays closed in later sessions until you click the button or type `/vault`.
- Click a key to insert its `{{vault:NAME}}` marker in your message.
- Click a group to fold or unfold it.
- It refreshes every 30 seconds, after any command that touches the vault bridge, and with *Refresh*.

## Requirements

- The Claude Monitor & Vault extension, opened at least once in VS Code or a JetBrains IDE: it installs the vault bridge.
- Node.js on the `PATH`.

## Local and cloud sessions

The vault lives on your own computer. In a local session (terminal, VS Code, or the Code tab of Claude Desktop running on your machine) the pane lists it. In a cloud session the pane runs in a remote container that has no vault: it says so and shows the quotas only. This is on purpose: the vault never leaves your computer.
