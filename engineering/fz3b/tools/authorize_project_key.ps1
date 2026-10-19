[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$privateRoot = Join-Path $projectRoot '.runtime\fz3b-private'
$keyPath = Join-Path $privateRoot 'fz3b_acceptance_ed25519'
$publicPath = "$keyPath.pub"
$knownHosts = Join-Path $privateRoot 'known_hosts'
if (!(Test-Path -LiteralPath $keyPath -PathType Leaf) -or !(Test-Path -LiteralPath $publicPath -PathType Leaf)) {
    throw 'Project key is missing. Do not substitute a personal private key.'
}
$publicKey = (Get-Content -LiteralPath $publicPath -Raw).Trim()
if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2} forgedesk-fz3b-acceptance$') {
    throw 'Unexpected public-key format.'
}
$acl = Get-Acl -LiteralPath $keyPath
if (!$acl.AreAccessRulesProtected -and !(Get-Acl -LiteralPath $privateRoot).AreAccessRulesProtected) {
    throw 'Private key directory must have a protected per-user ACL.'
}
# Only the public key is sent. Password entry and first-host trust stay in ssh.exe.
$remote = "set -eu; test `"`$(id -u)`" = 0; umask 077; test ! -L /root/.ssh; mkdir -p /root/.ssh; test ! -L /root/.ssh/authorized_keys; touch /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; grep -Fqx '$publicKey' /root/.ssh/authorized_keys || printf '%s\n' '$publicKey' >> /root/.ssh/authorized_keys; printf '%s\n' FORGEDESK_PROJECT_PUBLIC_KEY_AUTHORIZED"
Write-Host 'Target: root@169.254.220.254. This adds only the project public key to /root/.ssh/authorized_keys.'
Write-Host 'Verify the host fingerprint before accepting first-host trust. Enter the board password only in ssh.exe, never in chat.'
Write-Host 'The project private key stays in the protected project runtime directory. No service is restarted.'
$sshArgs = @('-F', 'NUL', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=ask', '-o', "UserKnownHostsFile=$knownHosts",
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'IdentityAgent=none', '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=2',
    'root@169.254.220.254', $remote)
& ssh.exe @sshArgs
if ($LASTEXITCODE -ne 0) { throw "SSH authorization did not complete (exit $LASTEXITCODE)." }
Write-Host 'Authorization completed. Tell Codex only that it completed; do not share credentials.'
