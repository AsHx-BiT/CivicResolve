$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env'
$clusterRoot = Join-Path $env:LOCALAPPDATA 'CivicResolve'
$dataDir = Join-Path $clusterRoot 'postgres18-demo'
$logFile = Join-Path $clusterRoot 'postgres18-demo.log'
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$initdb = Join-Path $pgBin 'initdb.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$pgIsReady = Join-Path $pgBin 'pg_isready.exe'
$psql = Join-Path $pgBin 'psql.exe'
$port = 5433

foreach ($binary in @($initdb, $pgCtl, $pgIsReady, $psql)) {
    if (-not (Test-Path -LiteralPath $binary)) {
        throw "PostgreSQL 18 client tools were not found at $pgBin. Install PostgreSQL 18 or update this script's pgBin path."
    }
}
if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing $envFile. Copy .env.example to .env and configure DATABASE_URL first."
}

$databaseLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*DATABASE_URL=' } | Select-Object -First 1
if (-not $databaseLine) {
    throw 'DATABASE_URL is missing from .env.'
}
$databaseUrl = $databaseLine.Substring($databaseLine.IndexOf('=') + 1).Trim().Trim('"').Trim("'")
try {
    $uri = [Uri]$databaseUrl
} catch {
    throw 'DATABASE_URL is not a valid PostgreSQL URL.'
}
if ($uri.Scheme -notin @('postgres', 'postgresql') -or $uri.Host -notin @('127.0.0.1', 'localhost') -or $uri.Port -ne $port) {
    throw "This local cluster script expects DATABASE_URL to use localhost:$port."
}
$databaseName = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
$userName = [Uri]::UnescapeDataString($uri.UserInfo.Split(':', 2)[0])
$password = [Uri]::UnescapeDataString($uri.UserInfo.Split(':', 2)[1])
if ($databaseName -notmatch '^[A-Za-z0-9_]+$' -or $userName -notmatch '^[A-Za-z0-9_]+$' -or -not $password) {
    throw 'DATABASE_URL must include a simple database name, username, and password for local initialization.'
}

New-Item -ItemType Directory -Path $clusterRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}
$versionFile = Join-Path $dataDir 'PG_VERSION'
if (-not (Test-Path -LiteralPath $versionFile)) {
    $normalizedDataDir = $dataDir.Replace('\', '/')
    $activeClusterProcess = Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Replace('\', '/') -like "*$normalizedDataDir*"
    } | Select-Object -First 1
    if ($activeClusterProcess) {
        throw "A PostgreSQL process (PID $($activeClusterProcess.ProcessId)) is already using $dataDir. The cluster is missing PG_VERSION, so initialization was stopped to protect the running server. Stop it cleanly and inspect the data directory before retrying."
    }

    $existingFiles = @(Get-ChildItem -LiteralPath $dataDir -Force)
    if ($existingFiles.Count -gt 0) {
        throw "The cluster directory exists but is not initialized: $dataDir. Move or inspect it manually; this script will not overwrite it."
    }

    $passwordFile = Join-Path $clusterRoot 'postgres-init-password.tmp'
    [IO.File]::WriteAllText($passwordFile, $password)
    try {
        & $initdb -D $dataDir -U $userName "--pwfile=$passwordFile" --auth=scram-sha-256 --encoding=UTF8 --no-locale
        if ($LASTEXITCODE -ne 0) {
            throw "initdb failed with exit code $LASTEXITCODE."
        }
    } finally {
        Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
    }

    Add-Content -LiteralPath (Join-Path $dataDir 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = $port`n"
}

& $pgCtl -D $dataDir status *> $null
if ($LASTEXITCODE -ne 0) {
    & $pgCtl -D $dataDir -l $logFile start
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL did not start. Inspect $logFile for details."
    }
}

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    & $pgIsReady -h 127.0.0.1 -p $port *> $null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    throw "PostgreSQL did not become ready on 127.0.0.1:$port. Inspect $logFile for details."
}

$passFile = Join-Path $clusterRoot 'pgpass-start.tmp'
$escapedPassword = $password.Replace('\', '\\').Replace(':', '\:')
$passFileContent = "{0}:{1}:*:{2}:{3}" -f '127.0.0.1', $port, $userName, $escapedPassword
[IO.File]::WriteAllText($passFile, $passFileContent)
$previousPassFile = $env:PGPASSFILE
try {
    $env:PGPASSFILE = $passFile
    $databaseExists = (& $psql -w -h 127.0.0.1 -p $port -U $userName -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$databaseName'").Trim() -eq '1'
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not authenticate to the local PostgreSQL cluster with the credentials in .env.'
    }
    if (-not $databaseExists) {
        & $psql -w -h 127.0.0.1 -p $port -U $userName -d postgres -c "CREATE DATABASE `"$databaseName`""
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create database $databaseName."
        }
    }

    & $psql -w -h 127.0.0.1 -p $port -U $userName -d $databaseName -tAc 'SELECT current_user'
    if ($LASTEXITCODE -ne 0) {
        throw "Could not connect to database $databaseName."
    }
} finally {
    $env:PGPASSFILE = $previousPassFile
    Remove-Item -LiteralPath $passFile -Force -ErrorAction SilentlyContinue
}

Write-Output "CivicResolve PostgreSQL is ready on 127.0.0.1:$port (database: $databaseName)."
