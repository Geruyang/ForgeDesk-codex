import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { durableJson } from './files.js';

const sharingError = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });
async function fixtureRoot(prefix: string) {
  const root = path.resolve('.runner-tests/embedded-durable');
  await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, prefix));
}

test('durable JSON retries transient Windows sharing failures on the same flushed temporary file', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const root = await fixtureRoot('retry-');
    try {
      const target = path.join(root, 'state.json'); const original = '{"old":true}';
      await writeFile(target, original);
      let attempts = 0; const temporaries = new Set<string>(); const waits: number[] = [];
      await durableJson(target, { next: true }, { platform: 'win32',
        async rename(source, destination) {
          temporaries.add(String(source)); attempts++;
          assert.equal(await readFile(String(source), 'utf8'), JSON.stringify({ next: true }, null, 2));
          if (attempts <= 2) { assert.equal(await readFile(target, 'utf8'), original); throw sharingError(code); }
          await rename(source, destination);
        },
        async wait(milliseconds) { waits.push(milliseconds); assert.equal(await readFile(target, 'utf8'), original); } });
      assert.equal(attempts, 3); assert.equal(temporaries.size, 1); assert.deepEqual(waits, [25, 50]);
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { next: true });
      assert.deepEqual(await readdir(root), ['state.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('exhausted durable JSON sharing retries retain the previous state and remove only the temporary file', async () => {
  const root = await fixtureRoot('exhausted-');
  try {
    const target = path.join(root, 'state.json'); const original = '{"old":true}';
    await writeFile(target, original); let attempts = 0; let delay = 0;
    await assert.rejects(durableJson(target, { next: true }, { platform: 'win32',
      async rename() { attempts++; throw sharingError('EPERM'); }, async wait(milliseconds) { delay += milliseconds; } }), /EPERM/);
    assert.equal(attempts, 7); assert.equal(delay, 975);
    assert.equal(await readFile(target, 'utf8'), original);
    assert.deepEqual(await readdir(root), ['state.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-sharing failures and non-Windows errors are not retried or accepted', async () => {
  for (const [platform, code] of [['win32', 'EIO'], ['linux', 'EPERM']] as const) {
    const root = await fixtureRoot('fatal-');
    try {
      const target = path.join(root, 'state.json'); await writeFile(target, '{"old":true}'); let attempts = 0;
      await assert.rejects(durableJson(target, {}, { platform, async rename() { attempts++; throw sharingError(code); }, async wait() { assert.fail('must not wait'); } }), new RegExp(code));
      assert.equal(attempts, 1); assert.equal(await readFile(target, 'utf8'), '{"old":true}');
      assert.deepEqual(await readdir(root), ['state.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
