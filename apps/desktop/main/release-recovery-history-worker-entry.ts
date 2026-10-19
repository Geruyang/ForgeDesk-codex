import path from 'node:path';
import { startupHistoryWorkerFrame } from './release-recovery-history-worker.js';

// A RUN_AS_NODE Electron child does not always expose resourcesPath.
if (!(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath)
  Object.defineProperty(process, 'resourcesPath', { value: path.join(path.dirname(process.execPath), 'resources') });
const chunks: Buffer[] = []; let bytes = 0, refused = false, outputFailed = false;
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 8192) { refused = true; chunks.length = 0; process.exitCode = 2; }
  else if (!refused) chunks.push(Buffer.from(chunk));
});
process.stdin.on('error', () => { refused = true; chunks.length = 0; process.exitCode = 2; });
process.stdin.once('end', () => {
  if (refused) return;
  void startupHistoryWorkerFrame(Buffer.concat(chunks)).then(frame => {
    process.stdout.end(frame, () => { process.exitCode = outputFailed ? 2 : 0; });
  }).catch(() => { process.exitCode = 2; });
});
process.stdout.on('error', () => { outputFailed = true; process.exitCode = 2; });
