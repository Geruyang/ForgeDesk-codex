import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GESTURESCREEN_PROFILE as profile, GESTURESCREEN_PROFILE_SHA256 } from '../packages/engineering-runner/embedded/profile.js';
import { deriveEmbeddedInstalledScope, fileSha256 } from '../tests/helpers/embedded-installed.js';

const root = process.cwd();
const runtimeRef = process.argv[2];
if (!runtimeRef || !/^[a-f0-9]{40}$/.test(runtimeRef) || process.argv.length !== 3) throw new Error('Supply the exact 40-character installed runtime source commit');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string;
const runId = `t2-${Date.now()}-${randomBytes(3).toString('hex')}`;
const installedExe = path.join(root, 'install/ForgeDesk.exe');
const installerPath = path.join(root, `release/ForgeDesk-${version}-x64-setup.exe`);
const resources = ['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
  'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe', 'hardware/python/python.exe',
  'hardware/manifest.json', 'hardware-worker.py', 'templates/gesturescreen-v1/overlay-manifest.json'];
const overlay = JSON.parse(await readFile(path.join(root, 'engineering/templates/gesturescreen-v1/overlay-manifest.json'), 'utf8'));
resources.push(...overlay.files.map((file: { path: string }) => `templates/gesturescreen-v1/${file.path}`));
const resourceHashes: Record<string, string> = {};
for (const resource of resources) resourceHashes[`resources/${resource}`] = await fileSha256(path.join(root, 'install/resources', resource));
const plan = {
  schemaVersion: 1, scope: 'user-driven-fixed-target-installed-T2', runId, version,
  runtimeCommit: execFileSync('git', ['rev-parse', `${runtimeRef}^{commit}`], { encoding: 'utf8', windowsHide: true }).trim(),
  installedExe, installerPath, executableSha256: await fileSha256(installedExe), installerSha256: await fileSha256(installerPath),
  projectRoot: path.join(root, 'output/hardware/2026-10-15/GestureScreen'), keilExecutable: profile.keilExecutable, resourceHashes,
  expectedProfile: { id: profile.id, sha256: GESTURESCREEN_PROFILE_SHA256, probeSerial: profile.probeSerial,
    uid: profile.uid, chipId: profile.chipId, flashKiB: profile.flashKiB, cdcSerial: profile.cdcSerial },
  artifactTamperPreflight: true,
};
deriveEmbeddedInstalledScope(root, plan, process.env);
const target = path.join(root, 'output/hardware/t2-plans', `${runId}.json`);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(plan, null, 2), { flag: 'wx' });
console.log(target);
