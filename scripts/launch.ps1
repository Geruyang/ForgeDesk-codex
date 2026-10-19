$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$applicationPath = Join-Path $projectRoot 'install/ForgeDesk.exe'
if (-not (Test-Path -LiteralPath $applicationPath)) { throw 'Install ForgeDesk into this project install directory first. See docs/BUILD.md.' }
$env:FORGEDESK_DATA_DIR = Join-Path $projectRoot '.runtime/app'
Start-Process -FilePath $applicationPath -WorkingDirectory $projectRoot -WindowStyle Normal
