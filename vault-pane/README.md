# vault-pane

A Claude Code pane that sits beside the chat and shows your Claude Vault: key names, their groups and separators, which keys MCP tools may use, and your Claude session and weekly quotas. It works in the terminal, in VS Code and in the Code tab of Claude Desktop, and it needs neither VS Code nor the extension: the mod carries the vault bridge.

It never reads a stored secret. The list comes from the vault's own read-only listing (`list.js --groups` in `~/.claude/claude-vault-bridge`), which prints names and MCP scopes only. A new key's value is typed in the mod's form: it stays in that form, which no other mod sees, and crosses the mod once, on Save, on its way to the vault by stdin. It reaches neither the conversation nor a command line. Quotas come from Claude Code itself.

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

- On a computer without the vault, the pane offers **Activate the vault**. One click installs the bridge and adds its hooks to `settings.json`, backed up first. If the extension is installed later, it takes over the same bridge and the same vault.
- **+** creates a key on the spot: its name (spaces become underscores), its value, masked with a button to show it, and a box to open it to MCP tools at once, with **Cancel** and **Save** at the right. In VS Code, where that form cannot run, give the name and type the value in the window that opens.
- Search the keys and sort them by name above the list.
- What Claude asks of you appears at the top under **To approve**: **Review** opens the window to decide, **Refuse** answers at once.
- Each key has **MCP** and **Delete**; a deleted key waits 30 days in the bin.
- Under **Vault**, create your recovery phrase, generate a new one without giving the old one, show it again, go through the phrase history, restore a vault with it, or open the bin. Without a phrase the pane says so: if this computer's key is lost, your keys are lost with it.
- **Create a transfer string** puts every key in one long line of text, encrypted with a password you choose, for the clipboard or a file. **Import a string** reads it from the clipboard or a file on the other machine, shows what would change, and adds the keys to the ones already there.
- The pane opens with each session, docked beside the chat when the window is wide enough.
- A bar sits above the prompt. The name opens the side panel while it is closed; next to it, **Insert a key ▾** opens a search field over your keys (click one, or press Enter for the first match, to insert its marker in your message), **+** creates a key right there, without opening the panel, and what waits for your approval shows. The quotas sit at the right with their reset times. `/vault` opens the pane too.
- Hide or show that bar from the bottom of the pane.
- Close the pane or hide the bar and it stays that way in later sessions until you open it again.
- Click a key to insert its `{{vault:NAME}}` marker in your message.
- Click a group to fold or unfold it.
- It refreshes every 30 seconds, after any command that touches the vault bridge, and with *Refresh*.

## Requirements

- Node.js on the `PATH`. That is all: VS Code and the extension are optional.

## With an older extension

An older extension's bridge is left alone: the pane says so and offers **Update the bridge**. One click copies your vault's encrypted files to `~/.claude/vault-backup-<date>`, then installs the mod's bridge. Update or uninstall that extension afterwards, or it puts its own bridge back whenever VS Code opens.

## Without the extension

Everything needed to run the vault works: markers, the guard on vault files, listing and creating keys, approving or refusing what Claude asks (a replacement, MCP access, a use of a key that asks every time), deleting a key and bringing it back from the bin, MCP access by key, the recovery phrase and its history, and the transfer string.

Still in the extension only: revealing a value, the access log, renaming keys, organising groups, the backup file.

## Who decides

Approving a request, deleting a key, changing a key's MCP access, the recovery phrase and the transfer string are the owner's alone. The password of a string and the words of a phrase stay in that window. The pane only opens a window for them; that window shows what is at stake, read from the vault, and asks you to answer there. The tools refuse to act without a real console, so a command run by Claude cannot answer its own request, and the mod denies Claude's shell commands that name its tools or its copy of the bridge. A refusal needs no window, since it gives nothing away.

This holds Claude to the same rules as the extension's guard does. It is not a wall against a program that runs on your account with intent to get around it: nothing running as you can be kept from your own files.

## Local and cloud sessions

The vault lives on your own computer. In a local session (terminal, VS Code, or the Code tab of Claude Desktop running on your machine) the pane lists it. In a cloud session the pane runs in a remote container that has no vault: it says so and shows the quotas only. This is on purpose: the vault never leaves your computer.
