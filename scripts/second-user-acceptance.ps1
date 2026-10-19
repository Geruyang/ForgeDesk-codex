param(
  [Parameter(Mandatory = $true)][ValidateSet('Preflight', 'Install', 'Launch', 'ProcessProbe', 'Verify', 'RestartVerify')][string]$Stage,
  [Parameter(Mandatory = $true)][ValidatePattern('^S-1-5-21-(\d+-){3}\d+$')][string]$PrimarySid,
  [string]$ObservedEngineHome,
  [switch]$Upgrade
)

$ErrorActionPreference = 'Stop'
if ($Upgrade -and $Stage -ne 'Preflight') { throw '-Upgrade is supported only by the Preflight stage.' }
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
if (-not $scriptPath.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Run only the script inside the ForgeDesk-codex workspace.' }
$releaseVersion = '0.2.1'
$approvedUpgradeSid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$expectedInstallerHash = '9375C0D22D57B9CFABF5BE0DF8E85A3FEC66A17039F511AE97BCC0A6CF4EBBB9'
$expectedResourceHashes = [ordered]@{
  'resources\app.asar' = 'ED70CEA2A18DC4DA6665635E8558A4490AEE42E30A1DEE22CA4B0B056A2ECA24'
  'resources\codex\codex.exe' = 'E98C516F1C8935789AABE9122EE7E05EC4C3EFD1BA6ACF179242E031C495B99E'
  'resources\codex\codex-code-mode-host.exe' = 'EC4B09849F3A5BDF4A0C3D1F3C566BDA392FDCD9B4AEF6BD169A81EF1283FC3D'
  'resources\codex\codex-command-runner.exe' = 'BDF5160289BC4D64BC2FA38C43F9679558B3A4386226ADC66A0AF741E41424B7'
  'resources\codex\codex-windows-sandbox-setup.exe' = '4C24960E4039B90B9C0E5E86418834F823218ED6DB35CA08EFAD8A5A654295ED'
  'resources\process-host\process-host.exe' = '722cfcd0d9ea9d187663c2f58b2e31f3dde2a00500a9aec3471d7ecedbe8d4ab'
  'resources\templates\node-software-v1\build.mjs' = '7FA07121F86A42D0C8B137D8E9A8C5D716F6BB91EB3C5938199E7760556F028F'
  'resources\templates\node-software-v1\verify.mjs' = '55E377DB5FA0213BA0055FA2BCBD8B9CD45CEA7AFA569D4D389F84569A01DD0C'
  'resources\templates\node-software-v1\permission-probe.mjs' = 'A7808754A361C9BF6EFFF605A050F87337F6066A2439B9B0DADE9F8035CA6AD4'
  'resources\templates\node-software-v1\sandbox-probe.mjs' = '5506ABEE15A8B7C58ABF65905F8A1479AF13C0ABA16165AA32BBEF8A0CA69E6F'
}

function Resolve-Installer {
  $nextToScript = Join-Path $PSScriptRoot 'ForgeDesk-0.2.1-x64-setup.exe'
  if (Test-Path -LiteralPath $nextToScript -PathType Leaf) { return $nextToScript }
  return Join-Path $projectRoot 'release\ForgeDesk-0.2.1-x64-setup.exe'
}

function Release-PinsReady {
  if ($expectedInstallerHash -notmatch '^[A-Fa-f0-9]{64}$' -or $expectedResourceHashes.Count -ne 10) { return $false }
  foreach ($hash in $expectedResourceHashes.Values) { if ($hash -notmatch '^[A-Fa-f0-9]{64}$') { return $false } }
  return $true
}

function Get-UpgradeBaselineProblems([object]$identity, [object]$previousInstall, [object]$previousLaunch,
  [string]$installPath, [string]$dataPath, [bool]$dataExists, [bool]$executableExists, [bool]$appRunning) {
  $problems = @()
  $exe = Join-Path $installPath 'ForgeDesk.exe'
  if ($identity.sid -ne $approvedUpgradeSid -or -not $identity.usersGroupMember -or $identity.administratorsGroupMember -or $identity.elevated) { $problems += 'Upgrade requires the approved standard, non-elevated second Windows SID.' }
  if (-not $dataExists -or -not $executableExists) { $problems += 'Upgrade requires the existing SID-derived installation and data directory.' }
  if (-not $previousInstall -or $previousInstall.status -ne 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED' -or $previousInstall.sid -ne $identity.sid -or
      -not $previousInstall.requestedDirectoryVerified -or -not $installPath.Equals([string]$previousInstall.installDirectory, [StringComparison]::OrdinalIgnoreCase) -or
      -not $exe.Equals([string]$previousInstall.installedExecutable, [StringComparison]::OrdinalIgnoreCase)) { $problems += 'Existing successful Install evidence does not match this SID and exact install path.' }
  if (-not $previousLaunch -or $previousLaunch.status -ne 'LAUNCHED_NOT_ACCEPTED' -or $previousLaunch.sid -ne $identity.sid -or
      -not $dataPath.Equals([string]$previousLaunch.dataDirectory, [StringComparison]::OrdinalIgnoreCase) -or
      -not $exe.Equals([string]$previousLaunch.executable, [StringComparison]::OrdinalIgnoreCase)) { $problems += 'Existing Launch evidence does not match this SID and exact data/install paths.' }
  if ($appRunning) { $problems += 'Close the installed ForgeDesk normally before upgrade.' }
  return $problems
}

function Assert-PlainWorkspacePath([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not $full.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes the approved workspace.' }
  $walk = [IO.Path]::GetPathRoot($full)
  foreach ($part in $full.Substring($walk.Length).Split('\')) {
    $walk = Join-Path $walk $part
    if (Test-Path -LiteralPath $walk) {
      $item = Get-Item -LiteralPath $walk -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point found at $walk" }
    }
  }
  return $full
}

function Assert-InstallPath {
  $expected = [IO.Path]::GetFullPath((Join-Path $projectRoot ("output\second-user\" + $identity.sid + '\install')))
  $actual = Assert-PlainWorkspacePath $install
  if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install directory is not the exact SID-derived project directory.' }
}

function Current-Identity {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $groupSids = @($identity.Groups | ForEach-Object { $_.Value })
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $explorerSidMatches = $false
  $explorers = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session })
  foreach ($explorer in $explorers) {
    try {
      $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $identity.User.Value) { $explorerSidMatches = $true }
    } catch { }
  }
  return [ordered]@{
    account = $identity.Name
    sid = $identity.User.Value
    sessionId = $session
    interactive = [Environment]::UserInteractive
    sameSidDesktopExplorer = $explorerSidMatches
    usersGroupMember = ($groupSids -contains 'S-1-5-32-545')
    administratorsGroupMember = ($groupSids -contains 'S-1-5-32-544')
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    profile = $env:USERPROFILE
    os = [Environment]::OSVersion.VersionString
    computer = $env:COMPUTERNAME
  }
}

function Tool-State([string]$name) {
  $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$command
}

function Write-Result([string]$name, [object]$value) {
  $null = Assert-PlainWorkspacePath $EvidenceDirectory
  New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
  $path = Join-Path $EvidenceDirectory "$name.json"
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $history = Join-Path $EvidenceDirectory ("$name-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N') + '.json')
    Copy-Item -LiteralPath $path -Destination $history
  }
  $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding UTF8
  Write-Host "$name : $($value.status) -> $path"
}

function Read-Result([string]$name) {
  $path = Join-Path $EvidenceDirectory "$name.json"
  $null = Assert-PlainWorkspacePath $path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path. Run earlier stages in order." }
  return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Assert-Preflight([object]$identity) {
  $preflight = Read-Result 'preflight'
  if ($preflight.status -ne 'CHECKS_OK_NOT_ACCEPTED' -or $preflight.identity.sid -ne $identity.sid -or $preflight.primarySid -ne $PrimarySid -or $preflight.releaseVersion -ne $releaseVersion -or $preflight.expectedInstallerSha256 -ne $expectedInstallerHash) {
    throw 'Preflight gate does not match this Windows identity or primary SID.'
  }
}

function Installed-Processes([string]$relative, [string]$sid, [int]$session) {
  $exe = [IO.Path]::GetFullPath((Join-Path $install $relative))
  $name = [IO.Path]::GetFileName($exe)
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue | Where-Object {
    $_.SessionId -eq $session -and $_.ExecutablePath -and
    ([IO.Path]::GetFullPath($_.ExecutablePath)).Equals($exe, [StringComparison]::OrdinalIgnoreCase)
  } | Sort-Object CreationDate)
  $owned = @()
  foreach ($process in $processes) {
    try {
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid) {
        $owned += [ordered]@{ id = [int]$process.ProcessId; started = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o') }
      }
    } catch { }
  }
  return $owned
}

function Installed-Process([string]$directory, [string]$sid, [int]$session) {
  $processes = @(Installed-Processes 'ForgeDesk.exe' $sid $session)
  if ($processes.Count -eq 0) { return $null }
  return $processes[0]
}

$identity = Current-Identity
$installer = Resolve-Installer
$secondRoot = Join-Path $projectRoot ("output\second-user\" + $identity.sid)
$EvidenceDirectory = Join-Path $secondRoot 'evidence'
$install = Join-Path $secondRoot 'install'
$dataDir = Join-Path $projectRoot (".runtime\second-user\" + $identity.sid + '\data')
$now = (Get-Date).ToUniversalTime().ToString('o')

if ($Stage -eq 'Preflight') {
  $problems = @()
  if (-not (Release-PinsReady)) { $problems += 'Release hashes are not frozen yet; this version cannot be installed.' }
  if ($PrimarySid -ne 'S-1-5-21-1196670755-766692816-2897134863-1002') { $problems += 'Primary SID differs from this workspace acceptance baseline.' }
  if ($identity.sid -eq $PrimarySid) { $problems += 'Current SID is the primary user SID.' }
  if ($identity.account -match '(?i)\\CodexSandbox(Offline|Online)$') { $problems += 'Platform sandbox service accounts are not test users.' }
  if (-not $identity.usersGroupMember -or $identity.administratorsGroupMember -or $identity.elevated) { $problems += 'Second-user acceptance requires a standard Users account outside Administrators, in a non-elevated PowerShell.' }
  if (-not $identity.interactive -or $identity.sessionId -eq 0 -or -not $identity.sameSidDesktopExplorer) { $problems += 'No matching interactive desktop Explorer session was observed.' }
  if ($env:FORGEDESK_DATA_DIR) { $problems += 'Ambient FORGEDESK_DATA_DIR override is set; only Launch may set the derived second-user path.' }
  if ($env:CODEX_HOME) { $problems += 'Ambient CODEX_HOME override is set; do not redirect the packaged engine.' }
  if ($env:ELECTRON_RUN_AS_NODE) { $problems += 'ELECTRON_RUN_AS_NODE is set; launch the desktop application normally.' }
  $previousInstall = $null
  $previousLaunch = $null
  if ($Upgrade) {
    try {
      Assert-InstallPath
      $null = Assert-PlainWorkspacePath $dataDir
      $previousInstall = Read-Result 'install'
      $previousLaunch = Read-Result 'launch'
      $appRunning = @(Installed-Processes 'ForgeDesk.exe' $identity.sid $identity.sessionId).Count -gt 0
      $dataExists = Test-Path -LiteralPath $dataDir -PathType Container
      $executableExists = Test-Path -LiteralPath (Join-Path $install 'ForgeDesk.exe') -PathType Leaf
      $problems += @(Get-UpgradeBaselineProblems $identity $previousInstall $previousLaunch $install $dataDir $dataExists $executableExists $appRunning)
    } catch { $problems += "Upgrade baseline check failed: $($_.Exception.Message)" }
  } elseif (Test-Path -LiteralPath $dataDir) { $problems += 'Derived second-user data directory already exists; clean first-use isolation cannot be established.' }
  $installerHash = $null
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { $problems += 'Installer is missing.' }
  else {
    $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    if ($installerHash -ne $expectedInstallerHash) { $problems += 'Installer SHA-256 differs from the frozen release.' }
  }
  $result = [ordered]@{
    stage = $Stage; status = $(if ($problems.Count) { 'BLOCKED' } else { 'CHECKS_OK_NOT_ACCEPTED' })
    utc = $now; identity = $identity; primarySid = $PrimarySid
    releaseVersion = $releaseVersion
    installationMode = $(if ($Upgrade) { 'Upgrade' } else { 'FirstUse' })
    previousInstallUtc = $(if ($previousInstall) { $previousInstall.utc } else { $null })
    previousLaunchUtc = $(if ($previousLaunch) { $previousLaunch.utc } else { $null })
    installer = $installer; installerSha256 = $installerHash; expectedInstallerSha256 = $expectedInstallerHash
    installDirectory = $install; dataDirectory = $dataDir
    prerequisites = [ordered]@{ powershell = $PSVersionTable.PSVersion.ToString(); node = (Tool-State 'node'); git = (Tool-State 'git'); compiler = (Tool-State 'cl'); codexGlobal = (Tool-State 'codex') }
    executionPolicy = [ordered]@{ effective = (Get-ExecutionPolicy).ToString(); process = (Get-ExecutionPolicy -Scope Process).ToString() }
    note = 'Node/Git/compiler are external project prerequisites; the packaged client should start without them. No authentication data was read.'
    problems = $problems
  }
  Write-Result 'preflight' $result
  if ($problems.Count) { exit 2 }
  exit 0
}

Assert-Preflight $identity
if (-not $identity.interactive -or $identity.sessionId -eq 0 -or -not $identity.sameSidDesktopExplorer -or $identity.account -match '(?i)\\CodexSandbox(Offline|Online)$' -or -not $identity.usersGroupMember -or $identity.administratorsGroupMember -or $identity.elevated) {
  throw 'Current desktop session is not an eligible second human user session.'
}
if ($Stage -eq 'Install') {
  if (-not (Release-PinsReady)) { throw 'Release hashes are not frozen; installer was not started.' }
  Assert-InstallPath
  if (@(Installed-Processes 'ForgeDesk.exe' $identity.sid $identity.sessionId).Count -gt 0) { throw 'Close the installed ForgeDesk normally before installation.' }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedInstallerHash) {
    throw 'Installer missing or changed since the frozen release.'
  }
  Write-Host "Opening the interactive installer with the project install directory preselected: $install"
  # NSIS consumes the entire unquoted remainder after its final /D= switch, including spaces.
  $process = Start-Process -FilePath $installer -ArgumentList ("/D=" + $install) -Wait -PassThru
  $problems = @()
  $resources = [ordered]@{}
  $installedExe = Join-Path $install 'ForgeDesk.exe'
  try {
    Assert-InstallPath
    $verifiedExe = Assert-PlainWorkspacePath $installedExe
    if (-not (Test-Path -LiteralPath $verifiedExe -PathType Leaf)) { $problems += 'Installed executable was not found in the requested project directory.' }
    elseif (-not (Get-Item -LiteralPath $verifiedExe -Force).FullName.Equals($installedExe, [StringComparison]::OrdinalIgnoreCase)) { $problems += 'Installed executable path differs from the requested directory.' }
    foreach ($relative in $expectedResourceHashes.Keys) {
      $file = Join-Path $install $relative
      $null = Assert-PlainWorkspacePath $file
      $hash = if (Test-Path -LiteralPath $file -PathType Leaf) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } else { $null }
      $resources[$relative] = [ordered]@{ sha256 = $hash; expectedSha256 = $expectedResourceHashes[$relative]; matches = ($hash -eq $expectedResourceHashes[$relative]) }
      if ($hash -ne $expectedResourceHashes[$relative]) { $problems += "Missing or changed installed resource: $relative" }
    }
  } catch { $problems += $_.Exception.Message }
  $result = [ordered]@{ stage = $Stage; status = $(if ($process.ExitCode -ne 0) { 'FAILED' } elseif ($problems.Count) { 'BLOCKED' } else { 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED' }); utc = (Get-Date).ToUniversalTime().ToString('o'); sid = $identity.sid; releaseVersion = $releaseVersion; installerSha256 = $expectedInstallerHash; exitCode = $process.ExitCode; installDirectory = $install; installedExecutable = $installedExe; requestedDirectoryVerified = ($problems.Count -eq 0); resourcesVerified = ($problems.Count -eq 0 -and $resources.Count -eq 10); resources = $resources; problems = $problems }
  Write-Result 'install' $result
  if ($process.ExitCode -ne 0 -or $problems.Count) { exit 2 }
  exit 0
}

if ($Stage -eq 'Launch') {
  Assert-InstallPath
  $installed = Read-Result 'install'
  if ($installed.status -ne 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED' -or $installed.sid -ne $identity.sid -or $installed.installDirectory -ne $install -or -not $installed.requestedDirectoryVerified -or $installed.releaseVersion -ne $releaseVersion -or $installed.installerSha256 -ne $expectedInstallerHash -or -not $installed.resourcesVerified) { throw 'Install stage did not verify this release and its resources at the SID-derived project installation.' }
  $exe = Join-Path $install 'ForgeDesk.exe'
  $null = Assert-PlainWorkspacePath $exe
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Installed executable missing: $exe" }
  if ($env:FORGEDESK_DATA_DIR -or $env:CODEX_HOME -or $env:ELECTRON_RUN_AS_NODE) { throw 'Ambient product/engine data override is set. Open a clean PowerShell session.' }
  $aclScript = Join-Path $PSScriptRoot 'second-user-acl.ps1'
  if (-not (Test-Path -LiteralPath $aclScript -PathType Leaf)) { throw 'Required workspace ACL preparation script is missing.' }
  & $aclScript -Scope Second -Apply
  if (-not $?) { throw 'Second-user DACL preparation did not succeed. Application was not launched.' }
  $env:FORGEDESK_DATA_DIR = $dataDir
  try { $launched = Start-Process -FilePath $exe -WorkingDirectory $install -PassThru }
  finally { Remove-Item Env:FORGEDESK_DATA_DIR -ErrorAction SilentlyContinue }
  Write-Result 'launch' ([ordered]@{ stage = $Stage; status = 'LAUNCHED_NOT_ACCEPTED'; utc = (Get-Date).ToUniversalTime().ToString('o'); sid = $identity.sid; executable = $exe; processId = $launched.Id; dataDirectory = $dataDir; note = 'Only this process inherits the SID-derived FORGEDESK_DATA_DIR. Login and inference require UI evidence.' })
  exit 0
}

if ($Stage -eq 'ProcessProbe') {
  $processes = [ordered]@{
    application = @(Installed-Processes 'ForgeDesk.exe' $identity.sid $identity.sessionId)
    engine = @(Installed-Processes 'resources\codex\codex.exe' $identity.sid $identity.sessionId)
    processHost = @(Installed-Processes 'resources\process-host\process-host.exe' $identity.sid $identity.sessionId)
  }
  $problems = @()
  foreach ($key in $processes.Keys) { if ($processes[$key].Count -eq 0) { $problems += "No installed $key process owned by second SID in this desktop session." } }
  $result = [ordered]@{ stage = $Stage; status = $(if ($problems.Count) { 'BLOCKED' } else { 'CHECKS_OK_NOT_ACCEPTED' }); utc = $now; sid = $identity.sid; installDirectory = $install; processes = $processes; problems = $problems; note = 'A momentary process snapshot is not proof of successful inference or future process isolation.' }
  Write-Result 'process-probe' $result
  if ($problems.Count) { exit 2 }
  exit 0
}

if ($Stage -eq 'Verify') {
  $problems = @()
  $launched = Read-Result 'launch'
  if ($launched.sid -ne $identity.sid -or $launched.dataDirectory -ne $dataDir) { $problems += 'Launch stage did not use this SID-derived data directory.' }
  $resources = [ordered]@{}
  foreach ($relative in $expectedResourceHashes.Keys) {
    $file = Join-Path $install $relative
    $hash = if (Test-Path -LiteralPath $file -PathType Leaf) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } else { $null }
    $resources[$relative] = [ordered]@{ present = [bool]$hash; sha256 = $hash; expectedSha256 = $expectedResourceHashes[$relative]; matches = ($hash -eq $expectedResourceHashes[$relative]) }
    if ($hash -ne $expectedResourceHashes[$relative]) { $problems += "Missing or changed installed resource: $relative" }
  }
  $running = Installed-Process $install $identity.sid $identity.sessionId
  if ($null -eq $running) { $problems += 'Installed ForgeDesk.exe is not running in this desktop session.' }
  $enginePath = $null
  if (-not $ObservedEngineHome) { $problems += 'Provide -ObservedEngineHome copied from the installed Settings screen.' }
  else {
    $enginePath = [IO.Path]::GetFullPath($ObservedEngineHome)
    $expectedEnginePath = Join-Path $dataDir 'engine'
    if (-not $enginePath.Equals($expectedEnginePath, [StringComparison]::OrdinalIgnoreCase)) { $problems += 'Observed engine directory differs from the SID-derived product data directory.' }
    if (-not (Test-Path -LiteralPath $enginePath -PathType Container)) { $problems += 'Observed engine directory does not exist.' }
  }
  $result = [ordered]@{ stage = $Stage; status = $(if ($problems.Count) { 'BLOCKED' } else { 'CHECKS_OK_NOT_ACCEPTED' }); utc = $now; identity = $identity; primarySid = $PrimarySid; installDirectory = $install; dataDirectory = $dataDir; resources = $resources; appProcess = $running; observedEngineHome = $enginePath; problems = $problems; note = 'This verifies package resources and SID-derived path only. It does not prove login, model inference, or restored task state.' }
  Write-Result 'verify' $result
  if ($problems.Count) { exit 2 }
  exit 0
}

if ($Stage -eq 'RestartVerify') {
  $before = Read-Result 'verify'
  $launched = Read-Result 'launch'
  $problems = @()
  if ($before.status -ne 'CHECKS_OK_NOT_ACCEPTED' -or $before.identity.sid -ne $identity.sid -or $before.installDirectory -ne $install) { $problems += 'Verify baseline does not match this account and installation.' }
  if ($launched.sid -ne $identity.sid -or $launched.dataDirectory -ne $dataDir -or [datetime]$launched.utc -le [datetime]$before.utc) { $problems += 'Launch was not repeated after the Verify baseline with this SID-derived data directory.' }
  $running = Installed-Process $install $identity.sid $identity.sessionId
  if ($null -eq $running) { $problems += 'Installed app is not running after restart.' }
  elseif ($running.id -eq $before.appProcess.id -and $running.started -eq $before.appProcess.started) { $problems += 'Same ForgeDesk process is still running; application restart was not observed.' }
  foreach ($relative in $expectedResourceHashes.Keys) {
    $file = Join-Path $install $relative
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expectedResourceHashes[$relative]) { $problems += "Resource changed after restart: $relative" }
  }
  $result = [ordered]@{ stage = $Stage; status = $(if ($problems.Count) { 'BLOCKED' } else { 'CHECKS_OK_NOT_ACCEPTED' }); utc = $now; sid = $identity.sid; beforeProcess = $before.appProcess; afterProcess = $running; observedEngineHome = $before.observedEngineHome; problems = $problems; note = 'App process restart and resources only. A human must confirm the same task and evidence in the UI; this file cannot grant T3 acceptance.' }
  Write-Result 'restart-verify' $result
  if ($problems.Count) { exit 2 }
}
