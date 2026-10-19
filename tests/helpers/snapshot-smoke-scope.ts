import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002';
export const installerSha256 = '9375c0d22d57b9cfabf5be0df8e85a3fec66a17039f511ae97bcc0a6cf4ebbb9';
const installedHashes: Record<string, string> = {
  'resources/app.asar': 'ed70cea2a18dc4da6665635e8558a4490aee42e30a1dee22ca4b0b056a2eca24',
  'resources/codex/codex.exe': 'e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e',
  'resources/codex/codex-code-mode-host.exe': 'ec4b09849f3a5bdf4a0c3d1f3c566bda392fdcd9b4aef6bd169a81ef1283fc3d',
  'resources/codex/codex-command-runner.exe': 'bdf5160289bc4d64bc2fa38c43f9679558b3a4386226adc66a0af741e41424b7',
  'resources/codex/codex-windows-sandbox-setup.exe': '4c24960e4039b90b9c0e5e86418834f823218ed6db35ca08efad8a5a654295ed',
  'resources/process-host/process-host.exe': '722cfcd0d9ea9d187663c2f58b2e31f3dde2a00500a9aec3471d7ecedbe8d4ab',
  'resources/templates/node-software-v1/build.mjs': '7fa07121f86a42d0c8b137d8e9a8c5d716f6bb91eb3c5938199e7760556f028f',
  'resources/templates/node-software-v1/verify.mjs': '55e377db5fa0213ba0055fa2bcbd8b9cd45cea7afa569d4d389f84569a01dd0c',
  'resources/templates/node-software-v1/permission-probe.mjs': 'a7808754a361c9bf6efff605a050f87337f6066a2439b9b0dade9f8035ca6ad4',
  'resources/templates/node-software-v1/sandbox-probe.mjs': '5506abee15a8b7c58abf65905f8a1479af13c0aba16165aa32bbef8a0ca69e6f',
};
const execute = promisify(execFile);
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface DesktopIdentity {
  sid: string;
  account: string;
  sessionId: number;
  interactive: boolean;
  elevated: boolean;
  platformSids: string[];
  explorerOwners: { sid: string; sessionId: number }[];
  applications: { pid: number; executable: string; sessionId: number }[];
}

export interface SnapshotSmokeScope {
  root: string;
  runId: string;
  realModel: boolean;
  secondUser: boolean;
  installed?: string;
  runtime: string;
  workspace: string;
  dataDir: string;
  output: string;
  userScope: string;
  identity?: DesktopIdentity;
  dependencies?: { nodeExecutable: string; nodeVersion: string; gitVersion: string };
}

function samePath(left: string, right: string) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function inside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertSecondDesktop(identity: DesktopIdentity): void {
  assert.match(identity.sid, /^S-1-5-21-(\d+-){3}\d+$/, 'Second-user SID must be a real Windows user SID');
  assert.notEqual(identity.sid, primarySid, 'BLOCKED: current SID is the primary Windows user');
  assert.ok(!identity.sid.endsWith('-1002'), 'BLOCKED: RID 1002 is not an eligible second user');
  assert.ok(!/\\CodexSandbox(?:Offline|Online)$/i.test(identity.account), 'BLOCKED: platform sandbox identities are not human test users');
  assert.ok(Array.isArray(identity.platformSids) && !identity.platformSids.includes(identity.sid), 'BLOCKED: platform sandbox SID is not an eligible human user');
  assert.equal(identity.interactive, true, 'BLOCKED: no interactive Windows desktop');
  assert.equal(identity.elevated, false, 'BLOCKED: run from the standard second-user desktop, not elevated');
  assert.ok(Number.isInteger(identity.sessionId) && identity.sessionId > 0, 'BLOCKED: no interactive desktop session');
  assert.ok(identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId), 'BLOCKED: Explorer owner does not match the current SID and session');
}

export function assertSnapshotNodeVersion(version: string): void {
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major === 24 && minor >= 12, 'B smoke requires external Node 24.12 through 24.x; other major versions are unsupported');
}

// Pure derivation validates every supported override before filesystem or app access.
export function deriveSnapshotScope(root: string, environment: NodeJS.ProcessEnv, runId: string, identity?: DesktopIdentity): SnapshotSmokeScope {
  assert.ok(path.isAbsolute(root), 'Project root must be absolute');
  assert.match(runId, /^snapshot-\d+$/, 'Invalid snapshot run identifier');
  const allowed = new Set(['FORGEDESK_SNAPSHOT_INSTALLED_EXE', 'FORGEDESK_SNAPSHOT_REAL_MODEL', 'FORGEDESK_SNAPSHOT_SECOND_USER']);
  for (const [key, value] of Object.entries(environment)) if (key.startsWith('FORGEDESK_SNAPSHOT_') && value) assert.ok(allowed.has(key), `Unsupported snapshot override: ${key}`);
  const mode = environment.FORGEDESK_SNAPSHOT_SECOND_USER;
  assert.ok(!mode || mode === '1', 'Invalid second-user mode');
  const secondUser = mode === '1';
  const realModel = environment.FORGEDESK_SNAPSHOT_REAL_MODEL === '1';
  let installed = environment.FORGEDESK_SNAPSHOT_INSTALLED_EXE || undefined;
  let runtime = path.join(root, '.runtime/qa-snapshot', runId);
  let dataDir = realModel ? path.join(root, '.runtime/app') : path.join(runtime, 'data');
  let output = path.join(root, 'output/playwright/snapshot', installed ? 'installed' : 'development', runId);
  if (secondUser) {
    assert.ok(identity, 'Second-user mode requires the actual Windows identity'); assertSecondDesktop(identity);
    assert.equal(realModel, true, 'Second-user entry requires installed real-model mode');
    assert.equal(installed, undefined, 'Second-user installed path cannot be overridden');
    for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) assert.ok(!environment[key], `BLOCKED: ambient ${key} override is set`);
    installed = path.join(root, 'output/second-user', identity.sid, 'install/ForgeDesk.exe');
    runtime = path.join(root, '.runtime/second-user', identity.sid, 'snapshot', runId);
    dataDir = path.join(root, '.runtime/second-user', identity.sid, 'data');
    output = path.join(root, 'output/second-user', identity.sid, 'evidence/snapshot', runId);
    assert.equal(inside(dataDir, runtime) || inside(runtime, dataDir), false, 'Second-user workspace and product data must be disjoint');
  }
  if (installed) {
    assert.ok(path.isAbsolute(installed), 'Installed executable override must be absolute');
    assert.ok(inside(root, installed), 'Installed executable override escapes this project');
    assert.equal(path.basename(installed).toLowerCase(), 'forgedesk.exe', 'Installed executable must be ForgeDesk.exe');
    installed = path.resolve(installed);
  }
  assert.ok(!realModel || installed, 'Real-model B acceptance requires the installed executable');
  for (const value of [runtime, dataDir, output]) assert.ok(inside(root, value), 'Snapshot path escapes this project');
  return { root, runId, realModel, secondUser, installed, runtime, workspace: path.join(runtime, 'workspace'), dataDir, output,
    userScope: secondUser ? `Second Windows SID ${identity!.sid}; current desktop owner verified` : 'Primary Windows user; not second-SID acceptance', identity: secondUser ? identity : undefined };
}

export async function readDesktopIdentity(): Promise<DesktopIdentity> {
  assert.equal(process.platform, 'win32', 'A real Windows desktop is required');
  const command = `$ErrorActionPreference='Stop'
$current=[Security.Principal.WindowsIdentity]::GetCurrent()
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$principal=New-Object Security.Principal.WindowsPrincipal($current)
$platformSids=@()
foreach($name in @('CodexSandboxOffline','CodexSandboxOnline')) {
  try { $platformSids+=([Security.Principal.NTAccount]::new([Environment]::MachineName,$name)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
}
$owners=@()
foreach($explorer in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -eq $session })) {
  $owner=Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid
  if($owner.ReturnValue -eq 0) { $owners+=@{sid=$owner.Sid;sessionId=[int]$explorer.SessionId} }
}
$apps=@(Get-CimInstance Win32_Process -Filter "Name='ForgeDesk.exe'" | Where-Object { $_.ExecutablePath } | ForEach-Object { @{pid=[int]$_.ProcessId;executable=$_.ExecutablePath;sessionId=[int]$_.SessionId} })
@{sid=$current.User.Value;account=$current.Name;sessionId=$session;interactive=[Environment]::UserInteractive;elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);platformSids=$platformSids;explorerOwners=$owners;applications=$apps} | ConvertTo-Json -Depth 5 -Compress`;
  const { stdout } = await execute(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false, timeout: 30000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as DesktopIdentity;
}

async function assertPlainPath(filename: string) {
  const absolute = path.resolve(filename); const parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { assert.equal((await lstat(current)).isSymbolicLink(), false, `Reparse point is not allowed: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function readPublicStage(scope: SnapshotSmokeScope, name: string): Promise<Record<string, any>> {
  const filename = path.join(scope.root, 'output/second-user', scope.identity!.sid, 'evidence', `${name}.json`);
  await assertPlainPath(filename); const stat = await lstat(filename);
  assert.ok(stat.isFile() && stat.nlink === 1, 'Kit stage evidence must be a regular, unlinked file');
  return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
}

async function hashFile(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

async function verifySecondUserKit(scope: SnapshotSmokeScope): Promise<void> {
  const sid = scope.identity!.sid;
  const preflight = await readPublicStage(scope, 'preflight');
  assert.equal(preflight.status, 'CHECKS_OK_NOT_ACCEPTED'); assert.equal(preflight.identity?.sid, sid); assert.equal(preflight.primarySid, primarySid);
  assert.equal(preflight.releaseVersion, '0.2.1'); assert.equal(String(preflight.expectedInstallerSha256).toLowerCase(), installerSha256);
  assert.equal(samePath(preflight.installDirectory, path.dirname(scope.installed!)), true); assert.equal(samePath(preflight.dataDirectory, scope.dataDir), true);
  const install = await readPublicStage(scope, 'install');
  assert.equal(install.status, 'INSTALLER_EXIT_ZERO_NOT_ACCEPTED'); assert.equal(install.sid, sid); assert.equal(install.requestedDirectoryVerified, true);
  assert.equal(install.releaseVersion, '0.2.1'); assert.equal(String(install.installerSha256).toLowerCase(), installerSha256); assert.equal(install.resourcesVerified, true);
  assert.equal(samePath(install.installDirectory, path.dirname(scope.installed!)), true); assert.equal(samePath(install.installedExecutable, scope.installed!), true);
  const launch = await readPublicStage(scope, 'launch');
  assert.equal(launch.status, 'LAUNCHED_NOT_ACCEPTED'); assert.equal(launch.sid, sid);
  assert.equal(samePath(launch.executable, scope.installed!), true); assert.equal(samePath(launch.dataDirectory, scope.dataDir), true);
  for (const [relative, expected] of Object.entries(installedHashes)) {
    const filename = path.join(path.dirname(scope.installed!), relative); await assertPlainPath(filename);
    assert.equal(await hashFile(filename), expected, `Installed resource differs from frozen second-user kit: ${relative}`);
  }
  const nodeExecutable = await realpath(process.execPath); assert.equal(inside(scope.root, nodeExecutable), false, 'Do not use a workspace-writable Node executable');
  const git = await execute('git', ['--version'], { windowsHide: true, shell: false, timeout: 15000, cwd: scope.root });
  scope.dependencies = { nodeExecutable, nodeVersion: process.versions.node, gitVersion: git.stdout.trim() };
}

export async function assertSecondUserAppClosed(scope: SnapshotSmokeScope): Promise<void> {
  if (!scope.secondUser) return;
  const identity = await readDesktopIdentity(); assertSecondDesktop(identity);
  assert.equal(identity.sid, scope.identity!.sid); assert.equal(identity.sessionId, scope.identity!.sessionId);
  assert.equal(identity.applications.some(app => samePath(app.executable, scope.installed!)), false, 'Close the second-user ForgeDesk normally before starting this smoke');
}

export async function prepareSnapshotScope(root: string, environment: NodeJS.ProcessEnv, runId: string): Promise<SnapshotSmokeScope> {
  const identity = environment.FORGEDESK_SNAPSHOT_SECOND_USER === '1' ? await readDesktopIdentity() : undefined;
  const scope = deriveSnapshotScope(root, environment, runId, identity);
  if (scope.secondUser) assertSnapshotNodeVersion(process.versions.node);
  for (const filename of [scope.workspace, scope.dataDir, scope.output, ...(scope.installed ? [scope.installed] : [])]) await assertPlainPath(filename);
  if (scope.secondUser) { await verifySecondUserKit(scope); await assertSecondUserAppClosed(scope); }
  return scope;
}
