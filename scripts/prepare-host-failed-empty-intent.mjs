import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFixedCompiler } from './prepare-host-acl.mjs';

const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = [
  ['engineering/windows/host-failed-empty-intent/FailedEmptyIntentHelper.cs', 'cb1dc1a2a79c1461f0caf7ab168c711c4f6b1bc44d79c0d796a62608d0d47d62'],
  ['engineering/windows/host-failed-empty-intent/FinalLiveChecks.cs', '1ef5552a650831e97be4200460acc61a49344017d7a66f679585b2a74ad2b112'],
  ['apps/desktop/main/host-failed-empty-intent.ts', '23f372e7444de52b1c2b1f2954c8086028802ff158607da7bff5461f58442153'],
  ['apps/desktop/main/host-failed-empty-intent-main.ts', 'c224fc3c668085ed7da63e7a5b450466c9ea9aca9b5b38cd3007eeb342824c15'],
];
function checkedRead(file, maximum) {
  let current = path.resolve(file);
  for (;;) { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('FAILED_INTENT_BUILD_LINK'); const parent = path.dirname(current); if (current === parent) break; current = parent; }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error('FAILED_INTENT_BUILD_FILE');
  const raw = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || raw.length !== before.size) throw new Error('FAILED_INTENT_BUILD_CHANGED');
  return raw;
}
function checkInputs(repository) {
  for (const [relative, pin] of expected) if (sha(checkedRead(path.join(repository, relative), 131072)) !== pin) throw new Error(`FAILED_INTENT_BUILD_SOURCE_PIN ${relative}`);
  readFixedCompiler();
}
function checkDirectory(directory) {
  let current = path.resolve(directory);
  for (;;) {
    const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('FAILED_INTENT_BUILD_DIRECTORY');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
/** Build-time only: pinned source/compiler, new resource output, no helper execution. */
export function prepareHostFailedEmptyIntent() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('FAILED_INTENT_BUILD_WINDOWS_X64');
  const repository = fs.realpathSync(process.cwd());
  checkInputs(repository);
  const root = path.join(repository, 'vendor', 'host-failed-empty-intent');
  checkDirectory(path.join(repository, 'vendor'));
  // Retain every previous resource directory; no overwrite or cleanup, even on build failure.
  const buildRoot = path.join(repository, 'vendor', `host-failed-empty-intent-build-${randomUUID()}`);
  fs.mkdirSync(buildRoot); const executable = path.join(buildRoot, 'FailedEmptyIntentHelper.exe');
  const started = performance.now();
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Security.dll', `/out:${executable}`,
    ...expected.slice(0, 2).map(([relative]) => path.join(repository, relative))], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 131072, env: { SystemRoot: process.env.SystemRoot } });
  if (performance.now() - started >= 5000 || result.error || result.status !== 0 || result.signal !== null || result.stdout.length || result.stderr.length) throw new Error('FAILED_INTENT_BUILD_COMPILER');
  checkInputs(repository);
  const policySourceSha256 = sha(JSON.stringify(expected.map(([file, sha256]) => ({ file, sha256 }))));
  const executableSha256 = sha(checkedRead(executable, 1048576));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, protocol: 'fz3b-failed-empty-intent-v1', policySourceSha256, executableSha256 }));
  fs.writeFileSync(path.join(buildRoot, 'manifest.json'), manifest, { flag: 'wx' });
  if (fs.readdirSync(buildRoot).sort().join(',') !== 'FailedEmptyIntentHelper.exe,manifest.json' || sha(checkedRead(executable, 1048576)) !== executableSha256 || sha(checkedRead(path.join(buildRoot, 'manifest.json'), 65536)) !== sha(manifest)) throw new Error('FAILED_INTENT_BUILD_OUTPUT_CHANGED');
  checkInputs(repository);
  if (fs.existsSync(root)) {
    if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory() || fs.readdirSync(root).sort().join(',') !== 'FailedEmptyIntentHelper.exe,manifest.json') throw new Error('FAILED_INTENT_PREVIOUS_RESOURCE');
    fs.renameSync(root, path.join(repository, 'vendor', `host-failed-empty-intent-previous-${randomUUID()}`));
  }
  fs.renameSync(buildRoot, root);
  return {
    __FORGEDESK_FAILED_INTENT_RESOURCE_ROOT__: JSON.stringify(root),
    __FORGEDESK_FAILED_INTENT_MANIFEST_SHA256__: JSON.stringify(sha(manifest)),
    __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__: JSON.stringify(executableSha256),
    __FORGEDESK_FAILED_INTENT_POLICY_SHA256__: JSON.stringify(policySourceSha256),
  };
}
