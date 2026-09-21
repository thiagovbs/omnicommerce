$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$containerId = $null
$previousUrl = $env:DATABASE_URL
$previousDirectUrl = $env:DIRECT_DATABASE_URL
$previousOptions = $env:TS_NODE_COMPILER_OPTIONS
$testPassword = [guid]::NewGuid().ToString('N')
Push-Location $projectRoot
try {
    $containerId = docker run --rm -d -p 127.0.0.1::5432 -e "POSTGRES_PASSWORD=$testPassword" postgres:16-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Could not start test PostgreSQL' }
    $containerId = $containerId.Trim()
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        docker exec $containerId pg_isready -U postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Test PostgreSQL did not become ready' }
    $mapping = docker port $containerId 5432/tcp
    if ($LASTEXITCODE -ne 0 -or $mapping -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Unexpected test port mapping' }
    $testPort = $Matches[1]
    $env:DATABASE_URL = "postgresql://postgres:${testPassword}@127.0.0.1:${testPort}/postgres?schema=public"
    # Sem pooler no contêiner de teste: a conexão direta é a mesma.
    $env:DIRECT_DATABASE_URL = $env:DATABASE_URL
    & ./node_modules/.bin/prisma.cmd migrate deploy
    if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
    & ./node_modules/.bin/prisma.cmd migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
    if ($LASTEXITCODE -ne 0) { throw 'Migration/schema drift detected' }
    $env:TS_NODE_COMPILER_OPTIONS = '{"module":"CommonJS","moduleResolution":"node"}'
    node --conditions=react-server -r ts-node/register --test tests/orders.integration.test.ts tests/access.integration.test.ts tests/integration-events.test.ts tests/mercadolivre.test.ts tests/sebo.test.ts tests/oauth.test.ts tests/reconciliation.test.ts tests/messaging.test.ts tests/catalog.test.ts tests/categories.test.ts tests/ml-catalog.test.ts tests/listing-attributes.test.ts tests/shopee.test.ts tests/olx.test.ts tests/tenant-isolation.test.ts tests/organization-profile.test.ts tests/marketplace-config.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Order service tests failed' }
} finally {
    $env:DATABASE_URL = $previousUrl
    $env:DIRECT_DATABASE_URL = $previousDirectUrl
    $env:TS_NODE_COMPILER_OPTIONS = $previousOptions
    if ($containerId) { docker stop $containerId | Out-Null }
    Pop-Location
}
