param()

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'second-user-acl.ps1'
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }

# Load pure path/ACL constructors only; never invoke the script or its native DACL writer.
foreach ($name in @('Is-CacheTree', 'Build-Dacl')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw "Missing pure function: $name" }
  Invoke-Expression $function.Extent.Text
}

$sid = 'S-1-5-21-1196670755-766692816-2897134863-1006'
$ownerSid = New-Object Security.Principal.SecurityIdentifier($sid)
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$capabilitySid = New-Object Security.Principal.SecurityIdentifier('S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417')
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$checks = New-Object 'System.Collections.Generic.List[string]'

function Assert-That([bool]$condition, [string]$name) {
  if (-not $condition) { throw "Memory regression failed: $name" }
  $checks.Add($name)
}

function Ace-Bytes([object]$ace) {
  $bytes = New-Object byte[] $ace.BinaryLength
  $ace.GetBinaryForm($bytes, 0)
  return [Convert]::ToBase64String($bytes)
}

foreach ($Scope in @('Primary', 'Second')) {
  $target = if ($Scope -eq 'Primary') { Join-Path $projectRoot '.runtime\app' } else { Join-Path $projectRoot ".runtime\second-user\$sid\data" }
  foreach ($folder in @('Cache', 'Network', 'Shared Dictionary')) {
    $cache = Join-Path $target $folder
    Assert-That (Is-CacheTree $cache) "$Scope recognizes exact $folder"
    Assert-That (Is-CacheTree (Join-Path $cache 'child\nested')) "$Scope recognizes $folder child"
    Assert-That (-not (Is-CacheTree ($cache + '-other'))) "$Scope rejects $folder prefix collision"

    $sddl = "O:${sid}G:BUD:AI(A;;0x1301bf;;;$($capabilitySid.Value))(A;OICIIO;SDGXGWGR;;;$($capabilitySid.Value))(A;ID;FA;;;AU)"
    $original = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
    $entry = @{ path = $cache; directory = $true; originalSddl = $sddl; capabilityRules = @(@{}, @{}) }
    $bytes = Build-Dacl $entry
    $built = New-Object Security.AccessControl.RawAcl($bytes, 0)
    Assert-That ($built.Count -eq 5) "$Scope $folder retains exactly three principals plus two existing capability ACEs"
    for ($index = 0; $index -lt 2; $index++) {
      Assert-That ((Ace-Bytes $original.DiscretionaryAcl[$index]) -eq (Ace-Bytes $built[3 + $index])) "$Scope $folder capability ACE $index byte-for-byte retained"
    }
    Assert-That ($built[0].SecurityIdentifier.Value -eq $sid -and $built[1].SecurityIdentifier.Value -eq $systemSid.Value -and $built[2].SecurityIdentifier.Value -eq $adminSid.Value) "$Scope $folder contains only approved non-capability principals"
  }

  $forbidden = @($target, (Join-Path $target 'engine'), (Join-Path $target 'engine\Cache'), ($target + '-other\Cache'), (Join-Path $projectRoot '.runtime\second-user\S-1-5-21-1196670755-766692816-2897134863-9999\data\Cache'))
  foreach ($path in $forbidden) {
    Assert-That (-not (Is-CacheTree $path)) "$Scope rejects out-of-cache path $path"
    $entry = @{ path = $path; directory = $true; originalSddl = $sddl; capabilityRules = @(@{}, @{}) }
    $rejected = $false
    try { $null = Build-Dacl $entry } catch { $rejected = $_.Exception.Message -eq 'Unexpected raw capability ACE.' }
    Assert-That $rejected "$Scope rejects raw capability ACE outside exact cache trees"
  }

  $plainSddl = "O:${sid}G:BUD:AI(A;ID;FA;;;AU)"
  foreach ($path in @($target, (Join-Path $target 'engine'), (Join-Path $target 'Cache'))) {
    $entry = @{ path = $path; directory = $true; originalSddl = $plainSddl; capabilityRules = @() }
    $bytes = Build-Dacl $entry
    $built = New-Object Security.AccessControl.RawAcl($bytes, 0)
    Assert-That ($built.Count -eq 3) "$Scope does not introduce a capability ACE where absent"
  }
}

[ordered]@{
  utc = (Get-Date).ToUniversalTime().ToString('o')
  status = 'PURE_MEMORY_REGRESSION_PASSED'
  checkCount = $checks.Count
  checks = $checks.ToArray()
  note = 'Synthetic paths and in-memory ACLs only. No actual target data, file security descriptor, account, privilege, app, or installer was read or changed.'
} | ConvertTo-Json -Depth 5
