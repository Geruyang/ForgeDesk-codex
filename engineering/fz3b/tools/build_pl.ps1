#requires -Version 7.0

param(
    [ValidateSet('synth-only', 'full')][string]$Mode = 'synth-only',
    [string]$StageName,
    [string]$LicensePath,
    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$ExpectedCommit = '59cdbefade2535dbeea9a34d1658a307ab7f3bb7'
$ExpectedManifestSha = '0686f19bbd4a85e1e900fdea2647507e0c34792be1b6b58af90d6d1b4b5445ba'
$ExpectedPart = 'xazu3eg-sfvc784-1-i'
$Vivado = 'D:\vitis\2026.1\Vivado\bin\vivado.bat'
$Repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$Clone = Join-Path $Repo 'output/hardware/2026-10-16/fz3b-semantic-video-search'
$Derived = Join-Path $Repo 'output/hardware/2026-10-16/fz3b-build-audit/workspace/rtl_optim'
$Output = Join-Path $Repo 'output/hardware/2026-10-16-continuation/pl-build-preparation'
$Runs = Join-Path $Output 'runs'

function Assert-Within([string]$Path, [string]$Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes expected root"
    }
    return $full
}

function Assert-NoReparse([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point refused: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-FiniteNumber([object]$Value) {
    if ($null -eq $Value) { return $false }
    $numericTypes = @(
        [TypeCode]::Byte, [TypeCode]::SByte, [TypeCode]::Int16, [TypeCode]::UInt16,
        [TypeCode]::Int32, [TypeCode]::UInt32, [TypeCode]::Int64, [TypeCode]::UInt64,
        [TypeCode]::Single, [TypeCode]::Double, [TypeCode]::Decimal
    )
    if ([Type]::GetTypeCode($Value.GetType()) -notin $numericTypes) { return $false }
    $number = [double]$Value
    return -not ([double]::IsNaN($number) -or [double]::IsInfinity($number))
}

function Save-Json([string]$Path, [object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 20
    [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}

function Get-SubstTarget([string]$Drive) {
    $listing = @(& subst.exe)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect substituted drives' }
    $prefix = [regex]::Escape($Drive + '\') + ': => '
    foreach ($line in $listing) {
        if ($line -match ('^' + $prefix + '(.+)$')) {
            return [IO.Path]::GetFullPath($Matches[1].Trim())
        }
    }
    return $null
}

function Assert-ShortVivadoPath([string]$MappedStage) {
    $normalized = $MappedStage.Replace('\', '/').TrimEnd('/')
    if ($normalized -cnotmatch '^[V-Z]:/[A-Za-z0-9][A-Za-z0-9_-]{0,39}$') {
        throw 'Vivado stage must be a named directory below the mapped drive root'
    }
    $generatedRelative = 'project-final-008/cnn_rtl.gen/sources_1/bd/cnn_rtl_platform/ip/cnn_rtl_platform_ctrl_xbar_imp_auto_pc_0/cnn_rtl_platform_ctrl_xbar_imp_auto_pc_0_sim_netlist.vhdl'
    # Longest observed generated relative path, plus 32 characters of reserve.
    if (($normalized + '/' + $generatedRelative).Length + 32 -ge 260) {
        throw 'Vivado generated path may exceed the Windows 260-character limit'
    }
    if (($normalized + '/project-final-008').Substring($normalized.Length + 1) -cne 'project-final-008' -or
        ($normalized + '/reports').Substring($normalized.Length + 1) -cne 'reports') {
        throw 'Tcl receipt relative-path arithmetic would lose a leading character'
    }
    return $normalized
}

function New-StageDrive([string]$Stage, [string]$RunsParent) {
    $stageFull = Assert-Within $Stage $RunsParent
    $parent = [IO.Path]::GetDirectoryName($stageFull)
    if ($parent -cne [IO.Path]::GetFullPath($RunsParent).TrimEnd('\', '/')) {
        throw 'Vivado stage is not a direct child of the runs directory'
    }
    Assert-NoReparse $RunsParent
    Assert-NoReparse $stageFull
    $stageName = [IO.Path]::GetFileName($stageFull)
    if ($stageName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$') { throw 'Invalid mapped stage name' }
    foreach ($letter in @('V', 'W', 'X', 'Y', 'Z')) {
        $drive = "${letter}:"
        if ((Get-PSDrive -Name $letter -PSProvider FileSystem -ErrorAction SilentlyContinue) -or
            (Get-SubstTarget $drive)) { continue }
        & subst.exe $drive $RunsParent | Out-Null
        if ($LASTEXITCODE -ne 0) { continue }
        $mappedStage = "${drive}/$stageName"
        $mapping = [pscustomobject]@{ drive = $drive; stage = $mappedStage; parent = [IO.Path]::GetFullPath($RunsParent) }
        try {
            if ((Get-SubstTarget $drive) -cne $mapping.parent -or
                -not (Test-Path -LiteralPath (Join-Path $mappedStage 'staged-inputs.json') -PathType Leaf) -or
                (Sha256 (Join-Path $mappedStage 'staged-inputs.json')) -cne (Sha256 (Join-Path $stageFull 'staged-inputs.json'))) {
                throw 'Short-path drive mapping verification failed'
            }
            Assert-ShortVivadoPath $mappedStage | Out-Null
            return $mapping
        } catch {
            if ((Get-SubstTarget $drive) -ceq $mapping.parent) { & subst.exe $drive /D | Out-Null }
            throw
        }
    }
    throw 'No free short-path drive for Vivado'
}

function Remove-StageDrive([object]$Mapping, [string]$Stage) {
    if (-not $Mapping) { return }
    $mappedInputs = Join-Path $Mapping.stage 'staged-inputs.json'
    if ((Get-SubstTarget $Mapping.drive) -ceq $Mapping.parent -and
        (Test-Path -LiteralPath $mappedInputs -PathType Leaf) -and
        (Sha256 $mappedInputs) -ceq (Sha256 (Join-Path $Stage 'staged-inputs.json'))) {
        & subst.exe $Mapping.drive /D | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unable to remove owned short-path drive mapping' }
    } else {
        throw 'Short-path drive no longer maps to this stage; mapping left untouched'
    }
}

function Confirm-Capture([string]$Stage, [object[]]$Entries) {
    $capture = Join-Path $Stage 'project-final-008/source_snapshot'
    $hashes = Join-Path $capture 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $hashes -PathType Leaf)) { return $false }
    Assert-NoReparse $capture
    Assert-NoReparse $hashes
    foreach ($entry in $Entries) {
        if ($entry.path -clike 'scripts/*') { continue }
        $relative = ([string]$entry.path).Replace('/', [IO.Path]::DirectorySeparatorChar)
        foreach ($base in @($Stage, $capture)) {
            $path = Assert-Within (Join-Path $base $relative) $base
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
            Assert-NoReparse $path
            if ((Sha256 $path) -cne [string]$entry.sha256) { return $false }
        }
    }
    $lines = @(Get-Content -LiteralPath $hashes | Where-Object { $_.Trim() })
    if ($lines.Count -ne 36) { return $false }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $lines) {
        if ($line -cnotmatch '^([A-Fa-f0-9]{64})  ((?:rtl|platform|constraints)/[A-Za-z0-9_.-]+)$') { return $false }
        $relative = $Matches[2]
        if (-not $seen.Add($relative)) { return $false }
        $path = Assert-Within (Join-Path $capture ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) $capture
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Sha256 $path) -cne $Matches[1].ToLowerInvariant()) { return $false }
    }
    return $true
}

function Confirm-RoutedReceipt([string]$Stage, [string]$Part) {
    $reportDir = Join-Path $Stage 'reports/platform/project-final-008'
    $receiptPath = Join-Path $reportDir 'route_receipt.json'
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $false }
    Assert-NoReparse $reportDir
    Assert-NoReparse $receiptPath
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    if ($receipt.status -cne 'ROUTED_SIGNOFF_PASS' -or $receipt.stage -cne 'post_route' -or
        $receipt.part -cne $Part -or $receipt.impl_run.progress -cne '100%' -or
        $receipt.impl_run.status -notmatch 'Complete' -or
        $receipt.impl_run.final_step -cne 'phys_opt_design (Post-Route)') { return $false }
    foreach ($field in @('unrouted_nets', 'routing_errors')) {
        $value = $receipt.route.$field
        if (-not (Test-FiniteNumber $value) -or [double]$value -ne 0) { return $false }
    }
    foreach ($field in @('check_timing', 'cdc', 'drc', 'related_clocks', 'exceptions')) {
        if ($receipt.checks.$field -ne $true) { return $false }
    }
    foreach ($field in @('wns_ns', 'whs_ns', 'wpws_ns')) {
        $value = $receipt.timing.$field
        if (-not (Test-FiniteNumber $value) -or [double]$value -lt 0) { return $false }
    }
    foreach ($field in @('tns_ns', 'ths_ns')) {
        $value = $receipt.timing.$field
        if (-not (Test-FiniteNumber $value) -or [double]$value -ne 0) { return $false }
    }
    foreach ($field in @('check_timing_issues', 'drc_errors', 'drc_critical_warnings',
                         'debug_cores', 'unconstrained_internal_endpoints', 'unapproved_exceptions')) {
        $value = $receipt.counts.$field
        if (-not (Test-FiniteNumber $value) -or [double]$value -ne 0) { return $false }
    }
    $snapshotHashes = Join-Path $Stage 'project-final-008/source_snapshot/SHA256SUMS.txt'
    if ($receipt.source_snapshot_sha256 -cne (Sha256 $snapshotHashes)) { return $false }
    $requiredRoles = @('route_dcp', 'utilization', 'timing', 'route_status', 'check_timing',
                       'cdc', 'drc', 'pulse_width', 'signoff', 'build_script')
    $seenRoles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($artifact in @($receipt.artifacts)) {
        if ($artifact.role -notmatch '^[a-z_]+$' -or -not $seenRoles.Add([string]$artifact.role) -or
            $artifact.path -notmatch '^reports/platform/project-final-008/[A-Za-z0-9_.-]+$' -or
            $artifact.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { return $false }
        $path = Assert-Within (Join-Path $Stage (([string]$artifact.path).Replace('/', [IO.Path]::DirectorySeparatorChar))) $Stage
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        Assert-NoReparse $path
        if ((Get-Item -LiteralPath $path).Length -le 0 -or (Sha256 $path) -cne ([string]$artifact.sha256).ToLowerInvariant()) { return $false }
    }
    foreach ($role in $requiredRoles) { if (-not $seenRoles.Contains($role)) { return $false } }
    if (-not (Test-Path -LiteralPath (Join-Path $reportDir 'signoff.txt') -PathType Leaf)) { return $false }
    return $true
}

try {
    if (-not $StageName) { $StageName = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
    if ($StageName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$') { throw 'Invalid stage name' }
    if (-not (Test-Path -LiteralPath $Vivado -PathType Leaf)) { throw 'Fixed Vivado launcher missing' }
    if (-not (Test-Path -LiteralPath $Derived -PathType Container)) { throw 'Verified derived source missing' }
    if (-not (Test-Path -LiteralPath $Clone -PathType Container)) { throw 'Pinned upstream clone missing' }
    foreach ($path in @($Repo, $Clone, $Derived, $Output, $Runs, $Vivado)) { Assert-NoReparse $path }
    $actualCommit = (& git -C $Clone rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -cne $ExpectedCommit) { throw 'Pinned upstream commit mismatch' }
    $manifestPath = Join-Path $Derived 'SOURCE_MANIFEST.json'
    Assert-NoReparse $manifestPath
    if ((Sha256 $manifestPath) -cne $ExpectedManifestSha) { throw 'Derived source manifest hash mismatch' }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schema -cne 'rtl-optim-source-and-evidence-manifest-v1') { throw 'Unexpected source manifest schema' }
    $selected = @($manifest.files | Where-Object {
        $_.path -cmatch '^(rtl|platform|constraints)/[A-Za-z0-9_.-]+$' -or
        $_.path -cin @('scripts/build.tcl', 'scripts/create_project.tcl')
    })
    if ($selected.Count -ne 38) { throw 'Expected 36 PL inputs and two Tcl scripts' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $selected) {
        $relative = [string]$entry.path
        if (-not $seen.Add($relative)) { throw "Case-folded source collision: $relative" }
        $source = Assert-Within (Join-Path $Derived ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) $Derived
        Assert-NoReparse $source
        $file = Get-Item -LiteralPath $source
        if ($file.PSIsContainer -or $file.Length -ne [long]$entry.bytes -or (Sha256 $source) -cne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Derived source does not match pinned manifest: $relative"
        }
    }
    foreach ($directory in @('rtl', 'platform', 'constraints')) {
        $sourceDir = Join-Path $Derived $directory
        $actual = @(Get-ChildItem -LiteralPath $sourceDir -Recurse -Force)
        foreach ($item in $actual) { Assert-NoReparse $item.FullName }
        $files = @($actual | Where-Object { -not $_.PSIsContainer })
        $expected = @($selected | Where-Object { $_.path -clike "$directory/*" })
        if ($files.Count -ne $expected.Count) { throw "Unexpected source files in $directory" }
    }
    if (-not $PreflightOnly) {
        if ($LicensePath -notmatch '^[A-Za-z]:[\\/]' -or $LicensePath -match '(^|[\\/])\.\.?([\\/]|$)' -or
            -not [IO.Path]::IsPathFullyQualified($LicensePath) -or -not (Test-Path -LiteralPath $LicensePath -PathType Leaf)) {
            throw 'An existing absolute license file path is required'
        }
        Assert-NoReparse $LicensePath
    }
    foreach ($path in @($Repo, $PSScriptRoot, $Output)) {
        if ($path -match '[%!?^&|<>"\r\n]') { throw 'Unsafe command path character' }
    }
    if (-not (Test-Path -LiteralPath $Output)) { New-Item -ItemType Directory -Path $Output -Force | Out-Null }
    if (-not (Test-Path -LiteralPath $Runs)) { New-Item -ItemType Directory -Path $Runs -Force | Out-Null }
    $stage = Assert-Within (Join-Path $Runs $StageName) $Runs
    if (Test-Path -LiteralPath $stage) { throw 'Stage already exists; refusing mixed inputs' }
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    Assert-NoReparse $stage
    foreach ($directory in @('rtl', 'platform', 'constraints', 'scripts')) {
        New-Item -ItemType Directory -Path (Join-Path $stage $directory) -ErrorAction Stop | Out-Null
    }
    $copied = @()
    foreach ($entry in $selected) {
        $relative = [string]$entry.path
        $source = Join-Path $Derived ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $destination = Assert-Within (Join-Path $stage ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) $stage
        Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        if ((Sha256 $destination) -cne ([string]$entry.sha256).ToLowerInvariant()) { throw "Staged source mismatch: $relative" }
        $copied += [ordered]@{ path = $relative; bytes = [long]$entry.bytes; sha256 = ([string]$entry.sha256).ToLowerInvariant() }
    }
    $runner = Join-Path $PSScriptRoot 'run_pl.tcl'
    Assert-NoReparse $runner
    $sourceReceipt = [ordered]@{
        schemaVersion = 1; upstreamCommit = $ExpectedCommit; sourceManifestSha256 = $ExpectedManifestSha
        sourceOrigin = 'audited-derived-copy'; part = $ExpectedPart; mode = $Mode
        preflightOnly = [bool]$PreflightOnly; runnerSha256 = Sha256 $runner
        copied = $copied
    }
    Save-Json (Join-Path $stage 'staged-inputs.json') $sourceReceipt
    if ($PreflightOnly) {
        Save-Json (Join-Path $stage 'build-result.json') ([ordered]@{ status = 'PREFLIGHT_ONLY'; vivadoInvoked = $false; stage = $stage })
        Write-Output "FZ3B_PREFLIGHT_ONLY $stage"
        exit 0
    }

    $mapping = $null
    $process = $null
    try {
        $mapping = New-StageDrive $stage $Runs
        $mappedStage = $mapping.stage
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $env:ComSpec
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $psi.WorkingDirectory = $mappedStage
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.Environment['XILINXD_LICENSE_FILE'] = [IO.Path]::GetFullPath($LicensePath)
        $psi.Environment.Remove('LM_LICENSE_FILE') | Out-Null
        $tclStage = Assert-ShortVivadoPath $mappedStage
        $command = '""' + $Vivado + '" -mode batch -nolog -nojournal -notrace -source "' + $runner + '" -tclargs "' + $tclStage + '" ' + $Mode + '"'
        $psi.Arguments = '/d /s /c ' + $command
        $process = [Diagnostics.Process]::Start($psi)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
    } finally {
        if ($process -and -not $process.HasExited) { $process.WaitForExit() }
        if ($process -and -not $process.HasExited) { throw 'Vivado child exit was not confirmed; mapped drive retained' }
        Remove-StageDrive $mapping $stage
    }
    [IO.File]::WriteAllText((Join-Path $stage 'vivado.stdout.log'), $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $stage 'vivado.stderr.log'), $stderr, [Text.UTF8Encoding]::new($false))
    $exitCode = $process.ExitCode
    $status = 'FAILED'
    $gate = 'Vivado did not complete'
    $captureValid = Confirm-Capture $stage $copied
    if ($exitCode -eq 0 -and $captureValid -and $Mode -eq 'synth-only' -and $stdout.Contains('RTL_SYNTHESIS_COMPLETE_RESOURCE_AUDIT_REQUIRED')) {
        $required = @('reports/platform/project-final-008/synth.dcp', 'reports/platform/project-final-008/synth_timing_summary.rpt', 'reports/platform/project-final-008/synth_utilization_flat.rpt')
        if (@($required | Where-Object {
            $path = Join-Path $stage $_
            -not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0
        }).Count -eq 0) {
            $status = 'SYNTH_DIAGNOSTIC_ONLY'; $gate = 'Original Tcl synth run completed; no routed signoff'
        }
    }
    if ($exitCode -eq 0 -and $captureValid -and $Mode -eq 'full' -and
        $stdout.Contains('RTL_ROUTED_SIGNOFF_RECEIPT') -and (Confirm-RoutedReceipt $stage $ExpectedPart)) {
        $status = 'ROUTED_SIGNOFF_REPORTED'; $gate = 'Original Tcl routed gates and receipt hashes pass; no hardware validation'
    }
    Save-Json (Join-Path $stage 'build-result.json') ([ordered]@{
        status = $status; gate = $gate; vivadoInvoked = $true; vivadoExitCode = $exitCode
        upstreamCommit = $ExpectedCommit; part = $ExpectedPart; mode = $Mode
    })
    Write-Output "FZ3B_BUILD_RESULT $status $stage"
    if ($status -in @('SYNTH_DIAGNOSTIC_ONLY', 'ROUTED_SIGNOFF_REPORTED')) { exit 0 }
    if ($exitCode -ne 0) { exit $exitCode }
    exit 1
} catch {
    Write-Error "FZ3B build preparation failed: $($_.Exception.Message)"
    exit 1
}
