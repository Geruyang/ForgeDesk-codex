import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { open as openInspector, close as closeInspector } from 'node:inspector';
import { WASI } from 'node:wasi';

const [inputRoot, outputRoot, nonce, stage] = process.argv.slice(2);
if (!inputRoot || !outputRoot || !nonce || !['build', 'verify'].includes(stage)) throw new Error('Permission probe arguments are required');
function denied(action, codes = ['ERR_ACCESS_DENIED']) {
  try { action(); return false; } catch (error) { return codes.includes(error?.code); }
}
const marker = '.runner-write-probe-' + nonce;
const inputWriteDenied = denied(() => writeFileSync(path.join(inputRoot, marker), 'probe', { flag: 'wx' }));
const childProcessDenied = denied(() => spawn(process.execPath, ['-e', 'process.exit(0)']));
const workerDenied = denied(() => new Worker('0', { eval: true }));
const addonDenied = denied(() => process.dlopen({ exports: {} }, process.execPath), ['ERR_DLOPEN_DISABLED']);
const wasiDenied = denied(() => new WASI({ version: 'preview1', args: [], env: {}, preopens: {} }));
const inspectorDenied = denied(() => { openInspector(0, '127.0.0.1'); closeInspector(); });
let outputWriteAllowed = false;
const outputWriteDenied = denied(() => {
  const filename = path.join(outputRoot, marker);
  writeFileSync(filename, 'probe', { flag: 'wx' }); unlinkSync(filename); outputWriteAllowed = true;
});
const passed = inputWriteDenied && childProcessDenied && workerDenied && addonDenied && wasiDenied && inspectorDenied &&
  (stage === 'build' ? outputWriteAllowed && !outputWriteDenied : outputWriteDenied && !outputWriteAllowed);
console.log('FORGEDESK_PERMISSION_RECEIPT:' + JSON.stringify({ schemaVersion: 1, nonce, stage, inputWriteDenied,
  outputWriteAllowed, outputWriteDenied, childProcessDenied, workerDenied, addonDenied, wasiDenied, inspectorDenied, passed }));
if (!passed) process.exitCode = 1;
