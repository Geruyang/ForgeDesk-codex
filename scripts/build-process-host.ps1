param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'packages/process-host/ProcessHost.cs'
$outputDir = Join-Path $root 'vendor/process-host'
$output = Join-Path $outputDir 'process-host.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '64-bit .NET Framework C# compiler is unavailable' }
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "process-host compile failed: $LASTEXITCODE" }
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  schemaVersion = 1
  file = 'process-host.exe'
  sha256 = $hash
  compiler = 'Microsoft .NET Framework csc v4.0.30319 x64'
  source = 'packages/process-host/ProcessHost.cs'
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDir 'manifest.json') -Encoding utf8
Write-Output "process-host.exe SHA256 $hash"
