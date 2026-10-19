import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { verifyEmbeddedExport } from './helpers/embedded-export';

const root = path.resolve('tests/.tmp/embedded-export');
test('actual nested export layout is accepted with all copies checked, not outer JSON lookup', async () => {
  await mkdir(root, { recursive: true }); const destination = await mkdtemp(path.join(root, 'case-'));
  try {
    const directory = path.join(destination, 'forgedesk-embedded-task-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'); await mkdir(directory);
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const relative of ['firmware/GestureScreen.hex', 'firmware/GestureScreen.axf', 'build/keil-build.log', 'build/source-manifest.json', 'receipts/op.json']) {
      const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); const content = Buffer.from(relative === 'build/source-manifest.json' ? JSON.stringify({ profileSha256: 'a'.repeat(64) }) : `fixture ${relative}`); await writeFile(target, content);
      files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
    }
    const expected: EmbeddedStatus = { configured: true, taskId: 'task', profileId: 'fixture', profileSha256: 'a'.repeat(64), limitation: 'Fixture only', hardwareAvailable: false,
      operations: [{ id: 'op', kind: 'verify', requestKey: 'key', status: 'succeeded', processExited: true, receipt: '{}', argsDigest: 'b'.repeat(64), nonce: '01'.repeat(16), createdAt: '', updatedAt: '' }],
      artifact: { id: 'build', hexSha256: files[0].sha256, axfSha256: files[1].sha256 } as EmbeddedStatus['artifact'] };
    const evidenceFile = path.join(directory, 'evidence.json'); const body = { schemaVersion: 1, state: { taskId: expected.taskId, operations: expected.operations, builds: [expected.artifact] }, files };
    await writeFile(evidenceFile, JSON.stringify(body)); const verified = await verifyEmbeddedExport(destination, expected);
    assert.equal(verified.path, evidenceFile); assert.equal(verified.fileCount, 5);
    expected.operations[0].progress = { schemaVersion: 1, operationId: 'op', action: 'verify', stage: 'finalizing', sequence: 3, updatedAt: '2026-10-15T01:00:00Z' };
    await verifyEmbeddedExport(destination, expected); // The persisted export correctly has no dynamic telemetry.
    const altered = structuredClone(body); altered.state.operations[0].progress = { ...expected.operations[0].progress!, stage: 'cdc_challenge_1', sequence: 1 };
    await writeFile(evidenceFile, JSON.stringify(altered)); await verifyEmbeddedExport(destination, expected);
    for (const patch of [{ status: 'failed' }, { receipt: 'tampered receipt' }, { argsDigest: 'tampered binding' }]) { const corrupt = structuredClone(altered); Object.assign(corrupt.state.operations[0], patch); await writeFile(evidenceFile, JSON.stringify(corrupt)); await assert.rejects(verifyEmbeddedExport(destination, expected)); }
    await writeFile(evidenceFile, JSON.stringify(body));
    await writeFile(path.join(directory, files[0].path), 'tampered'); await assert.rejects(verifyEmbeddedExport(destination, expected), /strictly equal|mismatch/);
  } finally { assert.ok(destination.startsWith(root + path.sep)); await rm(destination, { recursive: true, force: true }); }
});
test('outer JSON only and duplicate nested bundles fail closed', async () => {
  await mkdir(root, { recursive: true }); const destination = await mkdtemp(path.join(root, 'case-'));
  try {
    const expected = { taskId: 'task' } as EmbeddedStatus; await writeFile(path.join(destination, 'forgedesk-embedded-task-fixture.json'), '{}');
    await assert.rejects(verifyEmbeddedExport(destination, expected));
    await mkdir(path.join(destination, 'forgedesk-embedded-task-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')); await mkdir(path.join(destination, 'forgedesk-embedded-task-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'));
    await assert.rejects(verifyEmbeddedExport(destination, expected), /one nested/);
  } finally { assert.ok(destination.startsWith(root + path.sep)); await rm(destination, { recursive: true, force: true }); }
});
