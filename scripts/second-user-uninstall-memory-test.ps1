param()

$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
$secondSid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$installDir = Join-Path $projectRoot "output\second-user\$secondSid\install"
$dataDir = Join-Path $projectRoot ".runtime\second-user\$secondSid\data"
$appExe = Join-Path $installDir 'ForgeDesk.exe'
$evidenceRoot = Join-Path $projectRoot "output\second-user\$secondSid\evidence"
$remainingRoot = Join-Path $evidenceRoot 'remaining'
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'second-user-remaining.ps1'), [ref]$null, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in @('Resolve-FileSystemPath', 'Assert-PlainProjectPath', 'Identity-Problems')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw "Missing policy function $name" }
  Invoke-Expression $function.Extent.Text
}
function Branch-WithoutExit([string]$name) {
  $condition = '$Stage -eq ''' + $name + ''''
  $branch = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq $condition }, $true)
  if (-not $branch) { throw "Missing real $name branch" }
  $text = $branch.Extent.Text
  foreach ($node in @($branch.FindAll({ param($item) $item -is [Management.Automation.Language.ExitStatementAst] }, $true) | Sort-Object { $_.Extent.StartOffset } -Descending)) {
    if ($node.Extent.Text -notmatch '^exit\s+([02])$') { throw 'Unsupported exit; branch was not evaluated' }
    $text = $text.Remove($node.Extent.StartOffset - $branch.Extent.StartOffset, $node.Extent.Text.Length).Insert($node.Extent.StartOffset - $branch.Extent.StartOffset, "throw 'QA_MEMORY_EXIT:$($Matches[1])'")
  }
  return $text
}
$uninstallBranch = Branch-WithoutExit 'Uninstall'
$verifyBranch = Branch-WithoutExit 'VerifyUninstall'

function Fixture {
  $identity = @{ sid = $secondSid; account = 'MEMORY\ForgeDeskTest'; usersGroupMember = $true; administratorsGroupMember = $false; elevated = $false; interactive = $true; sessionId = 2; sameSidDesktopExplorer = $true }
  $baseline = [ordered]@{}
  foreach ($name in @('preflight', 'install', 'launch')) { $baseline[$name] = @{ path = (Join-Path $evidenceRoot "$name.json"); sha256 = ('A' * 64) } }
  return @{ identity = $identity; confirm = $true; confirmVerify = $false; app = $true; install = $true; data = $true; evidence = $true; uninstaller = $true; running = $false; reparse = ''; changedHash = $false; latest = $true; missingBaseline = ''
    before = [ordered]@{ stage = 'Uninstall'; status = 'UNINSTALLER_EXIT_ZERO_NOT_ACCEPTED'; releaseVersion = '0.2.1'; identity = $identity.Clone(); installation = $installDir
      uninstaller = (Join-Path $installDir 'Uninstall ForgeDesk.exe'); exitCode = 0; explicitConfirmation = $true; executablePresentBefore = $true; dataDirectoryPresentBefore = $true; baselineEvidence = $baseline } }
}
function Invoke-MemoryStage([string]$name, [hashtable]$fixture) {
  $Stage = $name; $ConfirmUninstall = [Management.Automation.SwitchParameter]$(if ($name -eq 'Uninstall') { $fixture.confirm } else { $fixture.confirmVerify }); $identity = $fixture.identity
  $latestPath = Join-Path $remainingRoot 'uninstall-action-memory.json'
  $observation = [ordered]@{ stage = $Stage; releaseVersion = '0.2.1'; identity = $identity; installation = $installDir }
  $state = @{ starts = 0; reads = 0; observations = (New-Object 'System.Collections.Generic.List[object]'); error = ''; exitCode = $null }
  function Test-Path { param($LiteralPath, $PathType)
    if ($LiteralPath -eq $fixture.missingBaseline) { return $false }
    if ($LiteralPath -eq $appExe) { return $fixture.app }
    if ($LiteralPath -eq $installDir) { return $fixture.install }
    if ($LiteralPath -eq $dataDir) { return $fixture.data }
    if ($LiteralPath -eq $evidenceRoot) { return $fixture.evidence }
    if ($LiteralPath -eq (Join-Path $installDir 'Uninstall ForgeDesk.exe')) { return $fixture.uninstaller }
    return $true
  }
  function Get-Item { param($LiteralPath, [switch]$Force) return @{ Attributes = $(if ($LiteralPath -eq $fixture.reparse) { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]0 }) } }
  function Owned-AppRunning { return $fixture.running }
  function Start-Process { param($FilePath, [switch]$Wait, [switch]$PassThru)
    if ($FilePath -ne (Join-Path $installDir 'Uninstall ForgeDesk.exe')) { throw 'Unapproved mocked uninstaller path' }
    $state.starts++; return @{ ExitCode = 0 }
  }
  function Get-FileHash { param($LiteralPath, $Algorithm)
    if ($LiteralPath -notin @((Join-Path $evidenceRoot 'preflight.json'), (Join-Path $evidenceRoot 'install.json'), (Join-Path $evidenceRoot 'launch.json'))) { throw 'Unexpected mocked hash request' }
    return @{ Hash = $(if ($fixture.changedHash) { 'B' * 64 } else { 'A' * 64 }) }
  }
  function Get-ChildItem { param($LiteralPath, [switch]$File, $Filter)
    if ($LiteralPath -ne $remainingRoot -or $Filter -ne 'uninstall-action-*.json') { throw 'Unexpected mocked directory query' }
    if ($fixture.latest) { return @{ Name = 'uninstall-action-memory.json'; FullName = $latestPath } }
  }
  function Get-Content { param($LiteralPath, [switch]$Raw)
    $state.reads++; if ($LiteralPath -ne $latestPath) { throw 'Unexpected mocked content read' }
    return ($fixture.before | ConvertTo-Json -Depth 10)
  }
  function Write-Observation { param($name, $value) $state.observations.Add(($value | ConvertTo-Json -Depth 10 | ConvertFrom-Json)); return (Join-Path $remainingRoot 'uninstall-action-memory.json') }
  try {
    if (@(Identity-Problems $identity).Count) { throw 'Memory identity gate blocked' }
    $guardConditions = @('$ConfirmUninstall -and $Stage -ne ''Uninstall''', '$Stage -eq ''Uninstall'' -and -not $ConfirmUninstall')
    $guards = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -in $guardConditions })
    if ($guards.Count -ne 2) { throw 'Missing exact top-level confirmation guards' }
    foreach ($guard in $guards) { Invoke-Expression $guard.Extent.Text }
    Invoke-Expression $(if ($name -eq 'Uninstall') { $uninstallBranch } else { $verifyBranch })
  } catch {
    if ($_.Exception.Message -match '^QA_MEMORY_EXIT:([02])$') { $state.exitCode = [int]$Matches[1] }
    else { $state.error = $_.Exception.Message }
  }
  return $state
}
$checks = New-Object 'System.Collections.Generic.List[string]'
function Check([bool]$condition, [string]$label) { if (-not $condition) { throw "Uninstall memory gate regression failed: $label" }; $checks.Add($label) }

$missing = Fixture; $missing.app = $false
$result = Invoke-MemoryStage 'Uninstall' $missing
Check ($result.starts -eq 0 -and $result.error) 'A residual uninstaller without the installed app must not start or count as an uninstall'

$result = Invoke-MemoryStage 'Uninstall' (Fixture)
Check ($result.starts -eq 1 -and $result.exitCode -eq 0 -and $result.observations.Count -eq 2) 'Valid synthetic install makes exactly one mocked uninstall attempt'
$completed = $result.observations[1]
Check ($completed.explicitConfirmation -eq $true -and $completed.executablePresentBefore -eq $true -and $completed.dataDirectoryPresentBefore -eq $true) 'Action records explicit confirmation and the two required pre-existing paths'
foreach ($field in @('app', 'install', 'data', 'uninstaller', 'confirm')) {
  $case = Fixture; $case[$field] = $false; $result = Invoke-MemoryStage 'Uninstall' $case
  Check ($result.starts -eq 0 -and $result.observations.Count -eq 0 -and $result.error) ("Uninstall blocks missing prerequisite: $field")
}
$case = Fixture; $case.running = $true; $result = Invoke-MemoryStage 'Uninstall' $case
Check ($result.starts -eq 0 -and $result.error) 'Uninstall refuses a still-running scoped app'
foreach ($path in @($installDir, $appExe, $dataDir, (Join-Path $installDir 'Uninstall ForgeDesk.exe'))) {
  $case = Fixture; $case.reparse = $path; $result = Invoke-MemoryStage 'Uninstall' $case
  Check ($result.starts -eq 0 -and $result.error -match 'Reparse') ("Uninstall refuses a reparse prerequisite: $path")
}
foreach ($change in @(@{ field = 'sid'; value = $primarySid }, @{ field = 'sid'; value = ($secondSid -replace '1006$', '9999') }, @{ field = 'elevated'; value = $true },
  @{ field = 'administratorsGroupMember'; value = $true }, @{ field = 'usersGroupMember'; value = $false }, @{ field = 'sameSidDesktopExplorer'; value = $false },
  @{ field = 'interactive'; value = $false }, @{ field = 'sessionId'; value = 0 }, @{ field = 'account'; value = 'MEMORY\CodexSandboxOffline' })) {
  $case = Fixture; $case.identity[$change.field] = $change.value
  foreach ($stage in @('Uninstall', 'VerifyUninstall')) {
    $result = Invoke-MemoryStage $stage $case
    Check ($result.starts -eq 0 -and $result.reads -eq 0 -and $result.error) ("$stage refuses current identity before action/read: $($change.field)")
  }
}

$case = Fixture; $case.app = $false; $result = Invoke-MemoryStage 'VerifyUninstall' $case
Check ($result.starts -eq 0 -and $result.reads -eq 1 -and -not $result.error -and $result.observations[0].status -eq 'SCOPED_UNINSTALL_VERIFIED') 'Valid recorded action plus removed exe and preserved directories/public hashes verifies without any process start'
$result = Invoke-MemoryStage 'VerifyUninstall' (Fixture)
Check ($result.observations[0].status -eq 'UNINSTALL_RETENTION_CHECK_FAILED') 'An executable still present cannot pass uninstall verification'
foreach ($path in @($remainingRoot, $installDir, $dataDir)) {
  $case = Fixture; $case.app = $false; $case.reparse = $path; $result = Invoke-MemoryStage 'VerifyUninstall' $case
  Check ($result.error -match 'Reparse' -and $result.starts -eq 0 -and $result.observations.Count -eq 0) ("Verify rejects scoped reparse path: $path")
}
foreach ($field in @('exitCode', 'explicitConfirmation', 'executablePresentBefore', 'dataDirectoryPresentBefore')) {
  $case = Fixture; $case.app = $false; $case.before.Remove($field); $result = Invoke-MemoryStage 'VerifyUninstall' $case
  Check ($result.starts -eq 0 -and $result.error -and $result.observations.Count -eq 0) ("Verify rejects missing required action field: $field")
}
foreach ($change in @(@{ field = 'exitCode'; value = 1 }, @{ field = 'exitCode'; value = '0' }, @{ field = 'exitCode'; value = $false },
  @{ field = 'uninstaller'; value = (Join-Path $projectRoot 'install\Uninstall ForgeDesk.exe') }, @{ field = 'releaseVersion'; value = '0.2.0' },
  @{ field = 'status'; value = 'UNINSTALL_REQUESTED_EXPLICITLY' }, @{ field = 'installation'; value = (Join-Path $projectRoot 'install') },
  @{ field = 'explicitConfirmation'; value = $false }, @{ field = 'explicitConfirmation'; value = 'true' }, @{ field = 'executablePresentBefore'; value = $false },
  @{ field = 'dataDirectoryPresentBefore'; value = $false })) {
  $case = Fixture; $case.app = $false; $case.before[$change.field] = $change.value; $result = Invoke-MemoryStage 'VerifyUninstall' $case
  Check ($result.starts -eq 0 -and $result.error -and $result.observations.Count -eq 0) ("Verify rejects contradictory/wrong-typed action field: $($change.field)=$($change.value)")
}
foreach ($change in @(@{ field = 'sid'; value = $primarySid }, @{ field = 'elevated'; value = $true }, @{ field = 'administratorsGroupMember'; value = $true })) {
  $case = Fixture; $case.app = $false; $case.before.identity[$change.field] = $change.value; $result = Invoke-MemoryStage 'VerifyUninstall' $case
  Check ($result.error -and $result.observations.Count -eq 0) ("Verify refuses previous action identity: $($change.field)")
}
foreach ($field in @('data', 'evidence', 'changedHash', 'latest')) {
  $case = Fixture; $case.app = $false; $case[$field] = $(if ($field -eq 'changedHash') { $true } else { $false }); $result = Invoke-MemoryStage 'VerifyUninstall' $case
  Check ($result.starts -eq 0 -and ($result.error -or $result.observations[0].status -eq 'UNINSTALL_RETENTION_CHECK_FAILED')) ("Verify cannot accept a retention/action failure: $field")
}
$case = Fixture; $case.app = $false; $case.confirmVerify = $true; $result = Invoke-MemoryStage 'VerifyUninstall' $case
Check ($result.error -and $result.reads -eq 0) 'Verify refuses an accidental ConfirmUninstall before any observation read'
$case = Fixture; $case.app = $false; $case.before.baselineEvidence.install.path = (Join-Path $dataDir 'engine\auth.json'); $result = Invoke-MemoryStage 'VerifyUninstall' $case
Check ($result.error -match 'unapproved evidence path' -and $result.reads -eq 1) 'Auth-shaped baseline path is rejected without reading or hashing its target'
$case = Fixture; $case.app = $false; $case.missingBaseline = Join-Path $evidenceRoot 'launch.json'; $result = Invoke-MemoryStage 'VerifyUninstall' $case
Check ($result.observations[0].status -eq 'UNINSTALL_RETENTION_CHECK_FAILED') 'Missing baseline evidence file cannot count as retained'
$case = Fixture; $case.app = $false; $case.before.baselineEvidence.Remove('launch'); $result = Invoke-MemoryStage 'VerifyUninstall' $case
Check ($result.error -and $result.observations.Count -eq 0) 'Fewer than three prior baseline records cannot verify retention'

[ordered]@{ status = 'PURE_UNINSTALL_GATES_PASSED'; checkCount = $checks.Count; checks = $checks.ToArray();
  note = 'Actual source branches with synthetic identity and in-memory filesystem/process/observation mocks only. No account, installed process, uninstaller, private data, authentication, ACL or reboot was accessed or changed.' } | ConvertTo-Json -Depth 6
