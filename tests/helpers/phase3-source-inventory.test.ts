import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectPhase3SourceFiles, PHASE3_GENERATED_SOURCE_DIRS } from './phase3-source-inventory';

test('source inventory excludes generated and hidden trees but retains full product source/resources', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-source-inventory-'));
  try {
    const files = ['packages/engine-adapter/src/adapter.ts', 'packages/engine-adapter/.test-output/snapshot-copy/adapter.ts',
      'packages/engine-adapter/.protocol-home/state.json', 'packages/engine-adapter/node_modules/pkg/index.js',
      'packages/engine-adapter/dist/generated.js', 'tests/.tmp/debug.test.ts', 'engineering/fz3b/product/resources/manifest.json',
      'engineering/fz3b/product/resources/profile.json', 'engineering/fixtures/software/demo-output/generated.json',
      'engineering/__pycache__/module.py'];
    for (const relative of files) {
      const full = path.join(temporary, relative); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, 'fixture');
    }
    const inventory = await collectPhase3SourceFiles(temporary, ['packages', 'tests', 'engineering/fz3b', 'engineering/fixtures', 'engineering/__pycache__']);
    assert.deepEqual(inventory, ['engineering/fz3b/product/resources/manifest.json', 'engineering/fz3b/product/resources/profile.json',
      'packages/engine-adapter/src/adapter.ts']);
    assert.ok(PHASE3_GENERATED_SOURCE_DIRS.includes('packages/engine-adapter/.test-output'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
