param()

$ErrorActionPreference = 'Stop'
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'second-user-acceptance.ps1'), [ref]$null, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
$approvedUpgradeSid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-UpgradeBaselineProblems' }, $true)
if (-not $function) { throw 'Upgrade policy function is missing.' }

# Evaluate only the pure upgrade policy, never the acceptance script entry point.
Invoke-Expression $function.Extent.Text
$installPath = "E:\AiProject\agent-design\ForgeDesk-codex\output\second-user\$approvedUpgradeSid\install"
$dataPath = "E:\AiProject\agent-design\ForgeDesk-codex\.runtime\second-user\$approvedUpgradeSid\data"

function Fixture {
  return @{
    identity = @{ sid = $approvedUpgradeSid; usersGroupMember = $true; administratorsGroupMember = $false; elevated = $false }
    previousInstall = @{ sid = $approvedUpgradeSid; status = 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED'; requestedDirectoryVerified = $true; installDirectory = $installPath; installedExecutable = (Join-Path $installPath 'ForgeDesk.exe') }
    previousLaunch = @{ sid = $approvedUpgradeSid; status = 'LAUNCHED_NOT_ACCEPTED'; dataDirectory = $dataPath; executable = (Join-Path $installPath 'ForgeDesk.exe') }
    installPath = $installPath; dataPath = $dataPath; dataExists = $true; executableExists = $true; appRunning = $false
  }
}

$cases = @(
  @{ name = 'Valid existing standard SID with app closed'; block = $false; change = {} },
  @{ name = 'Primary or other SID'; block = $true; change = { param($f) $f.identity.sid = 'S-1-5-21-1196670755-766692816-2897134863-1002' } },
  @{ name = 'Missing Users membership'; block = $true; change = { param($f) $f.identity.usersGroupMember = $false } },
  @{ name = 'Administrators member even without elevation'; block = $true; change = { param($f) $f.identity.administratorsGroupMember = $true } },
  @{ name = 'Elevated process'; block = $true; change = { param($f) $f.identity.elevated = $true } },
  @{ name = 'Missing existing data'; block = $true; change = { param($f) $f.dataExists = $false } },
  @{ name = 'Missing installed executable'; block = $true; change = { param($f) $f.executableExists = $false } },
  @{ name = 'Missing Install evidence'; block = $true; change = { param($f) $f.previousInstall = $null } },
  @{ name = 'Failed Install evidence'; block = $true; change = { param($f) $f.previousInstall.status = 'BLOCKED' } },
  @{ name = 'Install evidence has another SID'; block = $true; change = { param($f) $f.previousInstall.sid = 'S-1-5-21-1196670755-766692816-2897134863-1002' } },
  @{ name = 'Wrong install directory'; block = $true; change = { param($f) $f.previousInstall.installDirectory = 'E:\outside\install' } },
  @{ name = 'Unverified install directory'; block = $true; change = { param($f) $f.previousInstall.requestedDirectoryVerified = $false } },
  @{ name = 'Wrong installed executable'; block = $true; change = { param($f) $f.previousInstall.installedExecutable = 'E:\outside\ForgeDesk.exe' } },
  @{ name = 'Missing Launch evidence'; block = $true; change = { param($f) $f.previousLaunch = $null } },
  @{ name = 'Failed Launch evidence'; block = $true; change = { param($f) $f.previousLaunch.status = 'BLOCKED' } },
  @{ name = 'Launch evidence has another SID'; block = $true; change = { param($f) $f.previousLaunch.sid = 'S-1-5-21-1196670755-766692816-2897134863-1002' } },
  @{ name = 'Wrong data directory'; block = $true; change = { param($f) $f.previousLaunch.dataDirectory = 'E:\outside\data' } },
  @{ name = 'Wrong launch executable'; block = $true; change = { param($f) $f.previousLaunch.executable = 'E:\outside\ForgeDesk.exe' } },
  @{ name = 'App still running'; block = $true; change = { param($f) $f.appRunning = $true } }
)

$observations = @()
foreach ($case in $cases) {
  $fixture = Fixture
  & $case.change $fixture
  $problems = @(Get-UpgradeBaselineProblems @fixture)
  if (($problems.Count -gt 0) -ne $case.block) { throw "Upgrade policy regression failed: $($case.name)" }
  $observations += @{ name = $case.name; expectedBlocked = $case.block; observedBlocked = ($problems.Count -gt 0) }
}

$directoryGate = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$Upgrade' }, $true)
if (-not $directoryGate) { throw 'First-use directory gate is missing.' }
foreach ($exists in @($true, $false)) {
  & {
    param($exists, $gate)
    function Test-Path { param([string]$LiteralPath, [string]$PathType) return $exists }
    $Upgrade = $false
    $dataDir = 'synthetic-data-directory'
    $problems = @()
    Invoke-Expression $gate.Extent.Text
    if (($problems.Count -gt 0) -ne $exists) { throw 'Original first-use directory policy changed.' }
  } $exists $directoryGate
  $observations += @{ name = "FirstUse dataExists=$exists"; expectedBlocked = $exists; observedBlocked = $exists }
}

$installStage = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$Stage -eq ''Install''' }, $true)
$resourceLoop = $installStage.Find({ param($node) $node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Condition.Extent.Text -eq '$expectedResourceHashes.Keys' }, $true)
$pins = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$expectedResourceHashes' }, $true)
if (-not $resourceLoop -or -not $pins) { throw 'Install resource verification loop is missing.' }
$resourceKeys = @(Invoke-Expression $pins.Right.Extent.Text).Keys
foreach ($mode in @('matching', 'modified', 'missing')) {
  $observed = & {
    param($mode, $keys, $loop)
    $install = 'E:\synthetic-install'
    $expectedResourceHashes = [ordered]@{}
    foreach ($key in $keys) { $expectedResourceHashes[$key] = ('A' * 64) }
    $fixturePath = Join-Path $install $keys[-1]
    function Assert-PlainWorkspacePath { param([string]$path) return $path }
    function Test-Path { param([string]$LiteralPath, [string]$PathType) return -not ($mode -eq 'missing' -and $LiteralPath -eq $fixturePath) }
    function Get-FileHash {
      param([string]$LiteralPath, [string]$Algorithm)
      return @{ Hash = $(if ($mode -eq 'modified' -and $LiteralPath -eq $fixturePath) { 'B' * 64 } else { 'A' * 64 }) }
    }
    $resources = [ordered]@{}
    $problems = @()
    Invoke-Expression $loop.Extent.Text
    return @{ count = $resources.Count; blocked = ($problems.Count -gt 0) }
  } $mode $resourceKeys $resourceLoop
  if ($observed.count -ne 10 -or $observed.blocked -ne ($mode -ne 'matching')) { throw "Install resource check failed: $mode" }
  $observations += @{ name = "All ten Install resources: $mode"; expectedBlocked = ($mode -ne 'matching'); observedBlocked = $observed.blocked }
}

[ordered]@{
  utc = (Get-Date).ToUniversalTime().ToString('o')
  status = 'PURE_UPGRADE_POLICY_REGRESSION_PASSED'
  checkCount = $observations.Count
  observations = $observations
  note = 'Synthetic upgrade records, paths, and mocked filesystem resource hashes only. Tested original FirstUse gate and actual Install verification loop. No account, product data, authentication, process, ACL, installer, or app was accessed or changed.'
} | ConvertTo-Json -Depth 5
