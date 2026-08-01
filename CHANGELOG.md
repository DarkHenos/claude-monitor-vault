# Changelog

All notable changes to **Claude Monitor & Vault**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from 1.0.0 onwards.

## [1.0.0] - 2026-08-01

### Added

- Recovery phrase: 17 words, shown once and stored nowhere, that unlock a copy
  of the master key when the OS secret store is lost.
- Encrypted export file (`.cvault`), refreshed automatically at every change,
  opened by the recovery phrase on any machine.
- Import of an export file, with or without the phrase depending on the machine.
- Bin: a deleted key is kept encrypted for 30 days and restored in one click.
- Key renaming, with spaces and accents normalised.
- Value replacement, without ever displaying the previous value.
- Public or secret flag per key, detected at creation for known published forms.
- MCP authorisation restricted to named servers.
- Vault terminal: the selected keys arrive as environment variables.
- Marker completion for `{{vault:` in the editor.
- Confirmation on every use, enabled per key.
- Commit guard: warns when a vault secret appears in clear in a saved file or in
  the staging area.
- Key age and last use on each row, with a marker on keys unused for six months.
- Quota consumption projection.
- Right-click menu on the panel background.

### Changed

- The access log and connection state are pinned to the bottom of the panel
  instead of following the key list.
- A key restored from the bin keeps its original name when free, otherwise takes
  the `RECOVERY_` prefix.
- Importing moves the replaced keys to the bin when the master key does not
  change, and reports the loss when it does.
- `revokeAll` requires an explicit confirmation token.
- Marker completion and the save watcher are registered independently, so a
  failure in either cannot disable the extension.

### Fixed

- The bridge refused every key: `core.js` had gained a dependency missing from
  the file list copied by the installer.
- A key restricted to one MCP server was usable by all of them on the hook path,
  only stdio servers going through the proxy.
- An approved replacement widened an MCP authorisation to every server and
  re-derived the key's visibility.
- An import by phrase left the local recovery envelope pointing at the replaced
  key.
- A pending replacement outlived the deletion or the manual replacement of its
  key.
- A key could be deleted by name collision when VS Code closed.
- The commit guard did not detect the `VARIABLE=value` form.
- A key restored from the bin overwrote a live key sharing its identifier.
- 156 interface strings were missing from the four translated languages.
- The panel could show translated row labels above untranslated wording. Its
  dictionary is baked into the HTML when the view is drawn, while the labels
  travel with the data, so the two could drift apart. The panel now remembers
  which language its dictionary was built in and rebuilds itself as soon as it
  stops matching.

### Security

- The export file encrypts its entire contents, key names included.
- The commit guard compares fingerprints and decrypts nothing. It warns without
  blocking, so as not to expose an oracle any third-party repository could
  trigger.
- The `public` and `confirmation` flags are sealed with the entry: editing them
  in the file breaks decryption instead of disabling the protection.
- Writing a vault older than the anti-replay counter is refused.

## [0.58.21] - 2026-07-30

### Changed

- Three screenshots in the readme: the panel in a window, the panel on its own,
  and the activity-bar icon with its counter.

### Fixed

- Readme layout: pixel widths instead of percentages, plain HTML in table cells
  and no floats, so GitHub, the Marketplace and the VS Code Details tab render
  the same page.
- Images served from the repository over absolute URLs, so they add nothing to
  the download.

## [0.58.2] - 2026-07-30

### Added

- Disconnect command: removes the hooks and restores the MCP servers, keeping
  the vault and its keys.
- `claudeLimits.autoConnect` setting, on by default, to stop the extension from
  writing into Claude Code's configuration at startup.

### Changed

- Vault format v2: the use counter, the cap and the expiry date are covered by
  the file signature. An existing vault is read with the format it was signed
  with and migrates on its first write.
- The panel lives in the secondary side bar by default and switches sides in one
  click. An existing install that never moved it will find it on the left.

### Fixed

- The container was declared under `secondarySideBar` instead of
  `secondarySidebar`: absent from the schema, the key was ignored in silence and
  VS Code dropped the panel into the Explorer, so a fresh profile opened on a
  bare two-line list.
- The activity-bar icon and its counter survive moving the panel.
- "Allow for MCP" opened the snippet dialog instead of granting the
  authorisation: it shared its action id with "Use in an MCP server".
- Looking for `node` no longer opens a login shell, and gives up after three
  seconds, instead of freezing every extension while a shell profile loaded.
- The `User-Agent` is read from the manifest instead of announcing
  `claude-limits-vscode/0.9`.
- The panel no longer flickers from one side to the other at startup.
- Opening the panel could throw a `ReferenceError`: the webview provider was
  registered before the view it reads its header from.
- Adding a secret through a slow pipe span a CPU core at 100 % until the tool
  timed out.
- The MCP snippets used a bare `node` while the installer writes an absolute
  path, which died with `ENOENT` in a VS Code started from the Finder.
- Shared-cache change detection now includes the inode: size and modification
  time alone are identical for two same-length writes within the same second.
- On Windows, a cache write colliding with another window's read retries the
  atomic rename before falling back.
- Readme brought back in line with the current default.

### Security

- The replay counter is raised only once the vault is safely on disk. Raised
  first, an interruption between the two left the counter one ahead and every
  later load refused the file as a replay, losing every secret.
- Updating the counter no longer re-runs the protection chain, where a single
  hiccup from the OS keyring silently wrote the master key in the clear.
- A missing key file is refused instead of silently regenerating one, which made
  every stored secret undecryptable and then blamed the user for tampering.
- The master key travels through the environment instead of being embedded in a
  PowerShell script, where Script Block Logging captured it verbatim into a
  persistent Windows event log.
- The panel no longer creates the master key just by being drawn.
- A key capped in uses or burned after use could be handed back its spent uses
  by editing the file, since the counter sat outside the signature.

## [0.58.1] - 2026-07-29

### Fixed

- Linux: the vault reaches the OS keyring when the extension host runs with a
  stripped environment, started from a desktop launcher, a systemd unit or an
  SSH session. It now points at `$XDG_RUNTIME_DIR/bus` when
  `DBUS_SESSION_BUS_ADDRESS` is missing, provided the socket is genuinely there.
  Until then a healthy keyring simply went unused and the master key settled for
  file permissions.

## [0.58.0] - 2026-07-29

First public release on the Visual Studio Marketplace.

### Added

- Live 5-hour session and weekly usage, read from the official
  `/api/oauth/usage` endpoint, the same data as Claude Code's `/usage` command.
- Authentication reuses the local Claude Code OAuth credentials. Nothing but the
  request to `api.anthropic.com` leaves the machine: no telemetry, no analytics,
  no account, no runtime dependency.
- Activity-bar gauge, status-bar readout, panel, and a numeric badge on the
  activity-bar icon.
- One shared cache across every VS Code window: a single real request feeds them
  all.
- Threshold notifications, automatic back-off on HTTP 429 honouring
  `Retry-After`, and the last known values kept on screen when the API is
  unreachable.
- Claude Vault: an encrypted local vault that lets Claude use a secret without
  ever seeing its value. AES-256-GCM per entry, HKDF-derived subkeys, and an
  HMAC over the whole file.
- English, French, German, Spanish and Portuguese.

### Fixed

- The activity-bar badge showed twice its value: VS Code sums the numeric badges
  of a container's views, and both the panel and the gauge carried one.
- Clicking the icon no longer bounces the panel into the secondary side bar.
- A UTF-8 BOM in `settings.json` made the parser fail silently and the installer
  rewrite the file with its own hooks alone, dropping the user's permissions,
  model and plugins.
- Uninstalling unwraps the MCP servers before deleting the proxy they point at.
- A retrieved secret could be truncated on Windows, where writes to a pipe are
  asynchronous and the process exited without waiting.
- Refreshing from the panel repaints the badge, the status bar and the gauge
  immediately.
- POSIX permissions: directories were locked down to `0600`, which strips the
  execute bit and makes them untraversable.
- Instant cross-window sync works on macOS again: `fs.watch` does not guarantee
  a filename there, and those events were discarded.

### Security

- The master key is held by the operating system's secret store on all three
  platforms: DPAPI on Windows, the login keychain on macOS, libsecret on Linux.
  It used to be written as-is on macOS and Linux, guarded by file permissions
  alone, so a copy of the home directory was enough to recover every secret. An
  existing vault migrates automatically, keeping the same master key.
- A keyring storing its contents in the clear is refused: a GNOME login keyring
  unlocked with an empty password writes secrets unencrypted while the Secret
  Service API keeps reporting success. The vault falls back to file permissions
  and says so.
- A protection mode is adopted only after a real round trip, the key written and
  read back.
- The secret never travels through a command line on any platform: `security`
  and `secret-tool` receive it on standard input, as PowerShell already did.
- Hooks and MCP servers run under a real `node` instead of the Electron binary,
  which silently turned the guard and the `{{vault:NAME}}` substitution into
  no-ops on Windows and opened a second editor window elsewhere.
- The OAuth token is read from the macOS login keychain when the credentials
  file is absent.
- `CLAUDE_CONFIG_DIR` is honoured, instead of hard-coding `~/.claude`.
- The vault directory is restricted to the current user and every write is
  atomic, with `fsync`.

## Prior to 0.58.0

Never published. Versions 0.1.0 through 0.57.0 were local development builds,
packaged as a `.vsix` and installed on the author's machine only, with the
version bumped on nearly every iteration. Version control starts at 0.52.0,
which already carried the whole extension: usage panel, shared cache, status
bar, activity-bar container, vault, Claude Code hooks, MCP proxy and the five
translations. The steps to publication were the display name (0.57.0), the
manifest placeholders resolved inside the vsix (0.56.0), the Marketplace trust
links (0.55.0), the icon (0.54.0) and the rename to `claude-monitor-vault`
(0.53.0).
