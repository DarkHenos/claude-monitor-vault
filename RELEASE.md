# Release preparation: 1.1.0 preview

## Marketplace continuity

- Keep `publisher: alexossart` and `name: claude-monitor-vault` unchanged.
- Display name: **Claude Monitor & Vault + ChatGPT**.
- Keep the terracotta banner, Claude command IDs and settings. The refreshed
  gauge/link logo adds teal while retaining the recognizable gauge motif.
- One panel contains the quota provider selector and a compact assistant actions menu.
- Automatic follows the project assistant; selecting Codex or Both starts monitoring.
- README leads with continuity, then explains the exact Codex and memory scope.

## Validation and packaging

```sh
npm ci --ignore-scripts
npm run build:logo
npm run build:marketplace
npm run check:release
npm test
node tests/store-smoke.js
node tests/no-secrets.js
npm run package
```

`npm run package` creates `claude-monitor-vault-1.1.0.vsix` as a VS Code
pre-release. It does not publish or install anything. The artifact includes
the native views, companion modules, local vault MCP server and translations.
No runtime npm dependencies are packaged.

`package.json` is the version source. Keep both root version fields in
`package-lock.json`, the README and the changelog aligned. The prepackage check
rejects mismatched versions and missing local documentation links or images.
The lockfile is tracked to make development dependency installation reproducible.

The Marketplace README uses PNG illustrations built from editable SVG sources.
`vsce` resolves relative README images and guide links to the existing GitHub
repository when packaging. Push the matching `media/marketplace/` assets and
`docs/GUIDE.md` with the source before publishing the VSIX, so those public URLs
exist. Packaging alone does not upload GitHub images or update the Marketplace.

The quota illustration incorporates the actual webview capture using labelled
demonstration values. Rebuild it after changing that capture. The guide preserves
the detailed vault, memory, recovery and configuration documentation.

## Local acceptance before publishing

Automatic Codex preparation is enabled for trusted projects. Its default access
mode matches Claude while retaining expiry, use confirmation and named-server
restrictions; `agentBridge.codexVaultAccess = mcp` restricts it to MCP-authorized
keys. Verify both modes and a persistent manual disconnection. Existing Codex
sessions must be restarted after their context/configuration changes.

`node scripts/check-vscode.js` exercises activation, automatic setup and opening
the panel/settings in an isolated VS Code profile with a temporary home. It uses
no real account credentials. The browser smoke test compares both quota bar
dimensions and checks that their colours differ.

Install the VSIX in a development profile, using a test project and test secrets.
Check Automatic, Claude, Codex and Both in the single panel, plus its actions menu.
Switch Claude to Codex and back, inspect the memory preview and verify each CLI
starts in the selected project with the chosen model. Verify that a cancelled
preview launches no new session. Edit shared notes, then start another session.

Connect the Codex vault MCP entry, allow a test key for `claude-monitor-vault`,
restart Codex and exercise `vault_list` / `vault_run`. Test per-use confirmation,
expiry and disconnection. Verify memory restoration refuses newer user edits.
Use a restricted project to verify that the vault and launch actions are blocked.

The automated UI tests exercise VS Code command flows with a mocked API. A real
VS Code 1.136.1 Extension Development Host also passed activation, legacy/new
command registration, opening the Claude panel and assistant diagnostics, using
an isolated profile and vault. These checks do not replace visual acceptance.
Windows DPAPI and live Codex catalog/quota access were verified during development;
macOS/Linux key stores are covered by the existing CI, which must pass on the PR.

## Publication

Review and publish through the existing `alexossart` publisher account. Use the
pre-release channel first so existing stable users are not switched immediately.
After acceptance, prepare a higher stable version and update its release date.
Never create a second Marketplace listing or change the publisher/package ID.

## Known scope

- Model switching launches new local CLI sessions; it cannot change an existing
  conversation in another extension.
- Shared memory contains explicit project files and imported snapshots. It does
  not merge contradictory prose or migrate personal ChatGPT web memories/chats.
- Native automatic memories are not watched or rewritten. Put ongoing shared
  decisions in `.agent-bridge/MEMORY.md` and import additional files explicitly.
- MCP vault tools run authorized programs locally; they are not a sandbox for
  malicious programs. Redaction cannot cover arbitrary transformations.
- Legacy vault synchronization/performance architecture remains in place; a
  broader worker-process refactor and multi-process transactional vault are
  separate hardening work, not claims made by this release.
