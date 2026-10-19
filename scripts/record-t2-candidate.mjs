import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';

const runtimeRef = process.argv[2];
if (!runtimeRef || !/^[a-f0-9]{40}$/.test(runtimeRef) || process.argv.length !== 3) throw new Error('Supply the exact candidate runtime commit');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const artifact = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { file, bytes: (await stat(file)).size, sha256: hash.digest('hex') };
};
const asarPath = 'release/win-unpacked/resources/app.asar';
const packaged = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
if (packaged.version !== version) throw new Error('Candidate version does not match package');
const license = extractFile(asarPath, path.join('dist', 'licenses', 'GestureScreen.txt'));
if (!license.equals(await readFile('docs/third-party/GestureScreen-LICENSE.txt'))) throw new Error('Packaged upstream license mismatch');
const manifest = {
  schemaVersion: 1, version, state: 'candidate-not-installed-or-hardware-accepted', generatedAt: new Date().toISOString(),
  runtimeSourceCommit: execFileSync('git', ['rev-parse', `${runtimeRef}^{commit}`], { encoding: 'utf8', windowsHide: true }).trim(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  installer: await artifact(`release/ForgeDesk-${version}-x64-setup.exe`),
  source: await artifact(`release/ForgeDesk-source-${version}.zip`),
  packagedApp: await artifact(asarPath),
  runtimeManifest: await artifact('release/win-unpacked/resources/hardware/manifest.json'),
  worker: await artifact('release/win-unpacked/resources/hardware-worker.py'),
  gestureScreenLicenseSha256: createHash('sha256').update(license).digest('hex'),
  signature: 'Unsigned; no signing certificate configured',
  priorInstalledAttempt: 'output/t2/t2-1792065173815-dafb60/evidence.json',
  T2: `Incomplete for ${version}. Prior 0.3.0 timed out before flash and 0.3.1 flash failed with unknown outcome; retain those historical failures. Version 0.3.2 passed its bounded user-driven fixed-target T2 run. Version 0.3.3 built successfully but failed before inspect when state-file rename returned EPERM; it did not flash. This ${version} candidate remains pending and unverified; no autonomous-model or complete fault-matrix acceptance is claimed.`,
  secondUser: 'Paused; no second-account verification performed',
};
await writeFile(`release/manifest-${version}-candidate.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ version, state: manifest.state, installer: manifest.installer, runtimeSourceCommit: manifest.runtimeSourceCommit }));
