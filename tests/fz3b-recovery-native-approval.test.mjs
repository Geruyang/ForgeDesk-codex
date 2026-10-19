import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'scripts/fz3b-recovery-native-approval.ps1');
const text = fs.readFileSync(source, 'utf8');
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote = value => `'${value.replaceAll("'", "''")}'`;
const parser = `
$file = ${quote(source)}
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
`;
function pure(body) {
  const selected = ['Require-Condition', 'Get-BytesSha256', 'Assert-ExactProperties', 'Get-PlainProjectFile', 'Read-CheckedProjectBytes', 'Write-ExclusiveJson', 'Assert-FrozenPlan', 'Test-NativeApprovalState'];
  const code = `${parser}
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$selected = @(${selected.map(quote).join(',')})
foreach ($node in $ast.EndBlock.Statements) {
  if ($node -is [Management.Automation.Language.FunctionDefinitionAst] -and $selected -contains $node.Name) {
    . ([scriptblock]::Create($node.Extent.Text))
  }
}
$ProjectRoot = ${quote(root)}
$FixedBoot = '5ceb45a3-8903-4efc-9484-ec75c17280df'
$FixedApp = '/root/fz3b-vision-console-20261009-001'
function Expect-Rejection([scriptblock] $Body) {
  $rejected = $false
  try { & $Body } catch { $rejected = $true }
  if (-not $rejected) { throw 'Expected fail-closed rejection' }
}
${body}
`;
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', code], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  }).trim();
}

const fixture = `
$plan = [pscustomobject]@{
 schemaVersion=1; method='fz3b-active-recovery-maintenance-v1'
 runId='active-recovery-01234567-89ab-4cde-8fab-0123456789ab'
 action='upload-cancel'; jobId='fd-recovery-0123456789ab4cde8fab0123456789ab'
 bootId=$FixedBoot; appRoot=$FixedApp; endpoint=[pscustomobject]@{host='127.0.0.1';port=8765}
 fixture=[pscustomobject]@{imageCount=1}; sourcePins=[pscustomobject]@{fixtureOnly='not-a-real-plan-pin'}
 baseline=[pscustomobject]@{fixtureOnly=$true}; nativeApprovalRequired=$true
 automaticRetry=$false; changesPL=$false; executionEnabled=$true; blocker=$null
}
$spec=[pscustomobject]@{runId=$plan.runId;action=$plan.action;jobId=$plan.jobId}
`;

test('PowerShell parses without executing top level, UI or approval generation', () => {
  const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `${parser} 'PARSE_ONLY_OK'`], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000,
  }).trim();
  assert.equal(result, 'PARSE_ONLY_OK');
  assert.match(text, /\$ApprovedPlans = @\(\)/, 'Phase 1 must have no executable plan allowlist');
});

test('pure plan target/action/one-image/disabled gates reject changes and boolean coercion', () => {
  assert.equal(pure(`${fixture}
Assert-FrozenPlan $plan $spec
foreach ($key in @('bootId','appRoot','runId','action','jobId')) {
 $old=$plan.$key; $plan.$key='foreign'; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.$key=$old
}
$plan.schemaVersion=$true; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.schemaVersion=1
$plan.endpoint.port=$true; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.endpoint.port=8765
$plan.endpoint.host='169.254.220.254'; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.endpoint.host='127.0.0.1'
$plan.fixture.imageCount=2; Expect-Rejection {Assert-FrozenPlan $plan $spec}
$plan.fixture.imageCount=$true; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.fixture.imageCount=1
foreach($key in @('nativeApprovalRequired','automaticRetry','changesPL')) {
 $old=$plan.$key; $plan.$key= -not $old; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.$key=$old
}
$plan.executionEnabled=$false; $plan.blocker='STRICT_FINALIZATION_NOT_IMPLEMENTED'; Expect-Rejection {Assert-FrozenPlan $plan $spec}
$plan.executionEnabled=$true; Expect-Rejection {Assert-FrozenPlan $plan $spec}; $plan.blocker=$null
Assert-FrozenPlan $plan $spec
'PURE_NEGATIVE_PLAN_OK'
`), 'PURE_NEGATIVE_PLAN_OK');
});

test('pure path and JSON shape checks refuse arbitrary or extra inputs', () => {
  assert.equal(pure(`
Assert-ExactProperties ([pscustomobject]@{x=1;y=2}) @('x','y')
Expect-Rejection {Assert-ExactProperties ([pscustomobject]@{x=1;y=2;extra=$true}) @('x','y')}
Expect-Rejection {Assert-ExactProperties ([pscustomobject]@{x=1}) @('x','y')}
foreach($name in @('../private','C:/private','scripts/../package.json','scripts\\private','scripts//private','scripts/a:b')) {
 Expect-Rejection {Get-PlainProjectFile $name}
}
$bytes=Read-CheckedProjectBytes 'scripts/fz3b-recovery-native-approval.ps1' 131072
if ((Get-BytesSha256 $bytes) -notmatch '^[a-f0-9]{64}$') {throw 'hash contract'}
'PURE_PATH_OK'
`), 'PURE_PATH_OK');
});

test('exclusive sentinel storage refuses overwrite; it does not create an approval receipt', () => {
  assert.equal(pure(`
$parent=Join-Path $ProjectRoot 'output/qa/2026-10-17-fz3b-recovery/native-pure-tests'
[void][IO.Directory]::CreateDirectory($parent)
$directory=Join-Path $parent ([Guid]::NewGuid().ToString('D'))
[void][IO.Directory]::CreateDirectory($directory)
$file=Join-Path $directory 'fixture-sentinel.json'
$one=Write-ExclusiveJson $file ([pscustomobject]@{fixtureOnly=$true;value='first'})
Expect-Rejection {Write-ExclusiveJson $file ([pscustomobject]@{fixtureOnly=$true;value='overwrite'})}
$raw=[IO.File]::ReadAllBytes($file)
if ((Get-BytesSha256 $raw) -cne $one) {throw 'sentinel changed'}
$value=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
if ($value.value -cne 'first') {throw 'prior evidence overwritten'}
'PURE_EXCLUSIVE_OK'
`), 'PURE_EXCLUSIVE_OK');
});

test('pure time/UI-state predicate refuses expired, unacknowledged and non-click decisions', () => {
  assert.equal(pure(`
$issued=[DateTimeOffset]::Parse('2026-10-17T00:00:00.0000000+00:00')
$expires=$issued.AddSeconds(300)
$state=[pscustomobject]@{decision='approve';dialogShown=$true;acknowledged=$true;buttonClickObserved=$true;windowHandle='123'}
if (-not (Test-NativeApprovalState $state $issued $expires $issued.AddSeconds(1))) {throw 'synthetic positive predicate'}
foreach($time in @($issued.AddTicks(-1),$expires,$expires.AddTicks(1))) {
 if (Test-NativeApprovalState $state $issued $expires $time) {throw 'invalid decision time allowed'}
}
if (Test-NativeApprovalState $state $issued $issued.AddSeconds(301) $issued.AddSeconds(1)) {throw 'TTL extension allowed'}
foreach($key in @('dialogShown','acknowledged','buttonClickObserved')) {
 $state.$key=$false
 if (Test-NativeApprovalState $state $issued $expires $issued.AddSeconds(1)) {throw 'missing native fact allowed'}
 $state.$key='true'
 if (Test-NativeApprovalState $state $issued $expires $issued.AddSeconds(1)) {throw 'boolean coercion allowed'}
 $state.$key=$true
}
foreach($decision in @('cancel','expired','APPROVE')) {
 $state.decision=$decision
 if (Test-NativeApprovalState $state $issued $expires $issued.AddSeconds(1)) {throw 'nonapproval allowed'}
}
$state.decision='approve'
foreach($handle in @('0','-1','123junk')) {
 $state.windowHandle=$handle
 if (Test-NativeApprovalState $state $issued $expires $issued.AddSeconds(1)) {throw 'invalid window handle allowed'}
}
'PURE_TIME_STATE_OK'
`), 'PURE_TIME_STATE_OK');
});

test('native consent is only reachable through actual WinForms and default cancellation', () => {
  assert.match(text, /\[ValidateSet\('upload-cancel', 'tcp-close'\)\]/);
  assert.doesNotMatch(text, /\[switch\]|\$env:.*APPROV|Read-Host|SendKeys|UIAutomation|ProcessStartInfo|Start-Process|Invoke-Expression|\bssh(?:\.exe)?\b/);
  assert.match(text, /\$ack\.Checked = \$false/);
  assert.match(text, /\$approve\.Enabled = \$false/);
  assert.match(text, /\$form\.AcceptButton = \$cancel/);
  assert.match(text, /\$form\.CancelButton = \$cancel/);
  assert.match(text, /\$form\.ShowDialog\(\)/);
  assert.match(text, /\$form\.Add_Shown\(/);
  assert.match(text, /\$approve\.Add_Click\(/);
  assert.match(text, /\$TtlSeconds = 300/);
  assert.match(text, /\$expires = \$issued\.AddSeconds\(\$TtlSeconds\)/);
  assert.match(text, /\$watch\.Elapsed\.TotalSeconds -ge 300/);
  assert.match(text, /\[IO\.FileMode\]::CreateNew/);
  assert.match(text, /\$intentSha = Write-ExclusiveJson \$intentFile \$binding/);
  assert.match(text, /\$receiptSha = Write-ExclusiveJson \$receiptFile \$receipt/);
  assert.match(text, /\$approved = Test-NativeApprovalState \$state \$issued \$expires \$decided/);
  assert.match(text, /\$ApprovalPurpose = 'independent-native-qa-not-product-grant'/);
  assert.match(text, /Assert-FrozenPlan \$plan \$spec[\s\S]*\$intentSha = Write-ExclusiveJson[\s\S]*\$state = Show-RecoveryApproval/);
});
