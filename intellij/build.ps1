# Builds the JetBrains plugin: build\distributions\claude-monitor-vault-<version>.zip
#
#   .\build.ps1            the plugin zip
#   .\build.ps1 -Test      plus the headless integration test
#   .\build.ps1 -Verify    plus JetBrains' Plugin Verifier (2023.1, and 2025.2 downloaded once)
#
# No JDK to install: an installed JetBrains IDE ships one (jbr), and the same IDE
# is used to compile against, so nothing large is downloaded.
param([switch]$Test, [switch]$Verify)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ide = Get-ChildItem "$env:ProgramFiles\JetBrains" -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'jbr\bin\java.exe') } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $env:JAVA_HOME) {
  if (-not $ide) { throw 'No JDK: set JAVA_HOME to a JDK 17, or install a JetBrains IDE.' }
  $env:JAVA_HOME = Join-Path $ide.FullName 'jbr'
}

$tasks = @('buildPlugin')
if ($Test) { $tasks += 'test' }
if ($Verify) { $tasks += 'verifyPlugin' }
$props = @()
# Compile against the installed IDE only if it is the 2023.1 floor; any other
# version would let a newer API slip in unnoticed, so the floor is downloaded.
if ($ide -and $ide.Name -like '*2023.1*') { $props += "-PplatformLocalPath=$($ide.FullName)" }
if ($Verify) { $props += '-PverifyAlso=2025.2.1' }

& .\gradlew.bat @tasks @props --no-daemon
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem build\distributions\*.zip | ForEach-Object { "Plugin: $($_.FullName)" }
