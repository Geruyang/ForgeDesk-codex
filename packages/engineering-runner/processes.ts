import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CommandSpec, ToolIdentity } from './types.js';
import { hashFile } from './fingerprint.js';
import { redact, boundedLog } from './redaction.js';
import { commandEnvironment } from './environment.js';
export { commandEnvironment } from './environment.js';

export async function resolveExecutable(executable: string): Promise<string> {
  const candidates = path.isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(path.delimiter)
    .flatMap(directory => [path.join(directory, executable), ...(process.platform === 'win32' && !path.extname(executable)
      ? ['.exe', '.com'].map(extension => path.join(directory, executable + extension)) : [])]);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const resolved = await realpath(candidate);
      if (/\.(bat|cmd|ps1)$/i.test(resolved)) throw new Error('Shell scripts require a user-configured executable interpreter; shell:false is mandatory');
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Executable not found: ${executable}`);
}

export async function toolIdentity(executable: string, processHost?: string): Promise<ToolIdentity> {
  const hashed = await hashFile(executable);
  const managed = process.platform === 'win32' && processHost ? await resolveExecutable(processHost) : undefined;
  const hostHash = managed ? await hashFile(managed) : undefined;
  const version = await new Promise<string>(resolve => execFile(managed ?? executable, managed ? ['--', executable, '--version'] : ['--version'], {
    shell: false, windowsHide: true, timeout: 3000, maxBuffer: 8192, env: commandEnvironment(),
  }, (error, stdout, stderr) => resolve(redact((stdout || stderr || (error ? 'version unavailable' : '')).toString()).slice(0, 4096).trim())));
  return { executable, sha256: hashed.sha256, version, ...(managed && hostHash ? { processHost: { executable: managed, sha256: hostHash.sha256 } } : {}) };
}

export interface ProcessControl { cancelled: boolean; child?: ChildProcess; terminate?: () => Promise<boolean> }
export interface ProcessResult {
  exitCode: number | null; signal: string | null; output: string; timedOut: boolean;
  cancelled: boolean; cleanup: 'not-needed' | 'confirmed' | 'unconfirmed'; error?: string;
}

async function terminateTree(child: ChildProcess, nativeHost: boolean): Promise<boolean> {
  if (!child.pid) return true;
  if (nativeHost) return child.kill();
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => execFile(executable, ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, timeout: 5000, env: commandEnvironment(),
    }, error => resolve(!error)));
  }
  try { process.kill(-child.pid, 'SIGKILL'); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function execute(command: CommandSpec, control: ProcessControl, processHost?: string, trustedEnvironment?: { CODEX_HOME: string }): Promise<ProcessResult> {
  if (control.cancelled) return { exitCode: null, signal: null, output: 'Cancelled before process start', timedOut: false,
    cancelled: true, cleanup: 'not-needed' };
  const managed = process.platform === 'win32' && processHost ? await resolveExecutable(processHost) : undefined;
  return new Promise(resolve => {
    const limit = 256 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    let dropped = false;
    let timedOut = false;
    let cleanup: ProcessResult['cleanup'] = 'not-needed';
    let errorMessage: string | undefined;
    let termination: Promise<boolean> | undefined;
    const child = spawn(managed ?? command.executable, managed ? ['--', command.executable, ...command.args] : command.args, {
      cwd: command.cwd, shell: false, windowsHide: true, env: { ...commandEnvironment(), ...trustedEnvironment },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    control.child = child;
    const append = (chunk: Buffer) => {
      if (total >= limit) { dropped = true; return; }
      const allowed = Math.min(chunk.length, limit - total);
      chunks.push(chunk.subarray(0, allowed)); total += allowed;
      if (allowed < chunk.length) dropped = true;
    };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    control.terminate = () => {
      termination ??= terminateTree(child, !!managed).then(confirmed => { cleanup = confirmed ? 'confirmed' : 'unconfirmed'; return confirmed; });
      return termination;
    };
    const timer = setTimeout(() => { timedOut = true; void control.terminate!(); }, command.timeoutMs ?? 120000);
    child.on('error', error => { errorMessage = error.message; });
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer);
      if (termination) await termination;
      if (control.child === child) { control.child = undefined; control.terminate = undefined; }
      const output = boundedLog(Buffer.concat(chunks).toString('utf8') + (dropped ? '\n[OUTPUT TRUNCATED AT 256 KiB]\n' : ''));
      resolve({ exitCode, signal, output, timedOut, cancelled: control.cancelled, cleanup, error: errorMessage });
    });
    if (control.cancelled) void control.terminate();
  });
}
