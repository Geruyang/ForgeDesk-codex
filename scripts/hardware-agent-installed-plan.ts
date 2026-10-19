import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { GESTURESCREEN_PROFILE as profile, GESTURESCREEN_PROFILE_SHA256 } from '../packages/engineering-runner/embedded/profile';
import { fileSha256, plainPath } from '../tests/helpers/embedded-installed';
import { deriveHardwareAgentInstalledScope, HARDWARE_AGENT_MODEL, type HardwareAgentInstalledPlan } from '../tests/helpers/hardware-agent-installed';

const root = process.cwd();
const runtimeRef = process.argv[2];
if (!runtimeRef || !/^[a-f0-9]{40}$/.test(runtimeRef) || process.argv.length > 4) throw new Error('Supply the exact installed runtime commit and optional absolute prepared project path');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string;
if (version !== '0.4.0') throw new Error('The real-model hardware plan requires the reviewed 0.4.0 release');
const projectRoot = process.argv[3] ?? path.join(root, 'output/hardware/2026-10-15/GestureScreen');
const installedExe = path.join(root, 'install/ForgeDesk.exe');
const installerPath = path.join(root, 'release/ForgeDesk-0.4.0-x64-setup.exe');
for (const file of [projectRoot, installedExe, installerPath]) await plainPath(file);
const names = ['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
  'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe', 'hardware/python/python.exe', 'hardware/manifest.json',
  'hardware-worker.py', 'templates/gesturescreen-v1/overlay-manifest.json'];
const overlay = JSON.parse(await readFile(path.join(root, 'engineering/templates/gesturescreen-v1/overlay-manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
names.push(...overlay.files.map(file => `templates/gesturescreen-v1/${file.path}`));
const resourceHashes: Record<string, string> = {};
for (const name of names) resourceHashes[`resources/${name}`] = await fileSha256(path.join(root, 'install/resources', name));
const plan: HardwareAgentInstalledPlan = {
  schemaVersion: 1, scope: 'real-model-fixed-target-installed-T2', runId: `hardware-agent-${Date.now()}-${randomBytes(3).toString('hex')}`,
  version, runtimeCommit: execFileSync('git', ['rev-parse', `${runtimeRef}^{commit}`], { encoding: 'utf8', windowsHide: true }).trim(),
  dataDir: path.join(root, '.runtime/app'), installedExe, installerPath,
  executableSha256: await fileSha256(installedExe), installerSha256: await fileSha256(installerPath), projectRoot,
  keilExecutable: profile.keilExecutable, resourceHashes, model: HARDWARE_AGENT_MODEL,
  expectedProfile: { id: profile.id, sha256: GESTURESCREEN_PROFILE_SHA256, probeSerial: profile.probeSerial, uid: profile.uid,
    chipId: profile.chipId, flashKiB: profile.flashKiB, cdcSerial: profile.cdcSerial },
};
deriveHardwareAgentInstalledScope(root, plan, process.env);
const file = path.join(root, 'output/hardware/hardware-agent-plans', `${plan.runId}.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(plan, null, 2), { flag: 'wx' });
console.log(file);
