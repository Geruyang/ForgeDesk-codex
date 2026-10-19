param(
  [Parameter(Mandatory = $true)][ValidateSet('Primary', 'Second')][string]$Scope,
  [switch]$Apply,
  [string]$OriginalDescriptorBackup
)

$ErrorActionPreference = 'Stop'
$projectRoot = 'E:\AiProject\agent-design\ForgeDesk-codex'
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $current.User.Value
$ownerSid = New-Object Security.Principal.SecurityIdentifier($sid)
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$capabilitySid = New-Object Security.Principal.SecurityIdentifier('S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417')
$descriptorParts = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access

if (-not ('ForgeDeskDacl' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ForgeDeskLinkCount {
  [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] private struct FileInfo {
    public uint Attributes; public FileTime Created; public FileTime Accessed; public FileTime Written;
    public uint VolumeSerial; public uint SizeHigh; public uint SizeLow; public uint NumberOfLinks;
    public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  public static uint Count(string path) {
    using (var handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInfo info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return info.NumberOfLinks;
    }
  }
}
public static class ForgeDeskDacl {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  private static extern uint SetNamedSecurityInfo(string name, uint objectType, uint securityInformation,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static void Set(string path, byte[] dacl) {
    var pinned = GCHandle.Alloc(dacl, GCHandleType.Pinned);
    try {
      uint error = SetNamedSecurityInfo(path, 1, 0x80000004U,
        IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero);
      if (error != 0) throw new Win32Exception((int)error);
    } finally { pinned.Free(); }
  }
}
'@
}

if ($Scope -eq 'Primary' -and $sid -ne $primarySid) { throw 'Primary ACL mode requires the primary Windows SID.' }
if ($Scope -eq 'Second' -and ($sid -eq $primarySid -or $current.Name -match '(?i)\\CodexSandbox(Offline|Online)$')) { throw 'Second ACL mode requires a separate human Windows SID.' }

$relative = if ($Scope -eq 'Primary') { '.runtime\app' } else { ".runtime\second-user\$sid\data" }
$target = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
$expected = if ($Scope -eq 'Primary') { Join-Path $projectRoot '.runtime\app' } else { Join-Path $projectRoot ".runtime\second-user\$sid\data" }
if (-not $target.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Target path is not the exact approved product data directory.' }

function Assert-PlainPath([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (-not $full.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes the project root.' }
  $ancestor = [IO.Path]::GetPathRoot($projectRoot).TrimEnd('\')
  foreach ($part in $projectRoot.Substring($ancestor.Length).TrimStart('\').Split('\')) {
    $ancestor = Join-Path $ancestor $part
    $ancestorItem = Get-Item -LiteralPath $ancestor -Force
    if (($ancestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point found at $ancestor" }
  }
  $walk = $projectRoot
  foreach ($part in $full.Substring($projectRoot.Length).TrimStart('\').Split('\')) {
    $walk = Join-Path $walk $part
    if (Test-Path -LiteralPath $walk) {
      $item = Get-Item -LiteralPath $walk -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point found at $walk" }
    }
  }
}

function Walk-Tree([string]$root) {
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $path = $stack.Pop()
    Assert-PlainPath $path
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point found at $path" }
    $item
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)) { $stack.Push($child.FullName) }
    }
  }
}

function Owned-ForgeDeskRunning {
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'ForgeDesk.exe'" -ErrorAction SilentlyContinue)) {
    try {
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid) { return $true }
    } catch { }
  }
  return $false
}

function Is-CacheTree([string]$path) {
  foreach ($folder in @('Cache', 'Network', 'Shared Dictionary')) {
    $base = Join-Path $target $folder
    if ($path.Equals($base, [StringComparison]::OrdinalIgnoreCase) -or
        $path.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Rule-Signature([object]$rule) {
  return "$([int]$rule.FileSystemRights)|$([int]$rule.InheritanceFlags)|$([int]$rule.PropagationFlags)|$($rule.AccessControlType)"
}

function Exact-Dacl([object]$acl, [bool]$directory, [object[]]$capabilityRules) {
  if (-not $acl.AreAccessRulesProtected) { return $false }
  $rules = @($acl.Access)
  if ($rules.Count -ne (3 + $capabilityRules.Count)) { return $false }
  $expectedSids = @($ownerSid.Value, $systemSid.Value, $adminSid.Value)
  $seen = @{}
  $observedCap = @()
  foreach ($rule in $rules) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -eq $capabilitySid.Value) { $observedCap += Rule-Signature $rule; continue }
    if ($ruleSid -notin $expectedSids -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.IsInherited) { return $false }
    $seen[$ruleSid] = 1 + [int]$seen[$ruleSid]
    if ($directory -and $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)) { return $false }
    if (-not $directory -and $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) { return $false }
    if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
  }
  foreach ($expectedSid in $expectedSids) { if ($seen[$expectedSid] -ne 1) { return $false } }
  $expectedCap = @($capabilityRules | ForEach-Object { "$($_.rights)|$($_.inheritance)|$($_.propagation)|Allow" } | Sort-Object)
  $observedCap = @($observedCap | Sort-Object)
  if (($expectedCap -join ';') -ne ($observedCap -join ';')) { return $false }
  return $true
}

function Build-Dacl([object]$entry) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($entry.originalSddl)
  $dacl = New-Object Security.AccessControl.RawAcl(2, (3 + $entry.capabilityRules.Count))
  $flags = if ($entry.directory) { [Security.AccessControl.AceFlags]([int][Security.AccessControl.AceFlags]::ContainerInherit -bor [int][Security.AccessControl.AceFlags]::ObjectInherit) } else { [Security.AccessControl.AceFlags]::None }
  foreach ($principal in @($ownerSid, $systemSid, $adminSid)) {
    $ace = New-Object Security.AccessControl.CommonAce($flags, [Security.AccessControl.AceQualifier]::AccessAllowed, 2032127, $principal, $false, $null)
    $dacl.InsertAce($dacl.Count, $ace)
  }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -is [Security.AccessControl.KnownAce] -and $ace.SecurityIdentifier.Value -eq $capabilitySid.Value) {
      if (-not (Is-CacheTree $entry.path) -or $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { throw 'Unexpected raw capability ACE.' }
      $dacl.InsertAce($dacl.Count, $ace.Copy())
    }
  }
  $bytes = New-Object byte[] $dacl.BinaryLength
  $dacl.GetBinaryForm($bytes, 0)
  return ,$bytes
}

Assert-PlainPath $target
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
  if ($Scope -eq 'Primary' -or -not $Apply) { throw 'Target data directory does not exist. The second user must use -Apply before the first Launch to create it.' }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Assert-PlainPath $target
}

$items = @(Walk-Tree $target)
$entries = New-Object 'System.Collections.Generic.List[object]'
$foreignOwners = New-Object 'System.Collections.Generic.List[string]'
$multiLinkFiles = New-Object 'System.Collections.Generic.List[string]'
$explicitIdentities = @{}
foreach ($item in $items) {
  $links = if ($item.PSIsContainer) { $null } else { [ForgeDeskLinkCount]::Count($item.FullName) }
  if ($null -ne $links -and $links -ne 1) { $multiLinkFiles.Add($item.FullName) }
  $acl = Get-Acl -LiteralPath $item.FullName
  $itemOwner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($itemOwner -ne $sid) { $foreignOwners.Add($item.FullName) }
  foreach ($rule in @($acl.Access)) {
    if (-not $rule.IsInherited) {
      $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      $explicitIdentities[$ruleSid] = 1 + [int]$explicitIdentities[$ruleSid]
    }
  }
  $capabilityRules = @()
  foreach ($rule in @($acl.Access)) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -eq $capabilitySid.Value) {
      if (-not (Is-CacheTree $item.FullName) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Unexpected capability ACE outside the three approved cache trees.' }
      $capabilityRules += [ordered]@{ rights = [int]$rule.FileSystemRights; inheritance = [int]$rule.InheritanceFlags; propagation = [int]$rule.PropagationFlags }
    }
  }
  $entries.Add([ordered]@{
    path = $item.FullName
    directory = [bool]$item.PSIsContainer
    ownerSid = $itemOwner
    linkCount = $links
    originalSddl = $acl.GetSecurityDescriptorSddlForm($descriptorParts)
    capabilityRules = $capabilityRules
  })
}

$auditRoot = Join-Path $projectRoot 'output\second-user-acl'
Assert-PlainPath $auditRoot
New-Item -ItemType Directory -Path $auditRoot -Force | Out-Null
Assert-PlainPath $auditRoot
if ($OriginalDescriptorBackup) {
  $originalPath = [IO.Path]::GetFullPath($OriginalDescriptorBackup)
  if (-not $originalPath.StartsWith($auditRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $originalPath -PathType Leaf)) { throw 'Original descriptor backup must be an existing file in the project ACL audit directory.' }
  $originalReport = Get-Content -LiteralPath $originalPath -Raw | ConvertFrom-Json
  if ($originalReport.scope -ne $Scope -or $originalReport.executingSid -ne $sid -or $originalReport.target -ne $target -or
      $originalReport.descriptors.Count -ne $entries.Count) { throw 'Original descriptor backup does not match this target and SID.' }
  $originalByPath = @{}
  foreach ($originalEntry in $originalReport.descriptors) { $originalByPath[$originalEntry.path] = $originalEntry }
  foreach ($entry in $entries) {
    $originalEntry = $originalByPath[$entry.path]
    if (-not $originalEntry -or $originalEntry.ownerSid -ne $sid -or $originalEntry.directory -ne $entry.directory) { throw 'Original descriptor backup path or owner mismatch.' }
    $originalCap = @($originalEntry.capabilityRules | ForEach-Object { "$($_.rights)|$($_.inheritance)|$($_.propagation)|Allow" } | Sort-Object)
    $currentCap = @($entry.capabilityRules | ForEach-Object { "$($_.rights)|$($_.inheritance)|$($_.propagation)|Allow" } | Sort-Object)
    if (($originalCap -join ';') -ne ($currentCap -join ';')) { throw 'Capability permissions differ from the original descriptor backup.' }
  }
} else { $originalPath = $null }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backupPath = Join-Path $auditRoot "$($Scope.ToLowerInvariant())-$sid-$stamp-original-dacl.json"
$audit = [ordered]@{
  scope = $Scope; mode = $(if ($Apply) { 'Apply' } else { 'Audit' }); utc = (Get-Date).ToUniversalTime().ToString('o')
  target = $target; executingSid = $sid; itemCount = $entries.Count
  foreignOwnerCount = $foreignOwners.Count; foreignOwnerPaths = $foreignOwners.ToArray()
  multiLinkFileCount = $multiLinkFiles.Count; multiLinkFilePaths = $multiLinkFiles.ToArray()
  explicitIdentityCounts = $explicitIdentities
  descriptors = $entries.ToArray()
  note = 'Owner, group, and DACL SDDL only; file contents and SACL were not read.'
}
$audit | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $backupPath -Encoding UTF8
Write-Host "Original descriptors: $backupPath ($($entries.Count) entries)"

if (-not $Apply) { Write-Host 'Audit only: no ACL was changed.'; exit 0 }
if ($foreignOwners.Count -gt 0) { throw 'A target child has a foreign owner. No ACL was changed; inspect the backup report.' }
if ($multiLinkFiles.Count -gt 0) { throw 'A target file has multiple hard links. No further ACL was changed; inspect the backup report.' }
if (Owned-ForgeDeskRunning) { throw 'ForgeDesk.exe is still running under this SID. Close it before applying ACLs.' }

$changed = 0
$alreadyExact = 0
$fullyVerified = 0
$failure = $null
foreach ($entry in @($entries | Sort-Object { $_.path.Length } -Descending)) {
  try {
    Assert-PlainPath $entry.path
    $acl = Get-Acl -LiteralPath $entry.path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Owner changed since audit.' }
    if (-not $entry.directory -and [ForgeDeskLinkCount]::Count($entry.path) -ne 1) { throw 'Hard link count changed since audit.' }
    if (Exact-Dacl $acl $entry.directory $entry.capabilityRules) { $alreadyExact++; continue }
    $existingCap = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $capabilitySid.Value } | ForEach-Object { Rule-Signature $_ } | Sort-Object)
    $expectedCap = @($entry.capabilityRules | ForEach-Object { "$($_.rights)|$($_.inheritance)|$($_.propagation)|Allow" } | Sort-Object)
    if (($existingCap -join ';') -ne ($expectedCap -join ';')) { throw 'Capability ACE changed since audit.' }
    $groupBefore = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
    [ForgeDeskDacl]::Set($entry.path, (Build-Dacl $entry))
    $after = Get-Acl -LiteralPath $entry.path
    if ($after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $entry.ownerSid -or $after.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $groupBefore -or -not (Exact-Dacl $after $entry.directory $entry.capabilityRules)) { throw 'Post-write owner, group, or DACL verification failed.' }
    $changed++
  } catch {
    $failure = "Path $($entry.path) failed after $changed writes: $($_.Exception.Message)"
    break
  }
}

if (-not $failure) {
  try {
    $finalItems = @(Walk-Tree $target)
    if ($finalItems.Count -ne $entries.Count) { throw 'Target tree changed during ACL application.' }
    $byPath = @{}
    foreach ($entry in $entries) { $byPath[$entry.path] = $entry }
    foreach ($item in $finalItems) {
      $entry = $byPath[$item.FullName]
      if (-not $entry) { throw 'Unexpected new path during final verification.' }
      if (-not $item.PSIsContainer -and [ForgeDeskLinkCount]::Count($item.FullName) -ne 1) { throw 'Final hard link verification failed.' }
      $after = Get-Acl -LiteralPath $item.FullName
      $before = New-Object Security.AccessControl.RawSecurityDescriptor($entry.originalSddl)
      if ($after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $entry.ownerSid -or $after.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $before.Group.Value -or -not (Exact-Dacl $after $entry.directory $entry.capabilityRules)) { throw "Final ACL verification failed: $($item.FullName)" }
      $fullyVerified++
    }
  } catch { $failure = $_.Exception.Message }
}

$resultPath = Join-Path $auditRoot "$($Scope.ToLowerInvariant())-$sid-$stamp-result.json"
$result = [ordered]@{
  scope = $Scope; target = $target; sid = $sid; utc = (Get-Date).ToUniversalTime().ToString('o')
  status = $(if ($failure) { 'PARTIAL_OR_FAILED' } else { 'APPLIED_AND_VERIFIED' })
  itemCount = $entries.Count; changedAndVerified = $changed; failure = $failure
  alreadyExact = $alreadyExact; fullyVerified = $fullyVerified
  originalDescriptors = $(if ($originalPath) { $originalPath } else { $backupPath })
  originalDescriptorsSha256 = (Get-FileHash -LiteralPath $(if ($originalPath) { $originalPath } else { $backupPath }) -Algorithm SHA256).Hash
  preRunDescriptors = $backupPath
  note = 'Native DACL-only write with protected inheritance; no owner, group, SACL, or privilege adjustment requested. Owner/group reverified on every path. Capability ACE masks and propagation retained only where present in the three approved cache trees. No automatic rollback attempted.'
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host "$($result.status): $changed / $($entries.Count); $resultPath"
if ($failure) { throw $failure }
