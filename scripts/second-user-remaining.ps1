param(
  [Parameter(Mandatory = $true)][ValidateSet('Preflight', 'AclCanary', 'ProcessProbe', 'Uninstall', 'VerifyUninstall')][string]$Stage,
  [string]$CanaryManifest,
  [switch]$ConfirmUninstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
$secondSid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$installerHash = '9375C0D22D57B9CFABF5BE0DF8E85A3FEC66A17039F511AE97BCC0A6CF4EBBB9'
if ($ConfirmUninstall -and $Stage -ne 'Uninstall') { throw '-ConfirmUninstall is valid only with -Stage Uninstall.' }
if ($Stage -eq 'Uninstall' -and -not $ConfirmUninstall) { throw 'Uninstall requires its separate explicit -ConfirmUninstall command after evidence review.' }

function Resolve-FileSystemPath([string]$path) {
  $provider = $null
  $drive = $null
  $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path, [ref]$provider, [ref]$drive)
  if ($provider.Name -ne 'FileSystem') { throw 'Only FileSystem paths are allowed.' }
  return [IO.Path]::GetFullPath($full)
}

function Assert-PlainProjectPath([string]$path) {
  $full = Resolve-FileSystemPath $path
  if (-not $full.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes the approved project.' }
  $walk = [IO.Path]::GetPathRoot($full)
  foreach ($part in $full.Substring($walk.Length).Split('\')) {
    $walk = Join-Path $walk $part
    if (Test-Path -LiteralPath $walk) {
      if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point found at $walk" }
    }
  }
  return $full
}

function Current-DesktopIdentity {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  $groupSids = @($current.Groups | ForEach-Object { $_.Value })
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $matchingExplorer = $false
  foreach ($explorer in @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session })) {
    try {
      $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $current.User.Value) { $matchingExplorer = $true }
    } catch { }
  }
  return [ordered]@{
    sid = $current.User.Value; account = $current.Name; sessionId = $session
    interactive = [Environment]::UserInteractive; sameSidDesktopExplorer = $matchingExplorer
    usersGroupMember = ($groupSids -contains 'S-1-5-32-545')
    administratorsGroupMember = ($groupSids -contains 'S-1-5-32-544')
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
}

function Identity-Problems([object]$identity) {
  $problems = @()
  if ($identity.sid -ne $secondSid) { $problems += 'This remaining-acceptance command requires the actual ForgeDeskTest SID1006.' }
  if (-not $identity.usersGroupMember -or $identity.administratorsGroupMember -or $identity.elevated) { $problems += 'Use the standard Users account in a non-elevated PowerShell.' }
  if (-not $identity.interactive -or $identity.sessionId -eq 0 -or -not $identity.sameSidDesktopExplorer) { $problems += 'No same-SID interactive desktop Explorer was observed.' }
  if ($identity.account -match '(?i)\\CodexSandbox(Offline|Online)$') { $problems += 'Platform accounts are excluded.' }
  return $problems
}

function Read-PublicStage([string]$name) {
  $path = Join-Path $evidenceRoot "$name.json"
  $null = Assert-PlainProjectPath $path
  return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Baseline-Problems([object]$preflight, [object]$installed, [object]$launched) {
  $problems = @()
  if ($preflight.status -ne 'CHECKS_OK_NOT_ACCEPTED' -or $preflight.identity.sid -ne $secondSid -or $preflight.releaseVersion -ne '0.2.1' -or
      $preflight.installerSha256 -ne $installerHash -or $preflight.installDirectory -ne $installDir -or $preflight.dataDirectory -ne $dataDir) { $problems += 'Public Preflight does not match the frozen 0.2.1 SID-derived scope.' }
  if ($installed.status -ne 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED' -or $installed.sid -ne $secondSid -or $installed.releaseVersion -ne '0.2.1' -or
      $installed.installerSha256 -ne $installerHash -or -not $installed.requestedDirectoryVerified -or -not $installed.resourcesVerified -or
      $installed.installDirectory -ne $installDir -or $installed.installedExecutable -ne $appExe) { $problems += 'Public Install did not verify this release and exact SID installation.' }
  $keys = @('resources\app.asar', 'resources\codex\codex.exe', 'resources\codex\codex-code-mode-host.exe', 'resources\codex\codex-command-runner.exe',
    'resources\codex\codex-windows-sandbox-setup.exe', 'resources\process-host\process-host.exe', 'resources\templates\node-software-v1\build.mjs',
    'resources\templates\node-software-v1\verify.mjs', 'resources\templates\node-software-v1\permission-probe.mjs', 'resources\templates\node-software-v1\sandbox-probe.mjs')
  if (@($installed.resources.PSObject.Properties).Count -ne 10) { $problems += 'Install evidence does not contain exactly ten resources.' }
  foreach ($key in $keys) {
    $entry = $installed.resources.PSObject.Properties[$key].Value
    if (-not $entry -or -not $entry.matches -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $entry.sha256 -ne $entry.expectedSha256) { $problems += "Invalid public resource observation: $key" }
  }
  if ($launched.status -ne 'LAUNCHED_NOT_ACCEPTED' -or $launched.sid -ne $secondSid -or $launched.executable -ne $appExe -or $launched.dataDirectory -ne $dataDir) { $problems += 'Public Launch does not match this SID installation/data path.' }
  return $problems
}

function Canary-Problems([object]$manifest, [string]$manifestPath) {
  $problems = @()
  $id = [string]$manifest.canaryId
  if ($id -notmatch '^[a-fA-F0-9]{32}$') { return @('Canary ID must be exactly 32 hexadecimal characters.') }
  $expectedManifest = Join-Path $projectRoot "output\second-user-acl\canaries\primary-$id.json"
  $expectedFile = Join-Path $projectRoot ".runtime\app\forgedesk-acl-canary-primary-$id.txt"
  if (-not (Resolve-FileSystemPath $manifestPath).Equals($expectedManifest, [StringComparison]::OrdinalIgnoreCase)) { $problems += 'Canary manifest is not the exact project canary record.' }
  if ($manifest.schemaVersion -ne 1 -or $manifest.kind -ne 'PrimaryToSecondReadDenied' -or $manifest.ownerSid -ne $primarySid -or $manifest.readerSid -ne $secondSid) { $problems += 'Canary direction or SID contract is invalid.' }
  if ($manifest.path -ne $expectedFile -or $manifest.secretFreeCanary -ne $true -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      $manifest.linkCount -ne 1 -or $manifest.reparsePoint -ne $false) { $problems += 'Canary must be the prepared non-secret, single-link, non-reparse file.' }
  $expectedPrincipals = @($primarySid, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object
  $actualPrincipals = @($manifest.aclPrincipalSids) | Sort-Object
  if (($expectedPrincipals -join ';') -ne ($actualPrincipals -join ';')) { $problems += 'Prepared canary ACL principals do not match owner/SYSTEM/Administrators.' }
  return $problems
}

function ManifestPath-Problems([string]$path) {
  try {
    $full = Resolve-FileSystemPath $path
    $parent = Join-Path $projectRoot 'output\second-user-acl\canaries'
    if (-not ([IO.Path]::GetDirectoryName($full)).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -notmatch '^primary-[a-fA-F0-9]{32}\.json$') { return @('Canary input must be the exact public canaries directory and primary-ID.json filename.') }
    return @()
  } catch { return @('Invalid public canary manifest path.') }
}

function Is-AccessDenied([Exception]$exception) {
  while ($exception.InnerException) { $exception = $exception.InnerException }
  return (($exception -is [UnauthorizedAccessException]) -and (($exception.HResult -band 0xffff) -eq 5))
}

function Write-Observation([string]$name, [object]$observation) {
  $null = Assert-PlainProjectPath $remainingRoot
  New-Item -ItemType Directory -Path $remainingRoot -Force | Out-Null
  $path = Join-Path $remainingRoot ($name + '-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N') + '.json')
  New-Item -ItemType File -Path $path -Value ($observation | ConvertTo-Json -Depth 10) | Out-Null
  Write-Host "$name : $($observation.status) -> $path"
  return $path
}

function Owned-AppRunning {
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'ForgeDesk.exe'" -ErrorAction Stop | Where-Object { $_.SessionId -eq $identity.sessionId -and $_.ExecutablePath -eq $appExe })) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0) { throw 'Cannot verify ownership of the installed application process; uninstall was not started.' }
    if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $secondSid) { return $true }
  }
  return $false
}

$identity = Current-DesktopIdentity
$identityProblems = @(Identity-Problems $identity)
if ($identityProblems.Count) { throw ($identityProblems -join ' ') }
if ($env:FORGEDESK_DATA_DIR -or $env:CODEX_HOME -or $env:ELECTRON_RUN_AS_NODE) { throw 'Use a clean PowerShell without product/engine data overrides.' }
$evidenceRoot = Join-Path $projectRoot "output\second-user\$secondSid\evidence"
$remainingRoot = Join-Path $evidenceRoot 'remaining'
$installDir = Join-Path $projectRoot "output\second-user\$secondSid\install"
$dataDir = Join-Path $projectRoot ".runtime\second-user\$secondSid\data"
$appExe = Join-Path $installDir 'ForgeDesk.exe'
$preflight = Read-PublicStage 'preflight'
$installed = Read-PublicStage 'install'
$launched = Read-PublicStage 'launch'
$baselineProblems = @(Baseline-Problems $preflight $installed $launched)
if ($baselineProblems.Count) { throw ($baselineProblems -join ' ') }
$observation = [ordered]@{ stage = $Stage; utc = (Get-Date).ToUniversalTime().ToString('o'); identity = $identity; releaseVersion = '0.2.1'; installation = $installDir; note = 'Public evidence and scoped operation only; no authentication/engine contents or ACL/account modifications.' }

if ($Stage -eq 'Preflight') {
  $observation.status = 'PUBLIC_BASELINE_OK_NOT_ACCEPTED'
  $null = Write-Observation 'preflight' $observation
  exit 0
}

if ($Stage -eq 'AclCanary') {
  if (-not $CanaryManifest) { throw 'Provide the main-session prepared -CanaryManifest path.' }
  $pathProblems = @(ManifestPath-Problems $CanaryManifest)
  if ($pathProblems.Count) { throw ($pathProblems -join ' ') }
  $manifestPath = Assert-PlainProjectPath $CanaryManifest
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $problems = @(Canary-Problems $manifest $manifestPath)
  if ($problems.Count) { throw ($problems -join ' ') }
  $observation.manifest = $manifestPath
  $observation.manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
  $observation.canaryId = $manifest.canaryId
  $observation.requestedAccess = 'Read'
  $stream = $null
  try {
    # Only the single main-prepared public marker is opened; no directory inventory is requested.
    $stream = [IO.File]::OpenRead([string]$manifest.path)
    $null = $stream.ReadByte()
    $observation.status = 'FAILED_CANARY_READ_ALLOWED'
  } catch {
    if (Is-AccessDenied $_.Exception) { $observation.status = 'CANARY_READ_DENIED' }
    else { $observation.status = 'BLOCKED_NOT_ACCESS_DENIED'; $observation.error = $_.Exception.Message }
  } finally { if ($stream) { $stream.Dispose() } }
  $null = Write-Observation 'acl-canary' $observation
  if ($observation.status -ne 'CANARY_READ_DENIED') { exit 2 }
  exit 0
}

if ($Stage -eq 'ProcessProbe') {
  $legacy = Join-Path $PSScriptRoot 'second-user-acceptance.ps1'
  $null = Assert-PlainProjectPath $legacy
  & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $legacy -Stage ProcessProbe -PrimarySid $primarySid
  $exitCode = $LASTEXITCODE
  $observation.source = Read-PublicStage 'process-probe'
  $observation.sourceExitCode = $exitCode
  $observation.status = $observation.source.status
  $null = Write-Observation 'process-probe' $observation
  exit $exitCode
}

if ($Stage -eq 'Uninstall') {
  if (Owned-AppRunning) { throw 'Close this SID installed app normally before the separate uninstall action.' }
  $null = Assert-PlainProjectPath $installDir
  $null = Assert-PlainProjectPath $appExe
  $null = Assert-PlainProjectPath $dataDir
  if (-not (Test-Path -LiteralPath $installDir -PathType Container) -or
      -not (Test-Path -LiteralPath $appExe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $dataDir -PathType Container)) { throw 'Uninstall requires the existing exact SID installation executable and data directory.' }
  $uninstaller = Assert-PlainProjectPath (Join-Path $installDir 'Uninstall ForgeDesk.exe')
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'The exact SID installation uninstaller is missing.' }
  $observation.uninstaller = $uninstaller
  $observation.explicitConfirmation = [bool]$ConfirmUninstall
  $observation.executablePresentBefore = $true
  $observation.dataDirectoryPresentBefore = $true
  $observation.baselineEvidence = [ordered]@{}
  foreach ($name in @('preflight', 'install', 'launch')) {
    $path = Join-Path $evidenceRoot "$name.json"
    $observation.baselineEvidence[$name] = [ordered]@{ path = $path; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  }
  $observation.status = 'UNINSTALL_REQUESTED_EXPLICITLY'
  $null = Write-Observation 'uninstall-action' $observation
  $process = Start-Process -FilePath $uninstaller -Wait -PassThru
  $observation.exitCode = $process.ExitCode
  $observation.completedUtc = (Get-Date).ToUniversalTime().ToString('o')
  $observation.status = $(if ($process.ExitCode -eq 0) { 'UNINSTALLER_EXIT_ZERO_NOT_ACCEPTED' } else { 'UNINSTALLER_FAILED' })
  $null = Write-Observation 'uninstall-action' $observation
  if ($process.ExitCode -ne 0) { exit 2 }
  exit 0
}

if ($Stage -eq 'VerifyUninstall') {
  $null = Assert-PlainProjectPath $remainingRoot
  $latest = Get-ChildItem -LiteralPath $remainingRoot -File -Filter 'uninstall-action-*.json' | Sort-Object Name | Select-Object -Last 1
  if (-not $latest) { throw 'No explicit uninstall result exists.' }
  $null = Assert-PlainProjectPath $latest.FullName
  $before = Get-Content -LiteralPath $latest.FullName -Raw | ConvertFrom-Json
  if ($before.stage -ne 'Uninstall' -or $before.status -ne 'UNINSTALLER_EXIT_ZERO_NOT_ACCEPTED' -or $before.identity.sid -ne $secondSid -or $before.installation -ne $installDir -or
      @($before.baselineEvidence.PSObject.Properties).Count -ne 3) { throw 'Latest uninstall result is not a successful action for this SID installation with three public baseline records.' }
  $expectedUninstaller = Join-Path $installDir 'Uninstall ForgeDesk.exe'
  if ($before.releaseVersion -ne '0.2.1' -or $before.uninstaller -ne $expectedUninstaller -or
      ($before.exitCode -isnot [int] -and $before.exitCode -isnot [long]) -or $before.exitCode -ne 0 -or
      $before.explicitConfirmation -isnot [bool] -or -not $before.explicitConfirmation -or
      $before.executablePresentBefore -isnot [bool] -or -not $before.executablePresentBefore -or
      $before.dataDirectoryPresentBefore -isnot [bool] -or -not $before.dataDirectoryPresentBefore -or
      @(Identity-Problems $before.identity).Count -ne 0) { throw 'Uninstall action lacks matching release, exact uninstaller, explicit confirmation, existing targets or a numeric zero exit code.' }
  $null = Assert-PlainProjectPath $appExe
  $null = Assert-PlainProjectPath $dataDir
  $observation.executableRemoved = -not (Test-Path -LiteralPath $appExe -PathType Leaf)
  $observation.dataDirectoryStillExists = Test-Path -LiteralPath $dataDir -PathType Container
  $observation.evidenceDirectoryStillExists = Test-Path -LiteralPath $evidenceRoot -PathType Container
  $observation.baselineEvidencePreserved = $true
  foreach ($property in $before.baselineEvidence.PSObject.Properties) {
    $expectedPath = Join-Path $evidenceRoot ($property.Name + '.json')
    if ($property.Name -notin @('preflight', 'install', 'launch') -or $property.Value.path -ne $expectedPath) { throw 'Uninstall baseline contains an unapproved evidence path.' }
    $null = Assert-PlainProjectPath $expectedPath
    if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf) -or (Get-FileHash -LiteralPath $expectedPath -Algorithm SHA256).Hash -ne $property.Value.sha256) { $observation.baselineEvidencePreserved = $false }
  }
  $observation.status = $(if ($observation.executableRemoved -and $observation.dataDirectoryStillExists -and $observation.evidenceDirectoryStillExists -and $observation.baselineEvidencePreserved) { 'SCOPED_UNINSTALL_VERIFIED' } else { 'UNINSTALL_RETENTION_CHECK_FAILED' })
  $observation.note = 'Executable removal and directory/public-stage retention only. Product data contents were not read. Reinstall and Windows reboot are separate manual actions.'
  $null = Write-Observation 'uninstall-verify' $observation
  if ($observation.status -ne 'SCOPED_UNINSTALL_VERIFIED') { exit 2 }
}
