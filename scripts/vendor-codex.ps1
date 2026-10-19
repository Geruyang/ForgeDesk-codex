param([string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
if (-not $SourceDirectory) { $SourceDirectory = Split-Path (Get-Command codex.exe).Source }
$target = Join-Path $PSScriptRoot '../vendor/codex'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$records = foreach ($name in @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')) {
    $source = Join-Path $SourceDirectory $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing required engine resource: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $target $name)
    @{ name = $name; sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash; size = (Get-Item -LiteralPath $source).Length }
}
$version = & (Join-Path $target 'codex.exe') --version
@{ schemaVersion = 1; version = $version; source = $SourceDirectory; recordedAt = (Get-Date).ToString('o'); files = @($records) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'manifest.json') -Encoding utf8
Write-Output $version
Write-Output 'Engine resources copied and hashed.'
