# Changelog

All notable changes to **Claude Monitor & Vault**.

## 0.58.21 — 2026-07-30

- **The extension page shows what the extension looks like.** Three screenshots
  in the readme: the panel in a window, the panel on its own, and the
  activity-bar icon with its counter.
- Fixed how they are laid out. A percentage width is stretched to its container
  by the Details tab in VS Code, which blew the panel screenshot up to the full
  width of the page and dropped the floated icon on top of the text. The widths
  are in pixels now, the cells hold plain HTML rather than markdown, and nothing
  floats — so GitHub, the Marketplace and that tab render the same page.
- The images are served from the repository over absolute URLs, so they add
  nothing to the size of the download.

## 0.58.2 — 2026-07-30

**A fresh install now opens on the real panel.** On a new VS Code profile the
extension showed a bare two-line list, without progress bars and without the
vault, and nothing explained why.

The cause turned out to be a single capital letter. The container was declared
under **`secondarySideBar`**, the name of the proposed API — while the
contribution point, finalised in VS Code 1.106, is **`secondarySidebar`**, with
a lowercase b. Absent from the schema, the key was ignored in silence, the
container was never created, and VS Code dropped the panel into the **Explorer**
while saying so in its log at every single window launch. Since the panel
defaulted to that phantom home, the one entry point a newcomer could see — the
activity-bar icon on the left — led to a bare list instead. The vault is drawn
inside the panel, so it went missing along with it.

- **The mirror button finally moves the panel.** Both containers are real now,
  so the panel genuinely lives next to the chat by default and switches sides in
  one click. Whichever side is unused has no visible view at all, which is what
  makes VS Code hide its icon — nothing is duplicated, and nothing has to force
  it.
- **The left icon and its counter survive the move.** VS Code hides a container
  as soon as every one of its views is switched off, and a badge belongs to a
  view, so something has to stay on the left. That something now lists nothing:
  a single collapsed line, the summary in its title, the badge on the icon, and
  — unfolded — a sentence saying where the panel went with a link to bring it
  back. Repeating the panel's own figures underneath it was the duplicate.
- README brought back in line: it described the old default and promised a
  click-to-recall gesture that 0.58.0 had removed.

### Vault: nothing can be lost any more

- **An interruption could make the whole vault unreadable, permanently.** The
  replay counter was raised *before* the vault was written, so a crash between
  the two left the counter one ahead and every later load refused the file as a
  replay — every secret gone. The counter now moves only once the vault is
  safely on disk, and the anti-replay guarantee is unchanged for the case it
  exists to cover.
- **A passing glitch from the OS keyring silently wrote the master key in the
  clear.** Saving the vault re-ran the whole protection chain each time, so one
  hiccup was enough to fall back to `plain` — twice per write on Windows, at
  that. Updating the counter no longer touches the key material at all.
- **A missing key file no longer regenerates one in silence**, which made every
  stored secret undecryptable and then blamed the user for tampering. It now
  refuses and points to the two deliberate ways out.
- **The master key no longer travels inside a PowerShell script.** Embedded as
  a literal, it was captured verbatim by Script Block Logging — the key to the
  entire vault, in clear, in a persistent Windows event log. It goes through the
  environment now; the script is a constant.
- **The panel no longer creates the master key just by being drawn.** On a
  machine where no secret is ever stored, opening it used to force the key into
  existence and block the extension host on several system calls.

### The use counter is now enforceable

- **A key capped at *n* uses, or burned after use, could be handed back its
  spent uses.** The counter, the cap and the expiry date sat outside the file
  signature, while they are exactly what the expiry and burn decisions read:
  anyone able to write the vault file could reset `uses` and keep using a key
  the interface presented as burned. They still could not decrypt anything
  without the master key, but a limit that can be erased is not a limit. The
  vault format moves to v2 and signs all three. An existing vault is read with
  the format it was signed with and migrates on its first write — nothing to do,
  no key to re-enter.

### Automatic connection, and how to refuse it

- Wiring Claude Code on startup is what makes the extension usable without
  reading anything, so it stays the default. But it writes into another
  product's configuration, and that should remain a choice: the new
  **`claudeLimits.autoConnect`** setting turns it off. Off, nothing of Claude
  Code is touched until you press Connect — and you press it at every start.
  The setting gates both writes, the hooks and the MCP wrapping.

### Also in this release

- **A way back.** The extension writes into Claude Code's own configuration —
  hooks, and every local stdio MCP server rewired through its proxy — and
  nothing undid it: uninstalling left the hooks firing and the servers pointing
  at a bridge about to vanish. A **Disconnect** command now removes the hooks
  and restores the servers, keeping the vault and its keys.
- “Allow for MCP” in the key menu did nothing: it shared its action id with
  “Use in an MCP server”, so it opened the snippet dialog instead. The
  authorisation can be granted and revoked again.
- Looking for `node` no longer opens a login shell, and gives up after three
  seconds. Loading a full shell profile — nvm, rbenv, oh-my-zsh — froze every
  extension in the process before the first figure was drawn.

- The `User-Agent` sent to Anthropic announced `claude-limits-vscode/0.9`, long
  after the extension had been renamed and had reached 0.58. It is now read from
  the manifest, so it can never drift again.
- The panel no longer flickers from one side to the other at startup. The
  context key that decides which side hosts it is unset until the extension
  activates, and it was phrased so that this unset state meant “secondary side
  bar”. With the new default that would have shown the panel on the right for a
  moment on every launch, then moved it.
- Opening the panel could have thrown a `ReferenceError`: the webview provider
  was registered before the view it draws its header from was created. The order
  is now explicit.
- Adding a secret through a slow pipe span a CPU core at 100 % until the tool
  timed out, because the synchronous read loop retried without ever yielding.
- The MCP snippets offered in the interface used a bare `node`, while the
  installer writes an absolute path. A VS Code started from the Finder inherits
  a `PATH` that holds neither a Homebrew node nor an nvm shim, so a copied
  snippet died with an unexplained `ENOENT`. Both now use the resolved
  interpreter.
- Two windows could disagree on the shared cache: change detection keyed on
  size and modification time alone, which are identical for two same-length
  writes within the same second on a filesystem with one-second granularity
  (HFS+, some network mounts). The key now includes the inode, which a rename
  changes on every write.
- On Windows, a cache write colliding with another window's read fell straight
  back to a non-atomic overwrite. It now retries the atomic rename first.

An existing install that never moved the panel will find it on the left after
this update; the mirror button puts it back on the right.

## 0.58.1 — 2026-07-29

- **Linux: the vault now reaches the OS keyring when the extension host runs
  with a stripped environment** — started from a desktop launcher, a systemd
  unit or an SSH session. libsecret talks to the Secret Service over the D-Bus
  *session* bus, and GDBus only ever reads `DBUS_SESSION_BUS_ADDRESS`. When that
  variable is missing, the vault now points at the standard systemd user bus,
  `$XDG_RUNTIME_DIR/bus`, provided the socket is genuinely there. Until now a
  perfectly healthy keyring simply went unused and the master key silently
  settled for file permissions — safe, but less protected than it should have
  been. An environment that already carries the variable is left untouched.

## 0.58.0 — 2026-07-29

First public release on the Visual Studio Marketplace.

### Claude usage monitor

- Live 5-hour session and weekly usage, read from the official
  `/api/oauth/usage` endpoint — the same data as Claude Code's `/usage`
  command, with the same labels.
- Authentication reuses the local Claude Code OAuth credentials. Nothing but
  the request to `api.anthropic.com` ever leaves the machine: no telemetry, no
  analytics, no account of any kind, and no runtime dependency.
- Activity-bar gauge, status-bar readout, detailed and compact panels, and a
  numeric badge on the activity-bar icon. The panel can live in the primary or
  the secondary side bar.
- One shared cache across every VS Code window: a single real request feeds
  them all, and each window picks up another window's refresh instantly.
- Threshold notifications, automatic back-off on HTTP 429 honouring
  `Retry-After`, and the last known values kept on screen whenever the API is
  unreachable.
- Available in English, French, German, Spanish and Portuguese.

### Claude Vault

- An encrypted local vault that lets Claude *use* a secret without ever seeing
  its value: you write `$KEY_NAME` in the chat, a `PreToolUse` hook substitutes
  a single-use token at execution time, and the plaintext never enters the
  transcript. AES-256-GCM per entry, HKDF-derived subkeys, and an HMAC over the
  whole file to detect tampering.
- The vault directory is restricted to the current user (`icacls` on Windows,
  `chmod 700/600` elsewhere) and every write is atomic, with `fsync`.

### Windows, macOS and Linux now behave the same

Everything below was Windows-only, or plainly broken elsewhere, until this
release.

- **The master key is held by the operating system's own secret store on all
  three platforms**: DPAPI on Windows, the login keychain on macOS (via
  `security`), and libsecret on Linux (via `secret-tool` — GNOME Keyring,
  KWallet). It used to be written as-is into `~/.claude/vault/masterkey.bin` on
  macOS and Linux, guarded by file permissions alone, so a copy of the home
  directory — or a backup of it — was enough to recover every secret. An
  existing vault migrates automatically, keeping the very same master key:
  nothing to re-enter, no secret lost.
- **The OAuth token is now read from the macOS login keychain** when the
  credentials file is absent. Claude Code keeps its credentials there on macOS,
  so the extension used to find nothing and display no figure at all on a Mac —
  permanently, since the shared cache is only written after a successful fetch.
  The file remains the primary source on every platform.
- **Hooks and MCP servers now run under a real `node`.** They were launched
  with `process.execPath`, which inside a VS Code extension host is the
  *Electron* binary: on macOS and Linux that opens a second editor window
  instead of running the hook, and on Windows it only worked by accident,
  through an inherited `ELECTRON_RUN_AS_NODE`. Without that variable the hook
  printed nothing and exited 0, silently turning the guard and the
  `{{vault:NAME}}` substitution into no-ops. A real interpreter is now resolved
  at install time, with a launcher as a fallback when none is on `PATH`.
- **A keyring that stores its contents in the clear is refused.** A GNOME login
  keyring unlocked with an empty password — the usual headless workaround —
  writes secrets unencrypted while the Secret Service API keeps reporting
  success. The vault now checks the keyring files themselves and falls back to
  file permissions, with a warning that says so, rather than claiming a
  protection it does not have.
- **A protection mode is only adopted after a real round trip**, the key
  written *and* read back. A keyring that accepts a write without being able to
  read it back can no longer lock a vault away for good.
- **Explicit fallback**: with no keyring reachable — Linux without
  `libsecret-tools`, a container, an SSH session, a locked keyring — the vault
  keeps working on file permissions and the panel names precisely what is
  missing.
- On the three platforms the secret never travels through a command line,
  readable by any other process of the session: `security` receives its
  commands on standard input, `secret-tool` reads the secret from its own,
  as PowerShell already did for DPAPI.
- `CLAUDE_CONFIG_DIR` is honoured. Hard-coding `~/.claude` meant reading the
  token, writing the shared cache and installing the hooks in a directory
  Claude Code never looks at.
- POSIX permissions fixed: directories were being locked down to `0600`, which
  strips the execute bit and makes them untraversable. The shared cache is also
  written `0600` explicitly instead of inheriting a world-readable `0644`.
- Instant cross-window sync works on macOS again: `fs.watch` does not guarantee
  a filename there, and those events were being discarded.

### Other fixes

- The activity-bar badge showed **twice its value**. The panel and the gauge
  share one activity-bar container and VS Code *sums* the numeric badges of a
  container's views, so 45 % was displayed as 90. The gauge is now the sole
  carrier — and it shows from startup, instead of appearing only once the icon
  had been clicked, because a tree view's badge exists from view creation while
  a webview's only exists once the panel has been opened.
- Clicking the icon no longer bounces the panel into the secondary side bar;
  the location you chose is kept.
- A UTF-8 BOM in `settings.json` — written by PowerShell or older editors — made
  the parser fail silently and the installer rewrite the file with its own hooks
  alone, dropping the user's permissions, model and plugins. The BOM is now
  handled, and a file that genuinely cannot be parsed is refused rather than
  overwritten.
- Uninstalling now unwraps the MCP servers before deleting the proxy they point
  at; they used to be left pointing at a file that no longer existed.
- A retrieved secret could be truncated on Windows, where writes to a pipe are
  asynchronous and the process exited without waiting.
- Refreshing from the panel now repaints the badge, the status bar and the
  gauge immediately instead of leaving them stale until the next tick.

## Before 0.58.0 — never released

Nothing was ever published to the Marketplace before this release, so there are
no upgrade notes to give. Versions 0.1.0 through 0.57.0 were local development
builds: packaged as a `.vsix` and installed on the author's machine only, with
the version bumped on virtually every iteration. They had no users other than
their author.

Version control itself only starts at 0.52.0 — earlier builds predate the
repository. The steps between that first commit and publication were:

- **0.57.0** — display name settled as “Claude Monitor & Vault”.
- **0.56.0** — resolve the `package.nls.json` placeholders inside the vsix
  manifest, so the Marketplace shows the real name and description rather than
  raw `%ext.displayName%` tokens.
- **0.55.0** — Marketplace trust links (repository, issue tracker, homepage) and
  the transparency section of the README.
- **0.54.0** — the coral logo adopted as the extension icon.
- **0.53.0** — extension id renamed to `claude-monitor-vault`, the usage monitor
  having grown a vault alongside it.
- **0.52.0** — first commit, already carrying the whole extension: usage panel,
  shared cache, status bar, activity-bar container, vault, its Claude Code hooks
  and MCP proxy, and the five translations.
- **0.1.0 – 0.51.0** — the extension taking shape locally, from a single usage
  readout to the feature set above. No repository, no package, no audience.
