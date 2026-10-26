# JetBrains plugin (beta)

This folder builds the IntelliJ Platform plugin that runs the extension in
IntelliJ IDEA, WebStorm, PyCharm and the other JetBrains IDEs, 2023.1 and later.

## How it works

The plugin contains no extension logic. It ships the extension's own files
(`extension.js`, `companion/`, `vault/`, `l10n/`...) and starts them on Node.js:

```
extension.js, companion/, vault/      the VS Code extension, unchanged
host/main.js, host/vscode-shim.js     require('vscode') answered here
        │  JSON-RPC, one JSON object per line, over stdin/stdout
intellij/ (Kotlin)                    draws what the extension asks for
```

`host/vscode-shim.js` implements the part of the VS Code API the extension
uses. Configuration, mementos, events and commands live in Node; everything
the user sees (messages, quick picks, input boxes, webviews, the status bar,
terminals, editors) is a request to the IDE. A fix in the extension reaches
both editors; only a new `vscode.*` call needs a matching entry in the shim,
and `tests/host-shim.js` fails until it has one.

| VS Code | JetBrains |
|---|---|
| Side bar webview | *Claude Monitor* tool window (JCEF) |
| Webview panel | Editor tab |
| Status bar item | Status bar widget |
| Command palette | *Find Action* and *Tools > Claude Monitor & Vault* |
| Settings UI | *Settings > Tools > Claude Monitor & Vault*, built from `package.json` |
| `vscode.diff` | Diff viewer |
| Terminal | Terminal tool window tab |

Settings, `globalState` and the extension's global storage are kept in
`<IDE config>/claude-monitor-vault/`. The vault itself is `~/.claude/vault`,
shared with VS Code.

## Build

Windows, with a JetBrains IDE installed (its bundled JDK is used):

```powershell
.\build.ps1            # build\distributions\claude-monitor-vault-1.2.0.zip
.\build.ps1 -Test      # plus the headless integration test
.\build.ps1 -Verify    # plus JetBrains' Plugin Verifier
```

Elsewhere, with a JDK 17: `./gradlew buildPlugin`. The version comes from
`../package.json`.

## Try it without touching your real vault

```
./gradlew runIde -PopenProject=<folder> -PisolatedHome=<empty folder>
```

`isolatedHome` gives the extension a throwaway home folder: an empty vault and
empty `~/.claude` and `~/.codex`. The integration test does the same.
