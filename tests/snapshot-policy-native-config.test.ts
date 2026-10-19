import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../packages/engine-adapter/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t: TestContext) {
  const base = path.join(root, 'output/qa/snapshot-native-policy'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'run-'));
  const home = path.join(directory, 'home'); const cwd = path.join(directory, 'workspace'); const extra = path.join(directory, 'unauthorized-root');
  for (const dir of [home, cwd, extra, path.join(cwd, '.git'), path.join(cwd, '.codex')]) await mkdir(dir, { recursive: true });
  const engine = new CodexAdapter({ executable: path.join(root, 'vendor/codex/codex.exe'),
    processHost: path.join(root, 'vendor/process-host/process-host.exe'), home, onEvent: () => {} });
  t.after(() => engine.stop());
  const injected = `[permissions.forgedesk_workspace_v1.filesystem]\n${JSON.stringify(extra.replaceAll('\\', '/'))} = "write"\n`;
  return { directory, home, cwd, extra, engine, injected };
}

test('real config merge cannot add a private-home write root to the fixed snapshot profile', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, 'config.toml'), f.injected);
  await assert.rejects(f.engine.start(), /fixed no-temp workspace policy/);
  await writeFile(path.join(f.directory, 'evidence.json'), JSON.stringify({ scope: 'Fresh uncredentialed app-server native config validation', rejected: true, origin: 'private-home profile merge', commandExecuted: false }));
});

test('real actual-cwd config merge is rejected even after a clean engine startup', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await promisify(execFile)('git', ['init', '--quiet', f.cwd], { windowsHide: true });
  await writeFile(path.join(f.home, 'config.toml'), `[projects.${JSON.stringify(f.cwd.toLowerCase())}]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(f.cwd, '.codex/config.toml'), f.injected);
  await f.engine.start();
  await assert.rejects(f.engine.snapshotPolicy(f.cwd), /fixed no-temp workspace policy/);
  await writeFile(path.join(f.directory, 'evidence.json'), JSON.stringify({ scope: 'Fresh uncredentialed app-server native config validation', rejected: true, origin: 'actual-cwd profile merge', commandExecuted: false }));
});
