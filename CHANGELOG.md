# Changelog

All notable changes to **Claude Monitor & Vault**.

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
