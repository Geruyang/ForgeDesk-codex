import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { noLinks } from '../../../packages/engineering-runner/embedded/files.js';
import { createStartupHistoryAsyncReader, type StartupHistoryChild } from './release-recovery-history-async.js';

declare const __FORGEDESK_STARTUP_HISTORY_WORKER_SHA256__: string;
declare const __FORGEDESK_STARTUP_HISTORY_HOST_SHA256__: string;
type NativeOptions = { dataDir: string; packaged: boolean; mainDirectory: string; resourcesPath: string; appPath: string; executable: string };
type Result = Awaited<ReturnType<ReturnType<typeof createStartupHistoryAsyncReader>['read']>>;
type Ports = { verify(worker: string, host: string): Promise<void>; launch: typeof spawn };
function same(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) {
  return ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
}
async function pinned(file: string, expected: string, limit: number) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw Error('Startup history build pin');
  await noLinks(file); const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw Error('Startup history pinned file');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat(); if (!same(before, opened)) throw Error('Startup history pinned identity');
    const raw = Buffer.alloc(before.size); let offset = 0;
    while (offset < raw.length) { const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset); if (!bytesRead) throw Error('Startup history short read'); offset += bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !same(opened, await handle.stat()) ||
      createHash('sha256').update(raw).digest('hex') !== expected) throw Error('Startup history pin mismatch');
    await noLinks(file); if (!same(before, await lstat(file))) throw Error('Startup history pinned replacement');
  } finally { await handle.close(); }
}
const nativePorts: Ports = { launch: spawn, async verify(worker, host) {
  if (typeof __FORGEDESK_STARTUP_HISTORY_WORKER_SHA256__ === 'undefined' || typeof __FORGEDESK_STARTUP_HISTORY_HOST_SHA256__ === 'undefined') throw Error('Startup history build pins absent');
  await pinned(host, __FORGEDESK_STARTUP_HISTORY_HOST_SHA256__, 2 * 1024 * 1024);
  await pinned(worker, __FORGEDESK_STARTUP_HISTORY_WORKER_SHA256__, 16 * 1024 * 1024);
} };

/** Trusted main capture only, no renderer/request/environment-selected root or executable. */
export function createNativeStartupHistoryOwner(options: NativeOptions, ports: Ports = nativePorts) {
  if (options.executable !== process.execPath || ![options.dataDir, options.mainDirectory, options.resourcesPath, options.appPath, options.executable].every(file => path.isAbsolute(file) && !file.includes('\0')) ||
    typeof options.packaged !== 'boolean') throw Error('Startup history native root');
  const captured = { ...options };
  const worker = captured.packaged ? path.join(captured.resourcesPath, 'startup-history', 'release-recovery-history-worker.cjs') :
    path.join(captured.mainDirectory, 'release-recovery-history-worker.cjs');
  const host = captured.packaged ? path.join(captured.resourcesPath, 'process-host', 'process-host.exe') : path.join(captured.appPath, 'vendor', 'process-host', 'process-host.exe');
  let pending: Promise<Result> | undefined;
  return Object.freeze({ read(): Promise<Result> {
    return pending ??= new Promise(resolve => {
      let expired = false;
      // This only bounds observation of asynchronous pin reads; it does NOT claim to stop those reads.
      const timer = setTimeout(() => { expired = true; resolve(Object.freeze({ status: 'unknown', closeConfirmed: false, reason: 'startup-pin-read-unconfirmed', projection: null })); }, 5000);
      void ports.verify(worker, host).then(() => {
        if (expired) return; clearTimeout(timer);
        const reader = createStartupHistoryAsyncReader(captured.dataDir, captured.packaged, () => ports.launch(host,
          ['--', captured.executable, worker], { cwd: path.dirname(captured.executable), shell: false, windowsHide: true,
            env: { SystemRoot: process.env.SystemRoot ?? 'C:/Windows', WINDIR: process.env.SystemRoot ?? 'C:/Windows', ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', 'pipe', 'pipe'] }) as StartupHistoryChild);
        void reader.read().then(resolve, () => resolve(Object.freeze({ status: 'unknown', closeConfirmed: false, reason: 'startup-owned-reader-unconfirmed', projection: null })));
      }).catch(() => {
        if (expired) return; clearTimeout(timer);
        resolve(Object.freeze({ status: 'held', closeConfirmed: true, reason: 'startup-pinned-launch-refused', projection: null }));
      });
    });
  } });
}
