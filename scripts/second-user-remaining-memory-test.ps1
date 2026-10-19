param()

$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
$secondSid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$installerHash = '9375C0D22D57B9CFABF5BE0DF8E85A3FEC66A17039F511AE97BCC0A6CF4EBBB9'
$installDir = Join-Path $projectRoot "output\second-user\$secondSid\install"
$dataDir = Join-Path $projectRoot ".runtime\second-user\$secondSid\data"
$appExe = Join-Path $installDir 'ForgeDesk.exe'
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'second-user-remaining.ps1'), [ref]$null, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
foreach ($name in @('Resolve-FileSystemPath', 'Identity-Problems', 'Baseline-Problems', 'ManifestPath-Problems', 'Canary-Problems', 'Is-AccessDenied')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw "Missing pure function: $name" }
  Invoke-Expression $function.Extent.Text
}
$checks = New-Object 'System.Collections.Generic.List[string]'
function Check([bool]$condition, [string]$name) {
  if (-not $condition) { throw "Remaining gate regression failed: $name" }
  $checks.Add($name)
}
function Identity-Fixture {
  return @{ sid = $secondSid; account = 'MACHINE\ForgeDeskTest'; usersGroupMember = $true; administratorsGroupMember = $false; elevated = $false; interactive = $true; sessionId = 2; sameSidDesktopExplorer = $true }
}
Check (@(Identity-Problems (Identity-Fixture)).Count -eq 0) 'Standard SID1006 ordinary desktop accepted by pure identity policy'
foreach ($case in @(
  @{ name = 'primary SID'; field = 'sid'; value = $primarySid },
  @{ name = 'other SID'; field = 'sid'; value = 'S-1-5-21-1196670755-766692816-2897134863-9999' },
  @{ name = 'not Users'; field = 'usersGroupMember'; value = $false },
  @{ name = 'Administrators member'; field = 'administratorsGroupMember'; value = $true },
  @{ name = 'elevated'; field = 'elevated'; value = $true },
  @{ name = 'noninteractive'; field = 'interactive'; value = $false },
  @{ name = 'session zero'; field = 'sessionId'; value = 0 },
  @{ name = 'wrong Explorer'; field = 'sameSidDesktopExplorer'; value = $false },
  @{ name = 'platform name'; field = 'account'; value = 'MACHINE\CodexSandboxOffline' }
)) {
  $identity = Identity-Fixture
  $identity[$case.field] = $case.value
  Check (@(Identity-Problems $identity).Count -gt 0) ("Identity rejects " + $case.name)
}

$id = '2ffe87fd0ba9432ea6fc31c1dfd7449d'
$manifestPath = Join-Path $projectRoot "output\second-user-acl\canaries\primary-$id.json"
function Canary-Fixture {
  return @{ schemaVersion = 1; kind = 'PrimaryToSecondReadDenied'; canaryId = $id; ownerSid = $primarySid; readerSid = $secondSid;
    path = (Join-Path $projectRoot ".runtime\app\forgedesk-acl-canary-primary-$id.txt"); secretFreeCanary = $true; sha256 = ('A' * 64);
    linkCount = 1; reparsePoint = $false; aclPrincipalSids = @($primarySid, 'S-1-5-18', 'S-1-5-32-544') }
}
Check (@(ManifestPath-Problems $manifestPath).Count -eq 0) 'Exact public manifest path accepted'
Check (@(Canary-Problems (Canary-Fixture) $manifestPath).Count -eq 0) 'Prepared public marker contract accepted'
foreach ($path in @((Join-Path $projectRoot '.runtime\app\engine\auth.json'), (Join-Path $dataDir 'engine\auth.json'),
  (Join-Path $projectRoot "output\second-user-acl\canaries\nested\primary-$id.json"),
  (Join-Path $projectRoot 'output\second-user-acl\canaries\primary-not-a-guid.json'), 'E:\outside\primary.json')) {
  Check (@(ManifestPath-Problems $path).Count -gt 0) 'Manifest pre-read gate rejects non-public/non-exact input'
}
foreach ($case in @(
  @{ name = 'wrong owner'; field = 'ownerSid'; value = $secondSid },
  @{ name = 'wrong reader'; field = 'readerSid'; value = $primarySid },
  @{ name = 'wrong direction'; field = 'kind'; value = 'SecondToPrimaryReadDenied' },
  @{ name = 'wrong target'; field = 'path'; value = (Join-Path $dataDir 'engine\auth.json') },
  @{ name = 'secret-bearing marker'; field = 'secretFreeCanary'; value = $false },
  @{ name = 'hard link'; field = 'linkCount'; value = 2 },
  @{ name = 'reparse'; field = 'reparsePoint'; value = $true },
  @{ name = 'extra principal'; field = 'aclPrincipalSids'; value = @($primarySid, 'S-1-5-18', 'S-1-5-32-544', $secondSid) },
  @{ name = 'invalid SHA'; field = 'sha256'; value = 'invalid' }
)) {
  $manifest = Canary-Fixture
  $manifest[$case.field] = $case.value
  Check (@(Canary-Problems $manifest $manifestPath).Count -gt 0) ("Canary contract rejects " + $case.name)
}

# Run the actual AclCanary branch with an invalid input and an I/O tripwire.
$aclBranch = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$Stage -eq ''AclCanary''' }, $true)
function Invoke-CanaryReadTripwire {
  param($branch, $path)
  $Stage = 'AclCanary'
  $CanaryManifest = $path
  $script:manifestReadAttempts = 0
  function Get-Content { $script:manifestReadAttempts++; throw 'Unexpected content read' }
  $rejected = $false
  try { Invoke-Expression $branch.Extent.Text } catch { $rejected = $_.Exception.Message -match 'Canary input must|Invalid public canary manifest path' }
  return @{ rejected = $rejected; reads = $script:manifestReadAttempts }
}
$tripwire = Invoke-CanaryReadTripwire $aclBranch (Join-Path $dataDir 'engine\auth.json')
Check ($tripwire.rejected -and $tripwire.reads -eq 0) 'Actual canary branch rejects auth-shaped input before any content read'

# Provider resolution must follow PowerShell's location, not the process working directory.
$originalProcessDirectory = [Environment]::CurrentDirectory
Push-Location -LiteralPath $projectRoot
try {
  [Environment]::CurrentDirectory = $env:SystemRoot
  $relativeManifest = ".\output\second-user-acl\canaries\primary-$id.json"
  Check (-not ([IO.Path]::GetFullPath($relativeManifest)).Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase)) 'Regression fixture reproduces divergent PowerShell and .NET working directories'
  Check ((Resolve-FileSystemPath $relativeManifest).Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase)) 'Relative public manifest canonicalizes against PowerShell project location'
  Check (@(ManifestPath-Problems $relativeManifest).Count -eq 0) 'Relative public manifest passes with divergent process working directory'
  Check (@(Canary-Problems (Canary-Fixture) $relativeManifest).Count -eq 0) 'Relative public manifest matches synthetic contract without reading marker'
  foreach ($path in @('.\.runtime\app\engine\auth.json', ".\.runtime\second-user\$secondSid\data\engine\auth.json",
      ".\output\second-user\primary-$id.json", ".\output\second-user-acl\canaries\nested\primary-$id.json",
      "..\output\second-user-acl\canaries\primary-$id.json", 'Env:\PATH', 'Variable:\projectRoot')) {
    Check (@(ManifestPath-Problems $path).Count -gt 0) ("Divergent-cwd pre-read path policy rejects " + $path)
    $tripwire = Invoke-CanaryReadTripwire $aclBranch $path
    Check ($tripwire.rejected -and $tripwire.reads -eq 0) ("Actual branch rejects before content read: " + $path)
  }
  foreach ($path in @('Env:\PATH', 'Variable:\projectRoot')) {
    $providerRejected = $false
    try { $null = Resolve-FileSystemPath $path } catch { $providerRejected = $true }
    Check $providerRejected ("Resolver rejects non-FileSystem provider: " + $path)
  }
} finally {
  [Environment]::CurrentDirectory = $originalProcessDirectory
  Pop-Location
}

$denied = New-Object UnauthorizedAccessException('denied')
Check (Is-AccessDenied $denied) 'Windows access-denied is recognized'
Check (Is-AccessDenied (New-Object Exception('wrapped', $denied))) 'Wrapped Windows access-denied is recognized'
Check (-not (Is-AccessDenied (New-Object IO.FileNotFoundException('missing')))) 'Not-found cannot count as ACL denial'
Check (-not (Is-AccessDenied (New-Object IO.IOException('sharing or generic I/O')))) 'Generic I/O cannot count as ACL denial'

$filterCommand = $ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-ChildItem' -and $node.Extent.Text -match 'uninstall-action-' }, $true)
$filter = @($filterCommand.CommandElements | Where-Object { $_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.Value -like 'uninstall-action-*' })[0].Value
$reports = @('uninstall-action-20261014T140000000Z-one.json', 'uninstall-action-20261014T140100000Z-two.json', 'uninstall-verify-20261014T150000000Z-three.json')
$selected = $reports | Where-Object { $_ -like $filter } | Sort-Object | Select-Object -Last 1
Check ($selected -eq 'uninstall-action-20261014T140100000Z-two.json') 'Repeated uninstall verification selects only action reports'

# Public stage JSON is allowed; evaluate the pure baseline policy without invoking any real stage.
$publicEvidence = Join-Path $projectRoot "output\second-user\$secondSid\evidence"
$publicPreflight = Get-Content -LiteralPath (Join-Path $publicEvidence 'preflight.json') -Raw | ConvertFrom-Json
$publicInstall = Get-Content -LiteralPath (Join-Path $publicEvidence 'install.json') -Raw | ConvertFrom-Json
$publicLaunch = Get-Content -LiteralPath (Join-Path $publicEvidence 'launch.json') -Raw | ConvertFrom-Json
Check (@(Baseline-Problems $publicPreflight $publicInstall $publicLaunch).Count -eq 0) 'Existing public 0.2.1 baseline passes the pure record policy'
$modified = $publicInstall | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$modified.releaseVersion = '0.2.0'
Check (@(Baseline-Problems $publicPreflight $modified $publicLaunch).Count -gt 0) 'Stale release baseline is rejected'
$modified = $publicInstall | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$modified.resources.PSObject.Properties.Remove('resources\app.asar')
Check (@(Baseline-Problems $publicPreflight $modified $publicLaunch).Count -gt 0) 'Missing public resource observation is rejected'

$uninstallSummary = (& (Join-Path $PSScriptRoot 'second-user-uninstall-memory-test.ps1') | Out-String) | ConvertFrom-Json
Check ($uninstallSummary.status -eq 'PURE_UNINSTALL_GATES_PASSED' -and $uninstallSummary.checkCount -gt 0) 'Independent actual-branch uninstall memory suite passed'
foreach ($name in $uninstallSummary.checks) { $checks.Add('Uninstall: ' + $name) }

[ordered]@{
  utc = (Get-Date).ToUniversalTime().ToString('o'); status = 'PURE_REMAINING_GATES_PASSED'; checkCount = $checks.Count; checks = $checks.ToArray()
  note = 'Pure functions, mocked canary/uninstall/verification branches, and three public stage JSON records only. All action filesystem/process observations are mocked. No canary/data/auth/engine content, account, ACL, installed process, or uninstaller was accessed or changed.'
} | ConvertTo-Json -Depth 6
