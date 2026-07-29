# Claude Monitor & Vault

Two tools in one VS Code extension:

1. A live view of your Claude usage limits, the same numbers as Claude Code's
   `/usage` command.
2. **Claude Vault**, an encrypted local secret store that Claude Code can use
   without ever seeing the values.

The panel lives in the **secondary side bar** by default — on the right, next
to the chat, like Claude Code itself — and mirrors to the left side bar with
one click, whichever you prefer.

## Open source, local by design

Every line this extension runs is public:
**[github.com/DarkHenos/claude-monitor-vault](https://github.com/DarkHenos/claude-monitor-vault)**
— the repository this very page links to. What you install is what you can read.

- **No telemetry, no server of ours.** The only network call the extension ever
  makes is to Anthropic's official `api.anthropic.com/api/oauth/usage`
  endpoint — the same one Claude Code's `/usage` command uses.
- **Your secrets never leave your machine.** The vault is a local file,
  encrypted with a key sealed by your OS session. Nobody can read the values:
  not the author of this extension, not Anthropic, and not Claude itself — by
  construction, not by promise. The whole mechanism is documented below and
  auditable in the repository.
- **MIT-licensed.** Audit it, fork it, build the `.vsix` yourself from source
  and compare.

Available in five interface languages: English (default), French, Spanish,
German and Portuguese. The language is chosen in the panel's settings window; it
can follow your editor or be set on its own, independently of the VS Code display
language.

## Usage monitor

- **Panel**, one row per limit (session, week, week Opus, week Sonnet), each
  with a progress bar, a percentage and a countdown to reset. Quotas on top,
  secrets below, in a single view. A **mirror button** in its title bar moves it
  between the left side bar (the default) and the secondary side bar on the
  right, next to the chat, and the choice is remembered.
- **Left icon, always.** The activity-bar icon never leaves the left edge,
  wherever the panel lives. It carries a numeric badge with the session
  percentage — the bare figure on the icon, the "%" sign in the tooltip, since a
  VS Code badge can only carry a number — and the badge shows **only there**,
  never on the secondary side bar.
- **Limits**, a collapsed one-liner under the panel showing `4% 5h · 11% week`
  in its own title row. It is what carries the badge, so the figure is on the
  icon from startup without waiting for the panel to be opened. Move the panel
  to the right and this line takes its place on the left; click any of its rows
  to bring the panel back into view.
- **Maximize**, when the panel is on the right: one button expands the
  secondary side bar over the editor and restores it, VS Code's native
  maximize.
- **Status bar**, a compact figure such as `session: 8%`, with the week added on
  request, a coloured pill by default or the plain theme, on the left or the right.
  The full breakdown shows on hover.
- **Threshold alerts**, a notification at 80% then 95% of the session, and 90% of
  the weekly limit, fired once per reset window rather than once per window you
  have open.
- **Smart pause**, when a limit is exhausted, calls stop until the reset time
  Anthropic reports, instead of polling while you are blocked.
- **Paid credits**, an optional line showing spending beyond your plan, in your
  account currency, shown only when extra usage is enabled on your Claude account.
- **Shared cache**, every VS Code window reads one cache file, so a single real
  request feeds them all, however many windows you keep open.

### How the monitor gets its data

The extension reads Claude Code's local OAuth token from
`~/.claude/.credentials.json` and calls the official
`api.anthropic.com/api/oauth/usage` endpoint, the same one `/usage` uses. Nothing
else leaves the machine.

Colours follow the severity Anthropic returns, with 70% and 90% thresholds as a
safety net, expressed through VS Code theme colours so they work in any theme. On
HTTP 429 the extension backs off automatically, respecting `Retry-After`, while
keeping the last known data on screen.

## Claude Vault

The idea in one line: **Claude never gets your keys, it gets the right to use
them.** That is the `ssh-agent` model applied to an LLM agent. The key stays in
the vault, the vault uses it on Claude's behalf, and the plaintext value only ever
exists in the memory of the process that actually needs it.

### Creating and managing keys

From the `+` button in the Secrets section of the panel: a name, a masked value,
done. The panel is also where you inspect a key, set its lifetime, edit its
description, toggle MCP access, and delete it.

The value is encrypted the moment you submit it, and Claude never receives it. You,
the owner, can deliberately **reveal** a value from the panel if you need to check
it yourself. That is a distinct owner action: it is logged under its own label, it
does not count as a use, and it never triggers burn. Claude has no code path to it.

### Referring to a key in chat

Write `$NAME`. Claude receives the key's type, fingerprint, length and expiry,
never the value, and writes a marker into its command:

```
you>  deploy the VPS with $VPS_SSH_KEY
```

```bash
ssh -i {{vault-file:VPS_SSH_KEY}} deploy@vps "cd /srv && git pull"
```

The marker is replaced at the last moment, out of Claude's view. What stays in the
transcript is exactly the line above, marker included.

| Marker | Replaced by | Typical use |
|---|---|---|
| `{{vault:NAME}}` | the value, inline | `Authorization` headers, environment variables |
| `{{vault-file:NAME}}` | the path to an ACL-restricted temporary file | `ssh -i`, certificates, JSON service accounts |

**In a shell command the substitution is not the value.** The marker is replaced by
a call to a small helper carrying a **single-use token valid for two minutes**. The
real value is fetched only at the instant the command runs, and only in the memory
of that process. It appears in no stored string: not the transcript, not the
rewritten tool input, not the shell history. Replaying the command yields nothing.
This is a property of the code, not a promise.

### Lifetimes

No expiry, 5 minutes, 1 hour, 8 hours, 24 hours, 7 days, or **burn after first
use**. The expiry is part of the encryption's authenticated data: editing it in the
file makes the secret **undecryptable** rather than extended.

### What Claude can do on its own

Everything else about the vault is out of Claude's reach. Two actions are not.

**List the key names.** Claude can print the available names, one per line, nothing
else. The command reads metadata only and has no path to a plaintext value, so it
is safe to run. Useful when a key is created mid-session, after the startup
announcement has already gone out.

```
node ~/.claude/claude-vault-bridge/list.js
```

**Create a key.** Claude can pipe a value straight into the vault, so the value
never passes through the model or the transcript. The name comes from the command
line; the value only ever comes from stdin. A description (`--note`) is required and
is time-stamped when written.

```
openssl rand -hex 32 | node ~/.claude/claude-vault-bridge/add.js SESSION_SECRET --note "signs the API session cookies"
```

An existing key is **never replaced without approval**. Passing `--replace` seals
the new value straight away and parks it, then asks you in VS Code to approve or
refuse, unless you have turned auto-approval on. **Deletion is always a human
gesture**: Claude has no way to delete a key.

### How it is encrypted

- **Master key** of 32 random bytes, sealed with **DPAPI `CurrentUser`** on
  Windows. Copy the file elsewhere, or read it as another account, and it is
  useless. macOS and Linux fall back to a `0600` file, flagged in the panel as
  weaker protection.
- **Per secret**, a key derived with **HKDF-SHA256**, **AES-256-GCM**, a fresh
  12-byte IV and a fresh salt on every write, so nonce reuse cannot happen.
- **Authenticated data** covers the key's id, name, expiry and policy. Any edit to
  the JSON breaks the GCM tag, so metadata cannot be tampered with.
- **Whole-file HMAC signature** plus a **monotonic counter** sealed in the key
  file: entries cannot be added, removed, swapped, or rolled back to an older vault.
- The value never travels through a command-line argument, so it never appears in
  the process list.

### How Claude Code reaches it

**Connect to Claude Code** installs four hooks into `~/.claude/settings.json`,
through a non-destructive merge with a timestamped backup. The merge is idempotent
and reversible.

| Hook | Role |
|---|---|
| `SessionStart` | announces the **names** of the available keys |
| `UserPromptSubmit` | detects `$NAME`, injects metadata and instructions |
| `PreToolUse` | substitutes markers in shell and MCP calls |
| `PostToolUse` | redacts vault values from tool output |

No hook touches the master key: they read metadata only. Decryption happens at the
moment of real use, so nothing slows down your prompts.

### Using a key with an MCP server

There are two safe ways, and one honest limitation.

**Environment launcher.** A small launcher resolves the marker into the MCP
server's environment before the server starts. The secret only ever exists in that
server's environment, and `.mcp.json` holds a marker instead of a key, so the
configuration can be committed.

**Transparent stdio proxy.** For a value that has to be a tool argument, a proxy
sits on the protocol path between Claude Code and a local stdio server. Claude Code
persists and replays the **marker**; the substitution to the real value happens
downstream, inside the proxy, invisible to Claude Code, and the value goes only
into the child server's input. Any echo of the value in the response is redacted on
the way back. So the value never enters the transcript, at rest or on replay.

Local stdio MCP servers are **auto-wrapped** behind that proxy, so a key toggled
"Allow for MCP" just works with no configuration by hand. The original command is
kept verbatim, so unwrapping restores each server exactly, and `~/.claude.json` is
backed up before any change.

**The honest limitation.** A remote HTTP MCP server that receives the value as a
tool argument would write it into the transcript; there is no local process to put
it behind. That path is therefore off by default and gated behind explicit,
per-key authorization ("Allow for MCP"). A key that is not authorized is refused in
MCP calls, and the refusal is phrased for you to read and decide.

### Output redaction safety net

Some providers echo back the value you just sent: an error message that quotes the
offending token, a `curl -v` that dumps the authorization header. After each tool
call, a redaction pass masks any known vault value found in the output, covering the
raw value, base64, URL-encoding and HTTP Basic pairs. It fires even for a single-use
key that was already burned, because the value is kept encrypted just long enough to
redact the matching response.

This is best effort. It covers the raw value and those few encodings, not a value
the command transformed on its own (see the limits below).

### Access log

Every use, creation, replacement, expiry and revocation is recorded, with the key
name and the time, **never the value**.

Every entry also says **who acted**: *Claude* — through the bridge, the shell
hook or an MCP proxy — or *you*, through a VS Code gesture. The log has a "By"
column the text filter searches too, so typing `claude` shows only its actions.
Each key additionally remembers **who authored its current value**, shown in its
details: on an approved replacement that stays "Claude", since the approval is
your own separate line in the log, and the question one actually asks is where
the value came from. Entries written before this field existed are inferred only
where the code path allows a single author (a use is always the agent, a reveal
always the owner), and left blank otherwise.

The log is bounded on two axes: by count at **500 entries**, because every hook
parses the vault file on every tool call, and by age at **90 days**, because a
record of which key was used and when is itself sensitive. Long enough to
investigate an incident, short enough that the file forgets on its own.

### What it does not protect against

- **Malware running under your own account** has the same DPAPI access you do. No
  passphrase-free vault can prevent that. Zero friction is the deliberate choice
  here, and this is its price.
- **Expiry is not a destruction guarantee.** It prevents *extending* a key, not
  copying the file before the deadline.
- **A command can betray a secret itself**, by encoding it, splitting it, or writing
  it to a file that is read back later. Redaction covers the raw value and a few
  common encodings, not an arbitrary transformation.
- **Memory wiping is best effort.** JavaScript strings are immutable and copied by
  the garbage collector.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeLimits.location` | secondarySidebar | where the panel lives: `secondarySidebar` (right, next to the chat) or `sidebar` (left) — the mirror button in the panel's title bar toggles it too |
| `claudeLimits.pollSeconds` | 210 | seconds between API calls (minimum 120) |
| `claudeLimits.alerts` | true | threshold notifications |
| `claudeLimits.statusBar` | true | show usage in the status bar |
| `claudeLimits.statusBarPosition` | right | which side of the status bar shows the figure |
| `claudeLimits.statusBarStyle` | prominent | the coloured pill at all times, or the plain theme coloured only at the thresholds |
| `claudeLimits.statusBarWeek` | false | also show the weekly limit, after the session |
| `claudeLimits.badge` | true | numeric session badge on the activity-bar icon |
| `claudeLimits.pauseWhenExhausted` | true | stop polling until the reset time |
| `claudeLimits.showCredits` | true | show paid credits beyond the plan |

All of them are also editable from the gear icon in the panel's title bar.

## Install

Search for **Claude Rate Limit Monitor** in the Extensions view and install it.

Requires **VS Code 1.106** (October 2025) or newer: the panel uses the secondary
side bar contribution point that shipped in that release.

To install a `.vsix` you built yourself:

```
code --install-extension claude-monitor-vault-X.Y.Z.vsix
```

The extension is plain JavaScript with no runtime dependencies.

## License

MIT — free for everyone, to use, modify and redistribute. The vault's promise
does not change with the license: your keys stay on your machine, and no one,
Claude included, sees them.
