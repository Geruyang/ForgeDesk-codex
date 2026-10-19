// This wrapper grants no identity or path override; the harness verifies the real desktop first.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSnapshotScope } from './helpers/snapshot-smoke-scope';

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('FORGEDESK_SNAPSHOT_') && value) assert.fail(`Open a clean second-user PowerShell; remove ambient ${key}`);
}
assert.equal(process.argv.length, 2, 'This entry accepts no path, data, identity or mode arguments');
process.env.FORGEDESK_SNAPSHOT_SECOND_USER = '1';
process.env.FORGEDESK_SNAPSHOT_REAL_MODEL = '1';
await prepareSnapshotScope(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.env, `snapshot-${Date.now()}`);
await import('./snapshot-electron-smoke');
