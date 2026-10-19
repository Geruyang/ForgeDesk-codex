import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { Fz3bHostFinalizationStore } from '../apps/desktop/main/host-finalization-store';
import { DesktopStore } from '../apps/desktop/main/store';
import { currentSid, fz3bHostDependencyAclSync, fz3bPrivateAclBatchSync, fz3bPrivateAclSync } from '../packages/engineering-runner/fz3b/credentials';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';

// Explicit manual entry, never selected by .test discovery. Only new project-local synthetic files.
assert.equal(process.platform, 'win32');
const fixture = await fz3bHostProductionFixture(), sid = await currentSid();
const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization/production-fixtures');
assert.equal(path.dirname(fixture.home), base);
assert.equal(fs.existsSync(path.join(fixture.home, 'fz3b-host-finalization-v1')), false);
const setupPaths: string[] = [];
const collect = (directory: string) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name), stat = fs.lstatSync(name);
    assert.equal(stat.isSymbolicLink(), false); assert.ok(stat.isDirectory() || stat.isFile());
    if (stat.isDirectory()) collect(name); else setupPaths.push(name);
    assert.ok(setupPaths.length <= 128);
  }
  setupPaths.push(directory);
};
collect(fixture.home);
// Protect existing synthetic children first; a non-inheriting parent ACL must not strand them.
for (const name of setupPaths) fz3bPrivateAclSync(name, sid, true);
const calls: Array<{ kind: string; update?: boolean; files: number; ms: number }> = [];
const stages: Array<{ stage: string; at: number }> = [];
const timed = (kind: string, files: number, action: () => void, update?: boolean) => {
  const start = performance.now(); try { action(); } finally { calls.push({ kind, update, files, ms: performance.now() - start }); }
};
const observation = {
  privateAcl: (file: string, value: string, update: boolean) => timed('private', 1, () => fz3bPrivateAclSync(file, value, update), update),
  privateAclBatch: (files: readonly string[], value: string) => timed('batch', files.length, () => fz3bPrivateAclBatchSync(files, value)),
  dependencyAcl: (root: string, value: string) => timed('dependency', 3, () => fz3bHostDependencyAclSync(root, value)),
  onStage: (stage: string) => { stages.push({ stage, at: Date.now() }); },
};
const report: Record<string, unknown> = { schemaVersion: 1, scope: 'isolated-new-project-files-native-acl-timing-not-installed-acceptance', home: fixture.home, sid, setupPrivatePaths: setupPaths.length, setupHostArtifacts: 0, harnessReadPrivateKeyBytes: false, appModelSshDeviceActions: 0 };
try {
  const component = new Fz3bHostFinalizationStore(fixture.store, fixture.backend, binding => fixture.assertOwner(binding.owner), sid, observation);
  const start = performance.now(); await component.finish(fixture.owner.runId);
  report.firstFinish = { ms: performance.now() - start, calls: [...calls], stages: [...stages] };
  assert.equal(calls.filter(call => call.kind === 'private').length, 7);
  assert.equal(calls.filter(call => call.kind === 'batch').length, 2);
  calls.length = 0; stages.length = 0;
  const restarted = new Fz3bHostFinalizationStore(new DesktopStore(fixture.home), fixture.backend, binding => fixture.assertOwner(binding.owner), sid, observation);
  const readStart = performance.now(); assert.equal(await restarted.has(fixture.owner.runId), true);
  report.readonlyRestart = { ms: performance.now() - readStart, calls: [...calls], stages: [...stages] };
  assert.equal(calls.filter(call => call.kind === 'batch').length, 1); assert.equal(calls.some(call => call.update), false); assert.equal(stages.length, 0);
  assert.equal(fixture.state.forbidden, 0); report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.finalCalls = calls; report.finalStages = stages;
  const target = path.join(fixture.home, 'native-acl-timing.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ report: target, passed: report.passed, firstFinish: report.firstFinish, readonlyRestart: report.readonlyRestart, error: report.error }));
}
