$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousOptions = $env:TS_NODE_COMPILER_OPTIONS
Push-Location $projectRoot
try {
    # --conditions=react-server: lib/integrations/crypto importa "server-only".
    $env:TS_NODE_COMPILER_OPTIONS = '{"module":"CommonJS","moduleResolution":"node"}'
    node --conditions=react-server -r ts-node/register scripts/register-connection.ts
    if ($LASTEXITCODE -ne 0) { throw 'Could not register connection' }
} finally {
    $env:TS_NODE_COMPILER_OPTIONS = $previousOptions
    Pop-Location
}
