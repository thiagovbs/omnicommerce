$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$migrationName = '20260918190000_order_sync_and_status_history'
$containerId = $null

function Invoke-TestSql([string] $Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 |
        docker exec -i $containerId psql -U postgres -v ON_ERROR_STOP=1 --quiet
    if ($LASTEXITCODE -ne 0) { throw "SQL validation failed: $Path" }
}

try {
    # No host port, host mount or application DATABASE_URL is used.
    $containerId = docker run --rm -d --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL' }
    $containerId = $containerId.Trim()
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        docker exec $containerId pg_isready -U postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Disposable PostgreSQL did not become ready' }

    $migrations = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'prisma/migrations') -Directory | Sort-Object Name
    foreach ($migration in $migrations) {
        if ($migration.Name -eq $migrationName) {
            Invoke-TestSql (Join-Path $projectRoot 'prisma/tests/order-models-before.sql')
        }
        Invoke-TestSql (Join-Path $migration.FullName 'migration.sql')
        if ($migration.Name -eq $migrationName) { break }
    }
    Invoke-TestSql (Join-Path $projectRoot 'prisma/tests/order-models-after.sql')
} finally {
    if ($containerId) {
        docker stop $containerId | Out-Null
    }
}
