#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'build_pl.ps1'
$tokens = $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Build entry has PowerShell syntax errors' }
foreach ($name in @('Assert-Within', 'Assert-NoReparse', 'Sha256', 'Test-FiniteNumber',
                   'Get-SubstTarget', 'Assert-ShortVivadoPath', 'New-StageDrive',
                   'Remove-StageDrive', 'Confirm-Capture', 'Confirm-RoutedReceipt')) {
    $definition = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definition.Count -ne 1) { throw "Missing or duplicate function: $name" }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}

foreach ($value in @([double]::NaN, [double]::PositiveInfinity, [double]::NegativeInfinity, '0', $true, $null)) {
    if (Test-FiniteNumber $value) { throw 'Nonfinite or nonnumeric value accepted' }
}
foreach ($value in @(0, 1.25, [decimal]0.5)) {
    if (-not (Test-FiniteNumber $value)) { throw 'Finite number rejected' }
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$testsRoot = Join-Path $repo 'output/hardware/2026-10-16-continuation/pl-build-preparation/tests'
$runsRoot = Join-Path $repo 'output/hardware/2026-10-16-continuation/pl-build-preparation/runs'
$fixtureRoot = Join-Path $testsRoot ('receipt-' + [guid]::NewGuid().ToString('N'))
$mapStage = Join-Path $runsRoot ('map-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
if (-not (Test-Path -LiteralPath $testsRoot)) { New-Item -ItemType Directory -Path $testsRoot -Force | Out-Null }
$mapping = $null
$blockedDriveOwned = $false
try {
    New-Item -ItemType Directory -Path $mapStage -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $mapStage 'staged-inputs.json'), '{"fixture":true}')
    if (-not (Get-PSDrive -Name V -PSProvider FileSystem -ErrorAction SilentlyContinue) -and
        -not (Get-SubstTarget 'V:')) {
        & subst.exe 'V:' $testsRoot | Out-Null
        if ($LASTEXITCODE -ne 0 -or (Get-SubstTarget 'V:') -cne [IO.Path]::GetFullPath($testsRoot)) {
            throw 'Unable to establish occupied-drive fixture'
        }
        $blockedDriveOwned = $true
    }
    $mapping = New-StageDrive $mapStage $runsRoot
    if ($blockedDriveOwned -and $mapping.drive -ceq 'V:') { throw 'Occupied drive was stolen' }
    $mappedRoot = Assert-ShortVivadoPath $mapping.stage
    if ((Get-SubstTarget $mapping.drive) -cne [IO.Path]::GetFullPath($runsRoot)) { throw 'Subst parent mismatch' }
    if (($mappedRoot + '/project-final-008').Substring($mappedRoot.Length + 1) -cne 'project-final-008' -or
        ($mappedRoot + '/reports').Substring($mappedRoot.Length + 1) -cne 'reports') {
        throw 'Original Tcl receipt arithmetic lost a leading character'
    }
    foreach ($bad in @('V:/', 'V:/../other', 'V:/' + ('a' * 100))) {
        $rejected = $false
        try { Assert-ShortVivadoPath $bad | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw "Unsafe Vivado root accepted: $bad" }
    }
    $fake = [pscustomobject]@{ drive = $mapping.drive; stage = $mapping.stage; parent = $testsRoot }
    $rejected = $false
    try { Remove-StageDrive $fake $mapStage } catch { $rejected = $true }
    if (-not $rejected -or (Get-SubstTarget $mapping.drive) -cne $mapping.parent) {
        throw 'Foreign subst cleanup was not refused'
    }
    Remove-StageDrive $mapping $mapStage
    if (Get-SubstTarget $mapping.drive) { throw 'Owned subst mapping remained after cleanup' }
    $mapping = $null
    if ($blockedDriveOwned) {
        if ((Get-SubstTarget 'V:') -cne [IO.Path]::GetFullPath($testsRoot)) {
            throw 'Pre-existing drive mapping changed'
        }
        & subst.exe 'V:' /D | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unable to remove occupied-drive fixture' }
        $blockedDriveOwned = $false
    }

    $reportDir = Join-Path $fixtureRoot 'reports/platform/project-final-008'
    $captureDir = Join-Path $fixtureRoot 'project-final-008/source_snapshot'
    New-Item -ItemType Directory -Path $reportDir, $captureDir -Force | Out-Null
    $hashes = Join-Path $captureDir 'SHA256SUMS.txt'
    [IO.File]::WriteAllText($hashes, 'fixture-only')
    $roles = @('route_dcp', 'utilization', 'timing', 'route_status', 'check_timing',
               'cdc', 'drc', 'pulse_width', 'signoff', 'build_script')
    $artifacts = @()
    foreach ($role in $roles) {
        $name = if ($role -eq 'signoff') { 'signoff.txt' } else { "$role.txt" }
        $file = Join-Path $reportDir $name
        [IO.File]::WriteAllText($file, $role)
        $artifacts += [ordered]@{
            role = $role
            path = "reports/platform/project-final-008/$name"
            sha256 = Sha256 $file
        }
    }
    $receipt = [ordered]@{
        status = 'ROUTED_SIGNOFF_PASS'; stage = 'post_route'; part = 'xazu3eg-sfvc784-1-i'
        route = [ordered]@{ unrouted_nets = 0; routing_errors = 0 }
        impl_run = [ordered]@{ progress = '100%'; status = 'route_design Complete!'; final_step = 'phys_opt_design (Post-Route)' }
        checks = [ordered]@{ check_timing = $true; cdc = $true; drc = $true; related_clocks = $true; exceptions = $true }
        timing = [ordered]@{ wns_ns = 0.1; tns_ns = 0; whs_ns = 0.1; ths_ns = 0; wpws_ns = 0.1 }
        counts = [ordered]@{ check_timing_issues = 0; drc_errors = 0; drc_critical_warnings = 0; debug_cores = 0; unconstrained_internal_endpoints = 0; unapproved_exceptions = 0 }
        source_snapshot_sha256 = Sha256 $hashes
        artifacts = $artifacts
    }
    $receiptPath = Join-Path $reportDir 'route_receipt.json'
    function Assert-Receipt([bool]$Expected, [string]$Name) {
        [IO.File]::WriteAllText($receiptPath, (ConvertTo-Json -InputObject $receipt -Depth 20))
        $actual = Confirm-RoutedReceipt $fixtureRoot 'xazu3eg-sfvc784-1-i'
        if ($actual -ne $Expected) { throw "Receipt case $Name returned $actual, expected $Expected" }
    }
    Assert-Receipt $true 'baseline fixture'
    foreach ($case in @(
        @{ group = 'timing'; field = 'wns_ns'; value = '0' },
        @{ group = 'timing'; field = 'whs_ns'; value = $true },
        @{ group = 'timing'; field = 'wpws_ns'; value = 'Infinity' },
        @{ group = 'timing'; field = 'tns_ns'; value = '0' },
        @{ group = 'timing'; field = 'ths_ns'; value = $false },
        @{ group = 'counts'; field = 'drc_errors'; value = '0' },
        @{ group = 'counts'; field = 'debug_cores'; value = $true },
        @{ group = 'route'; field = 'unrouted_nets'; value = '0' },
        @{ group = 'route'; field = 'routing_errors'; value = $false }
    )) {
        $before = $receipt[$case.group][$case.field]
        $receipt[$case.group][$case.field] = $case.value
        Assert-Receipt $false "$($case.group).$($case.field)"
        $receipt[$case.group][$case.field] = $before
    }
    $before = $receipt.artifacts[0].path
    $receipt.artifacts[0].path = 'eports/platform/project-final-008/route_dcp.txt'
    Assert-Receipt $false 'missing-leading-letter artifact path'
    $receipt.artifacts[0].path = $before
    $before = $receipt.artifacts[0].sha256
    $receipt.artifacts[0].sha256 = '0' * 64
    Assert-Receipt $false 'artifact hash mismatch'
    $receipt.artifacts[0].sha256 = $before
    $before = $receipt.source_snapshot_sha256
    $receipt.source_snapshot_sha256 = '0' * 64
    Assert-Receipt $false 'snapshot hash mismatch'
    $receipt.source_snapshot_sha256 = $before

    $captureStage = Join-Path $fixtureRoot 'capture-case'
    $snapshot = Join-Path $captureStage 'project-final-008/source_snapshot'
    $entries = @()
    $lines = @()
    foreach ($directory in @('rtl', 'platform', 'constraints')) {
        foreach ($base in @($captureStage, $snapshot)) {
            New-Item -ItemType Directory -Path (Join-Path $base $directory) -Force | Out-Null
        }
        for ($i = 1; $i -le 12; $i++) {
            $relative = "$directory/fixture_$i.sv"
            $source = Join-Path $captureStage $relative
            $captured = Join-Path $snapshot $relative
            [IO.File]::WriteAllText($source, "$directory-$i")
            [IO.File]::WriteAllText($captured, "$directory-$i")
            $hash = Sha256 $source
            $entries += [pscustomobject]@{ path = $relative; sha256 = $hash }
            $lines += "$hash  $relative"
        }
    }
    [IO.File]::WriteAllLines((Join-Path $snapshot 'SHA256SUMS.txt'), $lines)
    if (-not (Confirm-Capture $captureStage $entries)) { throw 'Untampered source capture rejected' }
    [IO.File]::WriteAllText((Join-Path $snapshot 'rtl/fixture_1.sv'), 'tampered')
    if (Confirm-Capture $captureStage $entries) { throw 'Tampered source capture accepted' }
    Write-Output 'FZ3B_RECEIPT_NEGATIVE_TESTS_PASS'
} finally {
    if ($mapping) { Remove-StageDrive $mapping $mapStage }
    if ($blockedDriveOwned -and (Get-SubstTarget 'V:') -ceq [IO.Path]::GetFullPath($testsRoot)) {
        & subst.exe 'V:' /D | Out-Null
    }
    $mapFull = [IO.Path]::GetFullPath($mapStage)
    $runsPrefix = [IO.Path]::GetFullPath($runsRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $mapFull.StartsWith($runsPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Mapping fixture cleanup escaped runs root' }
    if (Test-Path -LiteralPath $mapFull) { Remove-Item -LiteralPath $mapFull -Recurse -Force }
    $target = [IO.Path]::GetFullPath($fixtureRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($testsRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped test root' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
