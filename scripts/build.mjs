import { prepareHostAcl } from './prepare-host-acl.mjs';
import { prepareHostFailedEmptyIntent } from './prepare-host-failed-empty-intent.mjs';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, cp, access, readFile } from 'node:fs/promises';
await mkdir('dist/main', { recursive: true });
await mkdir('dist/preload', { recursive: true });
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/licenses', { recursive: true });
await copyFile('docs/third-party/GestureScreen-LICENSE.txt', 'dist/licenses/GestureScreen.txt');
for (const name of ['react', 'react-dom', 'lucide-react']) {
  const source = `node_modules/${name}/LICENSE`;
  await copyFile(source, `dist/licenses/${name}.txt`);
}
const hardwareDefines = { ...prepareHostAcl(), ...prepareHostFailedEmptyIntent() };
for (const [name, file] of [
  ['__FORGEDESK_HARDWARE_MANIFEST_SHA256__', 'vendor/hardware/manifest.json'],
  ['__FORGEDESK_HARDWARE_WORKER_SHA256__', 'engineering/hardware-worker.py'],
  ['__FORGEDESK_FZ3B_RESOURCES_SHA256__', 'engineering/fz3b/product/resources/manifest.json'],
]) hardwareDefines[name] = JSON.stringify(createHash('sha256').update(await readFile(file)).digest('hex'));
await build({ entryPoints: ['apps/desktop/main/release-recovery-history-worker-entry.ts'], outfile: 'dist/main/release-recovery-history-worker.cjs', bundle: true, platform: 'node', format: 'cjs', define: hardwareDefines });
hardwareDefines.__FORGEDESK_STARTUP_HISTORY_WORKER_SHA256__ = JSON.stringify(createHash('sha256').update(await readFile('dist/main/release-recovery-history-worker.cjs')).digest('hex'));
hardwareDefines.__FORGEDESK_STARTUP_HISTORY_HOST_SHA256__ = JSON.stringify(createHash('sha256').update(await readFile('vendor/process-host/process-host.exe')).digest('hex'));
await build({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true, define: hardwareDefines });
await build({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/renderer/index.tsx'], outfile: 'dist/renderer/index.js', bundle: true, platform: 'browser', format: 'esm', loader: { '.png': 'file', '.svg': 'file' }, sourcemap: true });
await copyFile('apps/desktop/renderer/index.html', 'dist/renderer/index.html');
try { await access('apps/desktop/renderer/assets'); await cp('apps/desktop/renderer/assets', 'dist/renderer/assets', { recursive: true }); } catch {}
await build({ entryPoints: ['packages/engineering-mcp/index.ts'], outfile: 'dist/mcp/index.cjs', bundle: true, platform: 'node', format: 'cjs' });
