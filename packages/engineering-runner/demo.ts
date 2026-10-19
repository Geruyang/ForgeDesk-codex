import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EngineeringRunner } from './index.js';

export async function runSoftwareDemo() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fixtures = path.join(root, 'engineering/fixtures/software');
  const outputRoot = path.join(fixtures, 'demo-output');
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(path.join(outputRoot, 'run-'));
  const projectRoot = path.join(output, 'workspace');
  await mkdir(projectRoot);
  const module = path.join(projectRoot, 'numbers.mjs');
  await writeFile(module, await readFile(path.join(fixtures, 'workspace/numbers.mjs')));
  const verifier = path.join(fixtures, 'verifiers/verify-numbers.mjs');
  const candidateHost = path.join(root, 'vendor/process-host/process-host.exe');
  let processHost: string | undefined;
  if (process.platform === 'win32') { try { await access(candidateHost); processHost = candidateHost; } catch { /* Explicit fallback appears in evidence. */ } }
  const runner = new EngineeringRunner({ dataDir: path.join(output, 'private-runner-state'), processHost });
  try {
    await runner.createTask({ id: 'empty-input', projectRoot, sessionId: 'independent-fixture', title: 'Fix the empty-input mean defect' });
    const command = { executable: process.execPath, args: [verifier, projectRoot], cwd: projectRoot, timeoutMs: 10000 };
    await runner.setAcceptance('empty-input', [{ id: 'trusted-arithmetic', title: 'Empty input, nonempty mean and signed values', kind: 'automated', command, verifierFiles: [verifier] }]);
    const build = await runner.run({ taskId: 'empty-input', requestKey: 'baseline-build', kind: 'build', command: { executable: process.execPath, args: ['--check', module] } });
    const before = await runner.run({ taskId: 'empty-input', requestKey: 'before-fix', kind: 'test', acceptanceId: 'trusted-arithmetic', command });
    if (before.status !== 'failed') throw new Error('Fixture defect did not fail as expected');
    await writeFile(module, 'export function average(values) {\n  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n');
    const after = await runner.run({ taskId: 'empty-input', requestKey: 'after-fix', kind: 'test', acceptanceId: 'trusted-arithmetic', command });
    const passed = await runner.getTask('empty-input');
    if (after.status !== 'succeeded' || passed.status !== 'passed') throw new Error('Corrected fixture did not pass trusted acceptance');
    const delivery = await runner.exportTask('empty-input', path.join(output, 'delivery'));
    await writeFile(path.join(projectRoot, 'additional-source.txt'), 'A source change must expire the previously passing evidence.\n');
    const stale = await runner.refresh('empty-input');
    if (stale.acceptance[0].status !== 'stale') throw new Error('Source mutation did not expire evidence');
    const report = { schemaVersion: 1, executedAt: new Date().toISOString(), processHost: processHost ?? null,
      projectRoot, trustedVerifier: verifier, build: { id: build.id, status: build.status },
      beforeFix: { id: before.id, status: before.status, log: before.logRef },
      afterFix: { id: after.id, status: after.status, log: after.logRef }, passedTaskStatus: passed.status,
      afterSourceChange: stale.acceptance[0].status, export: delivery };
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally { await runner.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runSoftwareDemo(), null, 2));
}
