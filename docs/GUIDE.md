# User guide: Claude Monitor & Vault + ChatGPT

[Back to the overview](../README.md)

**Your familiar Claude Monitor & Vault, now with optional ChatGPT / Codex support.**
Same Marketplace extension, same publisher, same vault and existing Claude settings.
One familiar panel contains a compact quota selector: **Automatic**, **Claude**,
**ChatGPT / Codex**, or **Both assistants**. The **···** menu holds assistant
switching, model selection and shared project memory.

Version **1.2.0** organises the vault into groups and separators, lets Claude
and ChatGPT decide MCP access under a setting you control ([What the AI may
do](#what-the-ai-may-do)), gives ChatGPT the `vault_create`, `vault_set` and
`vault_layout` tools, and aligns ChatGPT quota rows with Claude's.

Version **1.1.0** introduced a refreshed logo: the familiar terracotta gauge
paired with a teal link representing connected assistants and shared knowledge.
After installation or an update, a **What's New** tab explains the changes once
per version and links to the new features. Reopen it with **Claude Monitor:
What's New**. Choose `agentBridge.updateNotice` = `window`, `notification` or
`off` to control announcements. If the tab cannot open, a standard VS Code
notification provides the summary instead.

## New: work with Claude Code and ChatGPT / Codex

| Feature | Claude Code | ChatGPT / Codex local clients |
|---|---|---|
| Usage limits | Existing session, week and model counters | Actual account quota windows returned by Codex App Server |
| Model choice | Default, Sonnet, Opus, Haiku or a model ID | Available model catalog, default or a model ID |
| Project memory | `CLAUDE.md` reads shared notes | `AGENTS.md` reads the same shared notes |
| Encrypted vault | Existing hooks, terminal and MCP proxy | Local MCP tools `vault_list` and `vault_run` |
| Vault changes by the AI | `add.js`, `set.js` and `list.js --groups` | `vault_create`, `vault_set` and `vault_layout` |

### Switch assistants without losing project knowledge

1. Open the panel's **··· → Switch assistant / model** menu.
2. Choose Claude Code or ChatGPT / Codex, then a model for the next session.
3. Choose shared memory, import project instructions from `CLAUDE.md` or
   `AGENTS.md`, or select a Markdown memory file such as Claude's `MEMORY.md`.
4. Review the file differences and apply. The selected CLI starts in the project.

The common file is **`.agent-bridge/MEMORY.md`**. Both assistants receive an
instruction to read it at the start of their work. Keep project conventions,
decisions, current work and next steps there. Imported notes are appended as
snapshots, not silently rewritten or semantically merged. Native files retain
their existing assistant-specific instructions. Review contradictory notes before
continuing; scoped rules remain scoped and are not automatically flattened.

**Linked memory files are included.** Importing an index follows local Markdown
links, reference-style links, `@file.md` imports, backtick-quoted paths and plain
Markdown filenames in the text. A file such as `MEMORY.md` can point to
`user_profile.md`, `feedback_style.md` or `project_decisions.md`; each of those is
scanned in turn. Cycles and duplicate references count a file only once.

Before applying, an inventory shows the index, every included file, the total
count, missing files and skipped references. Included linked files stay separate
under `.agent-bridge/imports/`, with relative links rewritten for the new location.
Identical imports are idempotent. Changed source files create a new snapshot,
preserving previous imported notes, and edits during preview require a new scan.

Project imports stay within the project. An explicitly selected memory index
outside the project can include files in its own folder and subfolders. Links
outside that scope and symbolic links are reported as skipped; network links are
never fetched. Scans are bounded at 128 files, 20 link levels, 256 KB per file and
4 MB in total; a reached limit is reported, not silently treated as complete.

Existing files are backed up under VS Code's extension storage before each
change. **Restore last project change** restores the latest batch if the files
have not changed again. Edited managed blocks, `AGENTS.override.md`, symlinks,
unsaved affected documents and stale previews stop synchronization instead of
overwriting work. Multi-folder workspaces prompt for the project to use.

**Scope:** the selector starts a new CLI session in VS Code's terminal. It does
not change the model in an already running Claude or Codex chat, transfer a chat
transcript, or synchronize the personal memory of ChatGPT on the website. Native
automatic memories and their linked files are imported when you select their index; ongoing shared
knowledge belongs in `.agent-bridge/MEMORY.md`. No API calls generate summaries.

### Enable ChatGPT / Codex usage monitoring

Install Codex CLI, sign in with `codex login`, then select **ChatGPT / Codex** or
**Both assistants** at the top of the panel. Monitoring starts automatically.
**Automatic** prioritizes the active assistant tab or terminal, then the saved
project choice, running terminals, native instructions and client signals;
existing users who enabled Codex monitoring keep both providers visible.
Monitoring uses the Codex App Server account
interface. It displays returned percentages, window durations, reset times and
the last update. Failed refreshes keep the last values with a warning.

ChatGPT rows are drawn by the same code as Claude rows, so both blocks look and
behave the same; only the colour differs. The label comes from the window length
(**Session (5h)** for five hours, **Week** for seven days, otherwise hours or
days), with the plan name as a tooltip. The reset line is a live countdown such
as **resets in 2 h 14**, refreshed every minute and every 10 seconds near a reset.
When projection is on, the same "hits the limit around 16:40" estimate appears.
Levels switch at 70% and 90%, the footer gives the last and next update, and in
**Both assistants** mode the status bar and activity badge show both providers.

The counters describe the quota buckets returned for the connected Codex account;
they are not a promise to cover every limit on the ChatGPT website. API-key-only
accounts do not provide subscription quotas. CLI discovery supports native
executables and standard npm installs; custom installations can use
`agentBridge.codexExecutable` or `agentBridge.claudeExecutable`.

### Use the vault from Codex

Codex detection automatically prepares context and the vault connection in trusted
projects. Disable this with `agentBridge.codexAutoSetup`. Manual **Connect Codex to
the vault** remains available. The extension preserves and backs up a
managed MCP entry in the project's `.codex/config.toml`, preserving other settings.
The default `agentBridge.codexVaultAccess = claude` permits the same keys as Claude.
Use `mcp` to require explicit MCP permission per key. Named-server restrictions,
expiry and confirmations remain enforced. Start a new Codex session after setup
or a change of access mode. Existing key permission records are not rewritten.

The server exposes metadata through `vault_list` and runs a program through
`vault_run`, mapping vault key names to environment variables. It buffers and
redacts output before returning it. It does not return secret values as a tool.
Programs run in the connected project, without shell expansion, with a 60-second
timeout and a 1 MB output limit. This is a separate tool path; it does not rewrite
arbitrary Codex shell calls. Existing Claude hooks continue to work as before.

Three more tools give ChatGPT the same powers as Claude's bridge scripts, under
the same rules, and every action is recorded as ChatGPT in the access log:

| Tool | What it does |
|---|---|
| `vault_list` | Keys in your layout order, each with its group and MCP scope, plus the current setting. Never values. |
| `vault_create` | Runs a program (no shell, 60 seconds, 64 KB) and stores its standard output as a new key. The value is never returned. Takes a name, a note, an MCP decision (`"none"`, `"all"` or a list of servers) and an optional group. |
| `vault_set` | Changes MCP access or the group of existing keys. A grant or a widening needs a one-line reason; removing or narrowing does not. When your approval is needed, the tool waits up to 50 seconds and reports approved, refused, withdrawn or pending. |
| `vault_layout` | Creates, renames, deletes or moves groups and separators. Positions count from 1 at the top. |

The decisions are the same as for Claude: see [What the AI may do](#what-the-ai-may-do).

Codex vault access requires VS Code to remain open when a key needs per-use
confirmation. Use **Disconnect Codex from the vault** to remove the managed entry.
The encrypted store stays at its existing location so this update does not move
or duplicate existing secrets. Codex uses are identified in the access log.

### Compatibility and updates

- Marketplace ID remains **`alexossart.claude-monitor-vault`**.
- Existing settings and command IDs remain supported.
- Claude integration remains enabled as before; Codex monitoring is opt-in.
- Local trusted projects are required for vault access, assistant launch and
  memory synchronization. Claude quota viewing remains available in restricted mode.
- Windows, macOS and Linux CLI paths are supported. Browser-only VS Code and
  virtual workspaces are not supported. In Remote/WSL, CLIs and the vault belong
  to the host running the extension.

Implementation references: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Existing Claude features

The original two tools remain available:

1. A live view of your Claude usage limits, the same numbers as Claude Code's
   `/usage` command.
2. **Claude Vault**, an encrypted local secret store that Claude Code can use
   without ever seeing the values.

![Unified quota panel with both assistants](../media/panel-1.1.0.png)

Preview of version 1.1.0 with demonstration values. Use the selector to display
Claude, ChatGPT / Codex, or both; the compact menu opens assistant and memory actions.

## Install

Search for **Claude Monitor & Vault** in the Extensions view, or:

```
code --install-extension alexossart.claude-monitor-vault
```

To install a `.vsix` yourself:

```
code --install-extension claude-monitor-vault-1.2.0.vsix
```

Requires **VS Code 1.106** or newer. Plain JavaScript, no runtime dependencies.

## Getting started

1. Open the panel from the activity-bar icon on the left.
2. Press **+** in the Secrets section and paste a key. It is encrypted on submit.
3. Ask Claude to use it by name:

   ```
   you>  list my private repositories with $GITHUB_TOKEN
   ```

   Claude writes a marker into its command; the value is substituted at the last
   moment, out of its view:

   ```bash
   curl -H "Authorization: Bearer {{vault:GITHUB_TOKEN}}" https://api.github.com/user/repos
   ```

4. A backup file is created for you at first launch and follows the vault from
   then on. Press **Create the backup key** in the box above the access log and
   write down the 17 words: that is what makes the backup openable on another
   machine, and what brings the vault back if this one loses its master key.

## Usage monitor

| | |
|---|---|
| Panel | one row per limit (session, week, per model), bar, percentage, countdown; ChatGPT rows use the same layout |
| Activity-bar badge | session percentage on the icon, wherever the panel sits |
| Status bar | compact figure such as `session: 8%`, full breakdown on hover; two styles: **Prominent** (default coloured pill, amber then red) or **Custom** (text only, colour band configurable per session %) |
| Band editor | in Custom mode only, drag boundaries or type percentages; built-in preview scales the text colour as you edit |
| Alerts | at 80% then 95% of the session, 90% of the week, once per reset window |
| Smart pause | when a limit is exhausted, calls stop until the reset time |
| Projection | `full ≈ 17:40` when the slope says a quota runs out before it resets |
| Shared cache | one real request feeds every open VS Code window |

The extension reads Claude Code's local OAuth token from
`~/.claude/.credentials.json` (the macOS keychain when that file is absent) and
calls `api.anthropic.com/api/oauth/usage`, the endpoint `/usage` uses. On HTTP
429 it backs off, honouring `Retry-After`, and keeps the last known figures on
screen.

## Claude Vault

**Claude never gets your keys, it gets the right to use them.** The key stays in
the vault, the vault uses it on Claude's behalf, and the plaintext only ever
exists in the memory of the process that needs it.

### Markers

| Marker | Replaced by | Typical use |
|---|---|---|
| `{{vault:NAME}}` | the value, inline | `Authorization` headers, environment variables |
| `{{vault-file:NAME}}` | the path to an ACL-restricted temporary file | `ssh -i`, certificates, JSON service accounts |

Type `{{vault:` in any file or terminal and the editor offers your key names.

In a shell command the marker is not replaced by the value but by a call to a
helper carrying a **single-use token valid for two minutes**. The value is
fetched at the instant the command runs, in that process only. It appears in no
stored string: not the transcript, not the rewritten tool input, not the shell
history. Replaying the command yields nothing.

### The vault terminal

For anything long-running, a dev server, a watcher, a container, use a terminal
whose environment already holds the keys, so no value ever reaches a command
line:

```
Ctrl+Shift+P  >  Claude Vault: Open a vault terminal
```

Pick the keys, and they arrive as environment variables named after them. Your
`.env` can leave the disk. The extension never holds the values itself: it puts
markers in the terminal's environment and lets the vault's launcher resolve
them.

### Recovery, backup and moving machines

The master key is 32 random bytes held by your OS secret store, unique to this
machine. Two things make it survivable:

- **Recovery phrase.** 17 words that unlock a copy of the master key. Needed if
  the OS secret store is ever lost: a wiped profile, a reinstalled system, a
  rebuilt account. Write them down: a copy sealed under the master key stays on
  this machine so they can be displayed again, but that copy is lost along with
  the machine.
- **Backup file** (`.cvault`). One encrypted file holding the whole vault: the
  keys, the access log, the bin and your settings. It is created on first launch
  and rewritten at every change, so it is never out of date. Move it wherever
  you like, the new location is remembered.

The two work together. This machine can always open the backup file, which
covers a deleted or corrupted vault. Once a recovery phrase exists, the same
file also opens on **any** machine, which is what a dead disk or a new computer
actually needs. Keep a copy somewhere other than this machine.

Moving to a new computer is the file plus the words:

```
Ctrl+Shift+P  >  Claude Vault: Restore from a file
```

**Generating a new phrase** never asks for the current one, since whoever wants
a new phrase has often lost the old one. What protects you instead:

- The confirmation says when the current phrase was created and what its last
  word is, so you know which sheet of paper you are about to make obsolete. The
  last word is a checksum of the others and reveals nothing about them.
- The backup file is rewritten at once, and you are told if that failed.
- Replaced phrases stay in **Phrase history** (the last five), with their dates.
  You can display one, because it still opens earlier copies of the backup file,
  or make it active again if the replacement was a mistake.
- Every creation, replacement and display goes in the access log.

Replacing a phrase does not change the master key. If a phrase leaked, delete
any earlier copy of the backup file: that copy still opens with the old words,
and it holds the master key. A phrase created before version 1.3.0 was never
stored and cannot be displayed. Type it once in **Recover with a phrase** and it
can be from then on, or generate a new one.

### Transfer string

To move your keys without moving a file, **Create a transfer string** turns every
key into one long line of text, names included, encrypted with a password you
choose (scrypt, then AES-256-GCM; at least 12 characters), or one generated for
you if you leave both fields empty. Nothing can be read from it without the
password, not even how many keys it holds. On the other machine, **Import a transfer
string** in the settings window takes the string, picked up from the clipboard when
it is there, and the password. You see what would change before anything is written.

| | Transfer string | Backup file |
|---|---|---|
| Opened by | a password you choose | the recovery phrase, or this machine |
| Carries | keys and their own settings (note, group, expiry, MCP access) | the whole vault: log, bin, settings |
| On arrival | joins the keys already there | replaces the vault, and the master key if another machine wrote it |
| Stays up to date | no, it shows the keys as they were | yes, rewritten at every change |

A key already there with the same value is left alone. With a different value you
choose which one wins, and a replaced key waits 30 days in the bin. The receiving
machine keeps its own master key and its own settings, including what the AI may
do. Keys allowed for MCP on the first machine arrive allowed, and the confirmation
says how many.

The string can be guessed at offline by anyone who catches it, for as long as they
like, so its strength is the password's. Send the password another way than the
string. Creating and importing a string both go in the access log, and the settings
window shows when the last string was created.

### Deleting, renaming, replacing

- A deleted key waits **30 days in the bin**, still encrypted, and comes back in
  one click. There is an **Undo** on the confirmation itself.
- Renaming normalises spaces and accents: `github key 1` becomes
  `GITHUB_KEY_1`.
- Replacing a value never displays the previous one, and keeps the expiry, the
  limits and the authorisations.

### Lifetimes

No expiry, 5 minutes, 1 hour, 8 hours, 24 hours, 7 days, or **burn after first
use**. The expiry is part of the encryption's authenticated data: editing it in
the file makes the secret undecryptable rather than extended.

### Public or secret

Services publish half of a pair on purpose: a Stripe `pk_`, a Supabase anon key,
a captcha sitekey. Those are detected at creation and marked public, which keeps
the commit guard from warning about them. Detection is deliberately narrow, and
the name is never a signal: `PUBLIC_KEY` is what half the world calls the
counterpart of a private one.

### Ask before every use

Off by default. Turned on for a key, every use by Claude raises a dialog and the
command waits for it. No answer within a minute means refused. Meant for the few
keys where an unattended use would be expensive.

### Commit guard

Warns when one of your own secrets appears in clear in a saved file or in what
you have staged for commit. It compares fingerprints, so nothing is decrypted
and there are no false positives. Keys marked public are skipped.

It warns and never blocks, on purpose: blocking would mean a git hook, and a git
hook is triggered by the repository, so any project you clone could ask it
whether a string is one of your secrets.

```
Ctrl+Shift+P  >  Claude Vault: Check what is staged for commit
```

### What Claude can do on its own

Three scripts, all safe by construction: none of them reads, prints or receives
a value on its command line.

**List the key names.** Metadata only, no path to a value. With `--groups`, the
layout in order: `# Group` lines, `---` separator lines (with their label if
any), one `NAME<TAB>scope` line per key (`mcp:all`, `mcp:server1,server2` or `-`
for shell only), and `# Ungrouped` last.

```
node ~/.claude/claude-vault-bridge/list.js
node ~/.claude/claude-vault-bridge/list.js --groups
```

**Create a key.** The value arrives through a pipe, so it never passes through
the model or the transcript. The name comes from the command line, the value
only from stdin, and a description is required. Claude also says what the key
may do, since it knows what the key is for:

| Flag | Meaning |
|---|---|
| `--mcp=server1,server2` | usable in MCP tool calls of those servers only (refused when MCP access is Off, see [What the AI may do](#what-the-ai-may-do)) |
| `--mcp` | usable by every MCP server (asks you first; refused when MCP access is Off) |
| `--no-mcp` | shell only |
| `--group "Name"` | placed in that group, created if missing when you allow the AI to organise keys |

```
openssl rand -hex 32 | node ~/.claude/claude-vault-bridge/add.js SESSION_SECRET --note "signs the API session cookies" --no-mcp --group "Backend"
```

Leaving the MCP decision out is not an error: the key is created shell only and
the output gives the `set.js` command to request access later. An empty server
list is an error, never "every server". A value already stored under another
name is refused, so the vault does not fill with copies.

An existing key is never replaced without approval: `--replace` seals the new
value and parks it until you approve in VS Code. When the key is allowed for MCP,
the window says so, since the new value inherits that access, and offers
**Replace without MCP access**. On `--replace`, the MCP and group
flags are ignored with a note pointing to `set.js`. **Deletion is always yours**,
Claude has no path to it.

**Change existing keys and the layout.** `set.js` changes MCP access or the group
of existing keys, and reorganises groups and separators:

```
node ~/.claude/claude-vault-bridge/set.js NAME [NAME...] --mcp=server,...|--mcp|--no-mcp [--reason "why"]
node ~/.claude/claude-vault-bridge/set.js NAME [NAME...] --group "Name"|--no-group
node ~/.claude/claude-vault-bridge/set.js --new-group "Name" [--at N] | --rename-group "Old" "New" | --delete-group "Name"
node ~/.claude/claude-vault-bridge/set.js --separator ["label"] [--at N] | --move "Group or separator"|@P N
```

Positions count groups and separators from 1 at the top, in the order
`list.js --groups` prints them; it prints each separator's position too, and
`@P` names the item at position P (`--move @3 1`), which is how a separator with
no label, or with a label used twice, is moved. A grant or a widening needs a
one-line reason (200 characters at most); removing or narrowing access does not.
When your approval is needed, the script waits 60 seconds and reports approved,
refused, withdrawn (the key changed or the request expired before you answered)
or pending. ChatGPT has the same operations through its MCP
tools, see [Use the vault from Codex](#use-the-vault-from-codex).

### Groups and separators

Groups work like folders in a sidebar. They exist empty or filled, keep the
order you give them, and fold or unfold with a click; the folded state survives
refreshes and restarts. Separators are thin lines between groups, with an
optional small title. Keys without a group are listed last under **Ungrouped**;
with no layout at all, the list stays flat as before.

- **Reorder** by dragging keys, groups and separators, or with **Move up** and
  **Move down** in their menus. Dropping a key on a group moves it there.
- **Menus.** Right-click the background for New group, New separator, Suggest
  groups, Collapse all and Expand all. A group menu offers New key in this group,
  Rename, Move up, Move down, Allow MCP for the group, Remove MCP for the group
  and Delete group (its keys are kept, ungrouped). A key menu has **Move to group**.
- **Group header.** Name, key count, how many are allowed for MCP, and a dot
  when a folded key is old or running out.
- **Search** matches names, groups and descriptions and shows visible / total.
  A folded group opens while a search matches inside it.
- **Suggest groups** looks at ungrouped keys sharing a prefix, removes rotation
  suffixes such as `_2026_10`, keeps environments (`BO_DEV_*` gives "BO DEV",
  `BO_PROD_*` gives "BO PROD") and flags near spellings such as CLOUDLFARE.
  Nothing is applied until you confirm.
- **Group MCP.** Allowing MCP for a group lists every key concerned in one
  confirmation and only touches keys without MCP, so per-server scopes are kept.
  Removal has Undo.

Group names use letters, digits, spaces and `. _ & + -`, 40 characters at most,
unique regardless of case. Groups only change where a key sits, never what it
can do. The layout is stored next to the vault, outside the encrypted data, and
is carried by export and import. Replacing, renaming, binning and restoring a key
keep its group.

### What the AI may do

A card in the vault settings window sets what Claude and ChatGPT may change on
their own. The AI never reads a value; these rules only decide what it may change
and what it must ask you first. One setting covers both assistants, with an
optional override per assistant.

| MCP access | Behaviour |
|---|---|
| **Off** | The AI never changes MCP access. |
| **Ask** (default) | The AI may remove access, and grant it when it creates a key for named local servers. Anything else asks you. |
| **Automatic** | The AI grants and removes on its own, except for keys that ask before every use, grants to every server and grants to remote servers, which still ask. Turning it on asks for confirmation, and the panel shows a line while it is on. |

- **Removing or narrowing** MCP access always applies at once.
- **Organising keys** (groups, separators, placement) is on by default and applies
  at once. Turn it off and the AI may not reorganise your keys.
- **Replace keys without asking** is the existing automatic approval, off by
  default and now visible here. If it was on before the update, VS Code asks once
  whether to keep it; until you answer, replacements ask you.
- These settings are signed. A settings file edited, emptied or deleted outside
  the extension holds both assistants to the strictest rules (MCP access Off, no
  reorganising) until you choose again in this card.

When a grant needs you, one VS Code window says who asks (Claude or ChatGPT),
which keys, which servers (remote or unwrapped ones are marked) and the AI's
one-line reason, with **Allow**, **Choose servers** or **Refuse**. It applies
exactly what it showed; closing it counts as Refuse, and a request that changed
in the meantime is refused rather than applied. Only one request waits at a
time, and it expires after 15 minutes. A change made by the AI shows briefly in
the status bar, for example "Claude moved 3 key(s) to Scaleway".

At session start Claude is told the keys by group, rotated copies ("newer copy
of X"), each key's MCP scope, short rules and the current setting; ChatGPT gets
the same through the MCP server instructions and `vault_list`. When an MCP call
is refused, the message also says how to request access, unless the setting is
Off.

The settings file is signed. If it is changed outside the extension, the AI is
held to the strictest rules until you choose again in this card. Export and
import carry these settings.

### How it is encrypted

- **Master key**, 32 random bytes, held by the OS secret store: DPAPI
  `CurrentUser` on Windows, the login keychain on macOS, libsecret on Linux. A
  keyring that stores its contents in the clear is refused and the panel says
  so.
- **Per secret**, a key derived with HKDF-SHA256, AES-256-GCM, a fresh 12-byte
  IV and salt on every write.
- **Authenticated data** covers the entry's id, name, expiry, policy and its
  MCP, public and confirmation flags. Editing any of them in the file breaks
  decryption instead of granting anything.
- **Whole-file HMAC** plus a monotonic counter sealed in the key file: entries
  cannot be added, removed, swapped or rolled back.
- The value never travels through a command-line argument, so it never appears
  in the process list.

### How Claude Code reaches it

**Connect to Claude Code** installs four hooks into `~/.claude/settings.json`,
through a non-destructive merge with a timestamped backup. Idempotent and
reversible with **Disconnect**.

| Hook | Role |
|---|---|
| `SessionStart` | announces the names of the available keys |
| `UserPromptSubmit` | detects `$NAME`, injects metadata and instructions |
| `PreToolUse` | substitutes markers in shell and MCP calls |
| `PostToolUse` | redacts vault values from tool output |

No hook touches the master key: they read metadata only.

### MCP servers

**Environment launcher.** A launcher resolves the marker into the server's
environment before it starts. `.mcp.json` holds a marker instead of a key, so it
can be committed.

**Transparent stdio proxy.** For a value that has to be a tool argument, a proxy
sits between Claude Code and a local stdio server. Claude Code persists and
replays the marker; the substitution happens downstream, and any echo of the
value in the response is redacted on the way back. Local stdio servers are
wrapped automatically.

Authorisation is per key, and can be restricted to **named servers**: the key is
refused everywhere else.

**The honest limitation.** A remote HTTP server that receives the value as a
tool argument writes it into the transcript; there is no local process to put it
behind. That path is off by default and gated per key.

### Output redaction

Some providers echo back what you sent: an error quoting the offending token, a
`curl -v` dumping the authorization header. After each tool call, a pass masks
any known vault value in the output, covering the raw value, base64,
URL-encoding and HTTP Basic pairs. Best effort: it does not cover a value the
command transformed on its own.

### Access log

Every use, creation, replacement, expiry and revocation is recorded with the key
name, the time and **who acted**: Claude, ChatGPT or you. Layout changes, key
placements and MCP requests, approvals and refusals are recorded the same way.
Never the value. Bounded at 500
entries and 90 days: long enough to investigate, short enough that the file
forgets on its own.

### What it does not protect against

- **Malware running under your own account** has the same access you do. No
  passphrase-free vault can prevent that; zero friction is the deliberate
  choice, and this is its price.
- **Expiry is not destruction.** It prevents extending a key, not copying the
  file before the deadline.
- **A command can betray a secret itself**, by encoding it, splitting it, or
  writing it to a file read back later.
- **Memory wiping is best effort.** JavaScript strings are immutable.

## Commands

All available from the command palette, prefixed **Claude Vault** or **Claude
limits**.

| Command | What it does |
|---|---|
| Open a vault terminal | a terminal whose environment holds the chosen keys |
| Create the backup file | one encrypted file, kept up to date on its own |
| Restore from a file | bring a vault in, on this machine or a new one |
| Create the backup key | generate the 17-word recovery phrase |
| Recover with a phrase | reopen the vault when the OS secret store is lost |
| Show the recovery phrase | display the active phrase again, recorded in the log |
| Recovery phrase history | see replaced phrases and their dates, display one or make it active again |
| Create a transfer string | every key in one line of text, opened by a password |
| Import a transfer string | add the keys of a string to this vault |
| Open the bin | put back a key deleted in the last 30 days |
| Check what is staged for commit | look for your secrets in the staged diff |
| Rename a key / Replace the value | without ever showing the old value |
| Public or secret | stop watching a publishable value, or resume |
| Ask before every use | require a confirmation for one key |
| New group / New separator | add a group or a separator line to the layout |
| Move a key to a group | place one key, or take it out of its group |
| Organize keys into a group | move several keys at once |
| Rename a group / Delete a group (keys kept) | deleting a group never deletes its keys |
| Suggest groups | proposals from shared prefixes, applied only after you confirm |
| MCP access for a group | allow or remove MCP for every key of a group |
| Connect / Disconnect | wire Claude Code, or restore it exactly |
| Access log | who used what, and when |
| Revoke everything | new master key, every secret unreadable, immediately |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeLimits.location` | secondarySidebar | where the panel lives, `secondarySidebar` (right, next to the chat) or `sidebar` |
| `claudeLimits.autoConnect` | true | wire Claude Code at startup; off, nothing is touched until you press Connect |
| `claudeLimits.pollSeconds` | 210 | seconds between API calls, minimum 120 |
| `claudeLimits.alerts` | true | threshold notifications |
| `claudeLimits.statusBar` | true | show usage in the status bar |
| `claudeLimits.statusBarPosition` | right | which side of the status bar shows the figure |
| `claudeLimits.statusBarStyle` | prominent | `prominent`: coloured pill at all times (amber then red). `subtle`: text colour follows your band settings, no pill. |
| `claudeLimits.statusBarBands` | `[{upTo: 50, color: "descriptionForeground"}, {upTo: 75, color: "foreground"}, {upTo: 90, color: "charts.yellow"}, {upTo: 100, color: "charts.red"}]` | colour band thresholds for Custom mode: each band runs up to its percentage, the next one starts there (no gaps or overlaps). Configurable from the settings page. Colours come from the theme, so they stay readable in light and dark. |
| `claudeLimits.statusBarWeek` | false | also show the weekly limit |
| `claudeLimits.badge` | true | numeric session badge on the activity-bar icon |
| `claudeLimits.pauseWhenExhausted` | true | stop polling until the reset time |
| `claudeLimits.showCredits` | true | show paid credits beyond the plan |

All of them are editable from the gear icon in the panel's title bar.

## Open source, local by design

Every line this extension runs is public:
**[github.com/DarkHenos/claude-monitor-vault](https://github.com/DarkHenos/claude-monitor-vault)**

- **No extension telemetry, no server of ours.** Claude monitoring calls
  Anthropic's usage endpoint. Optional Codex monitoring uses the locally installed
  Codex CLI and its service connections. The CLI has its own settings and policies.
- **Local encrypted storage.** The vault is encrypted with a key sealed by your
  OS session. Authorized programs can transmit credentials to the services they
  authenticate with. Output redaction reduces exposure to the model; it is not a
  sandbox against malicious commands or arbitrary secret transformations.
- **MIT-licensed.** Audit it, fork it, build the `.vsix` yourself and compare.

Interface in English, French, Spanish, German and Portuguese, chosen in the
panel's settings window, independently of the VS Code display language.

## License

MIT.
