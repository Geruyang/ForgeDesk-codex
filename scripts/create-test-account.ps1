param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$accountName = 'ForgeDeskTest'
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
if ($scriptPath -ne (Join-Path $projectRoot 'scripts\create-test-account.ps1')) { throw 'Run the original project helper only.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$usersSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-545'
$adminsSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'
$existing = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
if ($CheckOnly) {
  [pscustomobject]@{ accountName = $accountName; exists = [bool]$existing; elevated = $elevated;
    usersGroupExists = [bool](Get-LocalGroup -SID $usersSid); changesMade = $false } | ConvertTo-Json
  exit 0
}
if (-not $elevated) { throw 'Administrator approval is required to create this standard user.' }
if ($existing) { throw 'ForgeDeskTest already exists. No password or account setting was changed.' }

$reportDirectory = Join-Path $projectRoot 'output\second-user-bootstrap'
function Assert-ReportPath {
  $walk = [IO.Path]::GetPathRoot($reportDirectory)
  foreach ($part in $reportDirectory.Substring($walk.Length).Split('\')) {
    $walk = Join-Path $walk $part
    if ((Test-Path -LiteralPath $walk) -and ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Reparse points are not allowed in the helper output path.'
    }
  }
}
Assert-ReportPath
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$reportPath = Join-Path $reportDirectory ('create-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N') + '.json')
$report = [ordered]@{ schemaVersion = 1; accountName = $accountName; startedAt = (Get-Date).ToUniversalTime().ToString('o');
  status = 'NOT_CREATED'; sid = $null; usersMember = $false; administratorsMember = $false; enabled = $false;
  passwordRecorded = $false; note = 'Account creation only; Windows login and ForgeDesk acceptance are not yet tested.' }
$password = $null
$created = $null
$reportSaved = $false
try {
  Write-Host 'Create local STANDARD account: ForgeDeskTest'
  Write-Host 'No administrator membership, automatic login, or password logging will be configured.'
  Write-Host 'Choose and remember a new test-account password (at least 12 characters).'
  Write-Host 'Do not enter your Microsoft or Codex password. Ctrl+C cancels before creation.'
  $password = Read-Host -Prompt 'New password (hidden)' -AsSecureString
  if ($password.Length -lt 12) { throw 'Password must contain at least 12 characters. No account was created.' }
  if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) { throw 'The account appeared meanwhile; refusing to modify it.' }
  $created = New-LocalUser -Name $accountName -Password $password -Disabled -Description 'ForgeDesk second-user acceptance test' -ErrorAction Stop
  $report.sid = $created.SID.Value
  $report.status = 'CREATED_DISABLED'
  $users = Get-LocalGroup -SID $usersSid
  if (-not (@(Get-LocalGroupMember -Group $users) | Where-Object { $_.SID.Value -eq $created.SID.Value })) {
    Add-LocalGroupMember -Group $users -Member $created -ErrorAction Stop
  }
  $report.usersMember = [bool](@(Get-LocalGroupMember -SID $usersSid) | Where-Object { $_.SID.Value -eq $created.SID.Value })
  $report.administratorsMember = [bool](@(Get-LocalGroupMember -SID $adminsSid) | Where-Object { $_.SID.Value -eq $created.SID.Value })
  if (-not $report.usersMember -or $report.administratorsMember) { throw 'Standard-user membership verification failed; account remains disabled.' }
  Enable-LocalUser -SID $created.SID -ErrorAction Stop
  $report.enabled = (Get-LocalUser -SID $created.SID).Enabled
  if (-not $report.enabled) { throw 'Account enable verification failed.' }
  $report.status = 'CREATED_STANDARD_USER_NOT_ACCEPTED'
} catch {
  $report.errorType = $_.Exception.GetType().FullName
  $report.errorCode = $_.Exception.HResult
  if ($created) {
    try { Disable-LocalUser -SID $created.SID -ErrorAction Stop; $report.enabled = $false; $report.status = 'FAILED_CREATED_ACCOUNT_DISABLED' }
    catch { $report.status = 'FAILED_REQUIRES_ACCOUNT_INSPECTION' }
  } else { $report.status = 'FAILED_NO_ACCOUNT_CREATED' }
  Write-Host ('Creation did not complete: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
  if ($password) { $password.Dispose(); $password = $null }
  $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  try {
    Assert-ReportPath
    $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 5))
    $stream = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $reportSaved = $true
  } catch {
    if ($created) {
      try {
        Disable-LocalUser -SID $created.SID -ErrorAction Stop
        if ((Get-LocalUser -SID $created.SID).Enabled) { throw 'Disable verification failed.' }
        $report.enabled = $false; $report.status = 'FAILED_REPORT_WRITE_ACCOUNT_DISABLED'
      } catch { $report.status = 'FAILED_REQUIRES_ACCOUNT_INSPECTION' }
    } else { $report.status = 'FAILED_NO_ACCOUNT_CREATED' }
    Write-Host 'The creation report could not be saved. Do not continue acceptance.' -ForegroundColor Red
  }
}
Write-Host ('Result: ' + $report.status)
if ($reportSaved) { Write-Host ('Evidence: ' + $reportPath) }
if ($report.status -eq 'CREATED_STANDARD_USER_NOT_ACCEPTED') {
  Write-Host 'Next: switch Windows user to ForgeDeskTest and sign in with the password you just chose.'
  Write-Host 'Then follow output\second-user-kit\SECOND_USER.md in this project.'
}
$null = Read-Host -Prompt 'Press Enter to close this helper'
if ($report.status -ne 'CREATED_STANDARD_USER_NOT_ACCEPTED') { exit 1 }
