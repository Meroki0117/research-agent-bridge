[CmdletBinding()]
param([string]$CodexConfigPath = '', [string]$BridgeConfigPath = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $BridgeConfigPath) { $BridgeConfigPath = Join-Path $PSScriptRoot 'bridge.config.json' }
if (-not $CodexConfigPath) {
    $bridgeCodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $CodexConfigPath = Join-Path $bridgeCodexDir 'config.toml'
}
$bridgeNode = (Get-Command node -ErrorAction Stop).Source
$bridgeMajor = [int]((& $bridgeNode -p 'Number.parseInt(process.versions.node)') | Select-Object -Last 1)
if ($bridgeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
$CodexConfigPath = [System.IO.Path]::GetFullPath($CodexConfigPath)
$BridgeConfigPath = [System.IO.Path]::GetFullPath($BridgeConfigPath)
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/@modelcontextprotocol/server/package.json'))) {
        & npm.cmd ci --ignore-scripts --registry https://registry.npmjs.org --cache (Join-Path $PSScriptRoot '.npm-cache')
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist/cli.js'))) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    if (-not (Test-Path -LiteralPath $BridgeConfigPath)) {
        & $bridgeNode dist/cli.js init --config $BridgeConfigPath
        if ($LASTEXITCODE -ne 0) { throw 'Config initialization failed.' }
    }
    & $bridgeNode dist/cli.js doctor --config $BridgeConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'Doctor failed. Check API key environment variables before installation.' }
    & $bridgeNode dist/cli.js install-codex --config $BridgeConfigPath --codex-config $CodexConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'Codex installation failed. Existing settings were not overwritten.' }
    Write-Host 'Installed. Fully restart Codex so it inherits the API key environment variable, then open a new chat.'
    Write-Host 'Ask: Read research_bridge get_bridge_info, then run a two-agent research test.'
} finally { Pop-Location }
