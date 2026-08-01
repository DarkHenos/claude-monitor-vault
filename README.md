# Claude Monitor & Vault

Two tools in one VS Code extension:

1. A live view of your Claude usage limits, the same numbers as Claude Code's
   `/usage` command.
2. **Claude Vault**, an encrypted local secret store that Claude Code can use
   without ever seeing the values.

<!-- Absolute URLs on purpose: a relative image path renders on GitHub but breaks
     on the Marketplace page, which serves this readme from its own domain.
     Widths in PIXELS, never in percent: the extension Details tab in VS Code
     stretches a percentage to its container and blows the screenshots up. Pure
     HTML inside the cells, so GitHub, the Marketplace and that tab agree. -->
<img src="https://raw.githubusercontent.com/DarkHenos/claude-monitor-vault/main/media/screenshots/window.png" alt="The panel in the left side bar of VS Code, showing the session and weekly limits above the list of stored keys" width="820">

<table>
  <tr>
    <td width="300" valign="top">
      <img src="https://raw.githubusercontent.com/DarkHenos/claude-monitor-vault/main/media/screenshots/panel.png" alt="The panel: a progress bar per limit with its percentage and countdown, then the keys, in a single view" width="280">
    </td>
    <td valign="top">
      <b>The panel.</b> One row per limit, each with its bar, its percentage and
      the time left before it resets. Underneath, the keys held in the vault:
      their name, their kind, their lifetime. Never their value.
      <br><br>
      <img src="https://raw.githubusercontent.com/DarkHenos/claude-monitor-vault/main/media/screenshots/badge.png" alt="The activity-bar icon carrying a numeric badge with the session percentage" width="40">
      <br>
      <b>The icon, wherever the panel is.</b> It never leaves the left edge and
      carries the session percentage as a badge.
    </td>
  </tr>
</table>

## Install

Search for **Claude Monitor & Vault** in the Extensions view, or:

```
code --install-extension alexossart.claude-monitor-vault
```

To install a `.vsix` yourself:

```
code --install-extension claude-monitor-vault-1.0.0.vsix
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

4. Press **Create the backup key** in the box above the access log, write down
   the 17 words, then set an export file. Without those two, a lost master key
   is a lost vault.

## Usage monitor

| | |
|---|---|
| Panel | one row per limit (session, week, per model), bar, percentage, countdown |
| Activity-bar badge | session percentage on the icon, wherever the panel sits |
| Status bar | compact figure such as `session: 8%`, full breakdown on hover |
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

- **Recovery phrase.** 17 words, shown once and stored nowhere, that unlock a
  copy of the master key. Needed if the OS secret store is ever lost: a wiped
  profile, a reinstalled system, a rebuilt account.
- **Export file** (`.cvault`). One encrypted file, names included, refreshed on
  its own at every change. Keep it somewhere other than this machine.

Moving to a new computer is the file plus the words:

```
Ctrl+Shift+P  >  Claude Vault: Restore from a file
```

The export option stays disabled until a recovery phrase exists, because without
one the file could only ever be opened on the machine that wrote it.

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

Two actions, both safe by construction.

**List the key names.** Metadata only, no path to a value.

```
node ~/.claude/claude-vault-bridge/list.js
```

**Create a key.** The value arrives through a pipe, so it never passes through
the model or the transcript. The name comes from the command line, the value
only from stdin, and a description is required.

```
openssl rand -hex 32 | node ~/.claude/claude-vault-bridge/add.js SESSION_SECRET --note "signs the API session cookies"
```

An existing key is never replaced without approval: `--replace` seals the new
value and parks it until you approve in VS Code. **Deletion is always yours**,
Claude has no path to it.

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
name, the time and **who acted**, Claude or you. Never the value. Bounded at 500
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
| Create the export file | one encrypted file, kept up to date on its own |
| Restore from a file | bring a vault in, on this machine or a new one |
| Create the backup key | generate the 17-word recovery phrase |
| Recover with a phrase | reopen the vault when the OS secret store is lost |
| Open the bin | put back a key deleted in the last 30 days |
| Check what is staged for commit | look for your secrets in the staged diff |
| Rename a key / Replace the value | without ever showing the old value |
| Public or secret | stop watching a publishable value, or resume |
| Ask before every use | require a confirmation for one key |
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
| `claudeLimits.statusBarStyle` | prominent | a coloured pill, or the plain theme coloured only at thresholds |
| `claudeLimits.statusBarWeek` | false | also show the weekly limit |
| `claudeLimits.badge` | true | numeric session badge on the activity-bar icon |
| `claudeLimits.pauseWhenExhausted` | true | stop polling until the reset time |
| `claudeLimits.showCredits` | true | show paid credits beyond the plan |

All of them are editable from the gear icon in the panel's title bar.

## Open source, local by design

Every line this extension runs is public:
**[github.com/DarkHenos/claude-monitor-vault](https://github.com/DarkHenos/claude-monitor-vault)**

- **No telemetry, no server of ours.** The only network call is to Anthropic's
  official usage endpoint.
- **Your secrets never leave your machine.** The vault is a local file,
  encrypted with a key sealed by your OS session. Not the author of this
  extension, not Anthropic, not Claude: by construction, not by promise.
- **MIT-licensed.** Audit it, fork it, build the `.vsix` yourself and compare.

Interface in English, French, Spanish, German and Portuguese, chosen in the
panel's settings window, independently of the VS Code display language.

## License

MIT.
