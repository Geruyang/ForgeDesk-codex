param(
    [ValidateSet('upload-cancel', 'tcp-close')]
    [string] $Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ScriptRelativeFile = 'scripts/fz3b-recovery-native-approval.ps1'
$ApprovalMethod = 'fz3b-active-recovery-native-v1'
$ApprovalPurpose = 'independent-native-qa-not-product-grant'
$TtlSeconds = 300
$FixedBoot = '5ceb45a3-8903-4efc-9484-ec75c17280df'
$FixedApp = '/root/fz3b-vision-console-20261009-001'

# Filled only after the two reviewed plans have been generated and frozen.
$ApprovedPlans = @()

function Require-Condition([bool] $Condition, [string] $Code) {
    if (-not $Condition) { throw $Code }
}

function Get-BytesSha256([byte[]] $Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Assert-ExactProperties($Value, [string[]] $Names) {
    Require-Condition ($null -ne $Value -and $Value -is [pscustomobject]) 'json-object-required'
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    Require-Condition (($actual -join "`n") -ceq ($expected -join "`n")) 'json-properties-not-exact'
}

function Get-PlainProjectFile([string] $Relative) {
    Require-Condition (-not [string]::IsNullOrWhiteSpace($Relative)) 'relative-path-required'
    Require-Condition (-not [IO.Path]::IsPathRooted($Relative) -and -not $Relative.Contains('\')) 'project-relative-path-required'
    $current = $ProjectRoot
    $rootInfo = Get-Item -LiteralPath $current -Force
    Require-Condition (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'project-root-linked'
    foreach ($part in $Relative.Split('/')) {
        Require-Condition ($part -ne '' -and $part -ne '.' -and $part -ne '..' -and -not $part.Contains(':')) 'unsafe-path-component'
        $current = Join-Path $current $part
        $info = Get-Item -LiteralPath $current -Force
        Require-Condition (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'project-path-linked'
    }
    Require-Condition (-not $info.PSIsContainer) 'plain-file-required'
    return $current
}

function Read-CheckedProjectBytes([string] $Relative, [int] $Limit) {
    $file = Get-PlainProjectFile $Relative
    $before = Get-Item -LiteralPath $file -Force
    Require-Condition ($before.Length -gt 0 -and $before.Length -le $Limit) 'file-byte-budget'
    $stream = New-Object IO.FileStream($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Require-Condition ($stream.Length -eq $before.Length) 'file-extent-changed'
        $bytes = New-Object byte[] ([int] $stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            Require-Condition ($count -gt 0) 'file-read-truncated'
            $offset += $count
        }
        Require-Condition ($stream.ReadByte() -eq -1) 'file-grew-during-read'
    } finally { $stream.Dispose() }
    $after = Get-Item -LiteralPath (Get-PlainProjectFile $Relative) -Force
    Require-Condition ($after.Length -eq $before.Length -and $after.LastWriteTimeUtc -eq $before.LastWriteTimeUtc) 'file-changed-during-read'
    return ,$bytes
}

function Write-ExclusiveJson([string] $File, $Value) {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 32 -Compress) + "`n")
    $stream = New-Object IO.FileStream($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    return Get-BytesSha256 $bytes
}

function Assert-FrozenPlan($Plan, $Spec) {
    Require-Condition ($Plan.schemaVersion -is [int] -and $Plan.schemaVersion -eq 1) 'plan-schema'
    Require-Condition ($Plan.method -ceq 'fz3b-active-recovery-maintenance-v1') 'plan-method'
    Require-Condition ($Plan.executionEnabled -is [bool] -and $Plan.executionEnabled -and $null -eq $Plan.blocker) 'trial-execution-disabled'
    Require-Condition ($Plan.runId -ceq $Spec.runId -and $Plan.action -ceq $Spec.action -and $Plan.jobId -ceq $Spec.jobId) 'plan-trial-binding'
    Require-Condition ($Plan.bootId -ceq $FixedBoot -and $Plan.appRoot -ceq $FixedApp) 'plan-target-binding'
    Assert-ExactProperties $Plan.endpoint @('host', 'port')
    Require-Condition ($Plan.endpoint.host -ceq '127.0.0.1' -and $Plan.endpoint.port -is [int] -and $Plan.endpoint.port -eq 8765) 'plan-endpoint'
    Require-Condition ($Plan.nativeApprovalRequired -is [bool] -and $Plan.nativeApprovalRequired) 'plan-native-required'
    Require-Condition ($Plan.automaticRetry -is [bool] -and -not $Plan.automaticRetry) 'plan-retry-forbidden'
    Require-Condition ($Plan.changesPL -is [bool] -and -not $Plan.changesPL) 'plan-new-pl-forbidden'
    Require-Condition ($Plan.fixture -is [pscustomobject] -and $Plan.sourcePins -is [pscustomobject] -and $Plan.baseline -is [pscustomobject]) 'plan-public-pins-required'
    Require-Condition ($Plan.fixture.imageCount -is [int] -and $Plan.fixture.imageCount -eq 1) 'exactly-one-image-required'
}

function Test-NativeApprovalState($State, [DateTimeOffset] $Issued, [DateTimeOffset] $Expires, [DateTimeOffset] $Decided) {
    return ($Expires - $Issued).TotalSeconds -eq 300 -and $Decided -ge $Issued -and $Decided -lt $Expires `
        -and $State.decision -is [string] -and $State.decision -ceq 'approve' `
        -and $State.dialogShown -is [bool] -and $State.dialogShown `
        -and $State.acknowledged -is [bool] -and $State.acknowledged `
        -and $State.buttonClickObserved -is [bool] -and $State.buttonClickObserved `
        -and $State.windowHandle -is [string] -and $State.windowHandle -match '^[1-9][0-9]*$'
}

function Show-RecoveryApproval($Plan, $Spec, [DateTimeOffset] $Issued, [DateTimeOffset] $Expires) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $state = [pscustomobject]@{ decision = 'cancel'; acknowledged = $false; dialogShown = $false; windowHandle = '0'; buttonClickObserved = $false }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'ForgeDesk Independent Recovery QA Approval'
    $form.ClientSize = New-Object Drawing.Size(900, 710)
    $form.MinimumSize = New-Object Drawing.Size(780, 620)
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)
    $form.TopMost = $true
    $heading = New-Object Windows.Forms.Label
    $heading.Text = 'Independent native QA approval, not a product native grant'
    $heading.SetBounds(20, 16, 850, 28)
    $heading.Anchor = 'Top,Left,Right'
    $form.Controls.Add($heading)
    $details = New-Object Windows.Forms.TextBox
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = 'Vertical'
    $details.WordWrap = $true
    $details.SetBounds(20, 50, 860, 505)
    $details.Anchor = 'Top,Bottom,Left,Right'
    $effect = if ($Plan.action -ceq 'upload-cancel') { 'Send the fixed upload cancellation after accepting exactly one image.' } else { 'Close this trial TCP client after accepting exactly one image; reconnect only for bounded observation.' }
    $details.Text = @"
Action: $($Plan.action) (one trial, exactly one image)
$effect
Target: root@169.254.220.254; app $FixedApp; boot $FixedBoot
Control endpoint: 127.0.0.1:8765
Run: $($Plan.runId)
Job: $($Plan.jobId)
Plan: $($Spec.relativeFile)
Plan SHA-256: $($Spec.sha256)
Valid until: $($Expires.ToString('o')) (fixed five-minute absolute limit)

Actual authorized effects: prepare the existing approved candidate008 through the existing runtime/loader (which may load its existing bit and initialize R5/clock defaults); open the required device interfaces and read R5 telemetry; send the fixed query and one image; perform only the one action above. No new PL build, new bit selection, service restart, arbitrary command, automatic retry or rollback is authorized. This is a separate coordinator QA trial, not a model/product grant and not a new deployment claim.

Fixture identity:
$($Plan.fixture | ConvertTo-Json -Depth 16)

Source pins:
$($Plan.sourcePins | ConvertTo-Json -Depth 16)

Pinned baseline:
$($Plan.baseline | ConvertTo-Json -Depth 16)
"@
    $form.Controls.Add($details)
    $ack = New-Object Windows.Forms.CheckBox
    $ack.Text = 'I approve only this exact single trial and the listed device/R5/candidate008 effects.'
    $ack.Checked = $false
    $ack.SetBounds(20, 565, 860, 48)
    $ack.Anchor = 'Bottom,Left,Right'
    $form.Controls.Add($ack)
    $status = New-Object Windows.Forms.Label
    $status.SetBounds(20, 625, 550, 50)
    $status.Anchor = 'Bottom,Left,Right'
    $status.Text = 'Default decision: Cancel. Approval expires five minutes after the intent was created.'
    $form.Controls.Add($status)
    $approve = New-Object Windows.Forms.Button
    $approve.Text = 'Approve One Trial'
    $approve.Enabled = $false
    $approve.SetBounds(575, 635, 170, 42)
    $approve.Anchor = 'Bottom,Right'
    $form.Controls.Add($approve)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $cancel.SetBounds(755, 635, 125, 42)
    $cancel.Anchor = 'Bottom,Right'
    $form.Controls.Add($cancel)
    $form.AcceptButton = $cancel
    $form.CancelButton = $cancel
    $ack.Add_CheckedChanged({ $approve.Enabled = $ack.Checked })
    $approve.Add_Click({
        if ($ack.Checked -and [DateTimeOffset]::UtcNow -lt $Expires -and $watch.Elapsed.TotalSeconds -lt 300) {
            $state.decision = 'approve'; $state.acknowledged = $true; $state.buttonClickObserved = $true
            $form.DialogResult = [Windows.Forms.DialogResult]::OK
            $form.Close()
        }
    })
    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 200
    $timer.Add_Tick({
        if ([DateTimeOffset]::UtcNow -ge $Expires -or $watch.Elapsed.TotalSeconds -ge 300) {
            $state.decision = 'expired'; $form.DialogResult = [Windows.Forms.DialogResult]::Cancel; $form.Close()
        }
    })
    $form.Add_Shown({ $state.dialogShown = $true; $state.windowHandle = $form.Handle.ToInt64().ToString(); $form.ActiveControl = $cancel; $timer.Start() })
    try { [void] $form.ShowDialog(); $state.acknowledged = $ack.Checked }
    finally { $timer.Stop(); $timer.Dispose(); $form.Dispose(); $watch.Stop() }
    return $state
}

function Invoke-NativeRecoveryApproval([string] $SelectedAction) {
    Require-Condition ($env:OS -ceq 'Windows_NT') 'windows-required'
    Require-Condition ([Threading.Thread]::CurrentThread.ApartmentState -eq 'STA') 'sta-required'
    Require-Condition ($args.Count -eq 0) 'extra-arguments-forbidden'
    $selected = @($ApprovedPlans | Where-Object { $_.action -ceq $SelectedAction })
    Require-Condition ($selected.Count -eq 1) 'exact-frozen-plan-required'
    $spec = $selected[0]
    $planBytes = Read-CheckedProjectBytes $spec.relativeFile 262144
    Require-Condition ((Get-BytesSha256 $planBytes) -ceq $spec.sha256) 'fixed-plan-hash-mismatch'
    $plan = [Text.Encoding]::UTF8.GetString($planBytes) | ConvertFrom-Json
    Assert-FrozenPlan $plan $spec
    $scriptSha = Get-BytesSha256 (Read-CheckedProjectBytes $ScriptRelativeFile 131072)
    $directory = Split-Path -Parent (Get-PlainProjectFile $spec.relativeFile)
    $intentFile = Join-Path $directory 'native-intent.json'
    $receiptFile = Join-Path $directory 'native-approval.json'
    Require-Condition (-not (Test-Path -LiteralPath $receiptFile) -and -not (Test-Path -LiteralPath (Join-Path $directory 'native-consumed.json'))) 'native-decision-already-exists'
    $issued = [DateTimeOffset]::UtcNow
    $expires = $issued.AddSeconds($TtlSeconds)
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $binding = [ordered]@{
        schemaVersion = 1; method = $ApprovalMethod; purpose = $ApprovalPurpose
        runId = $plan.runId; action = $plan.action; jobId = $plan.jobId
        planRelativeFile = $spec.relativeFile; planSha256 = $spec.sha256
        approvalId = [Guid]::NewGuid().ToString('D'); approvalNonce = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
        issuedAt = $issued.ToString('o'); expiresAt = $expires.ToString('o'); ttlSeconds = $TtlSeconds; scriptSha256 = $scriptSha
    }
    $intentSha = Write-ExclusiveJson $intentFile $binding
    $state = Show-RecoveryApproval $plan $spec $issued $expires
    $decided = [DateTimeOffset]::UtcNow
    Require-Condition ((Get-BytesSha256 (Read-CheckedProjectBytes $spec.relativeFile 262144)) -ceq $spec.sha256) 'plan-changed-during-dialog'
    Require-Condition ((Get-BytesSha256 (Read-CheckedProjectBytes $ScriptRelativeFile 131072)) -ceq $scriptSha) 'script-changed-during-dialog'
    if ($decided -ge $expires -or $decided -lt $issued) { $state.decision = 'expired' }
    $approved = Test-NativeApprovalState $state $issued $expires $decided
    $receipt = [ordered]@{}
    foreach ($key in $binding.Keys) { $receipt[$key] = $binding[$key] }
    $receipt.intentSha256 = $intentSha
    $receipt.approved = [bool] $approved
    $receipt.acknowledged = [bool] $state.acknowledged
    $receipt.decision = $state.decision
    $receipt.decidedAt = $decided.ToString('o')
    $receipt.ui = [ordered]@{ framework = 'WinForms'; dialogShown = [bool] $state.dialogShown; processId = $PID; windowHandle = $state.windowHandle; defaultDecision = 'cancel'; ackInitiallyChecked = $false; buttonClickObserved = [bool] $state.buttonClickObserved }
    $receiptSha = Write-ExclusiveJson $receiptFile $receipt
    [pscustomobject]@{ result = if ($approved) { 'approved-independent-native-qa' } else { 'not-approved' }; runId = $plan.runId; action = $plan.action; receiptRelativeFile = (($spec.relativeFile -replace '/plan.json$', '') + '/native-approval.json'); receiptSha256 = $receiptSha } | ConvertTo-Json -Compress
}

Require-Condition ($args.Count -eq 0) 'extra-arguments-forbidden'
Invoke-NativeRecoveryApproval $Action
