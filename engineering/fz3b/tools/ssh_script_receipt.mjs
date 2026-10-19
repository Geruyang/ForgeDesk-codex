import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SSH_CLEANUP_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 32768;

// The returned spawn handle is the only process this capture may signal. It never retries SSH.
export async function captureOwnedSsh(script, args, {
  timeoutMs = 30000, spawnChild = spawn,
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid SSH deadline');
  if (!Buffer.isBuffer(script) || script.length > MAX_STDOUT_BYTES) throw new Error('Invalid script buffer');
  return new Promise(resolve => {
    const output = { stdout: Buffer.alloc(MAX_STDOUT_BYTES), stderr: Buffer.alloc(MAX_STDERR_BYTES) };
    const sizes = { stdout: 0, stderr: 0 };
    let child, deadline, cleanup, settled = false, failure = null;
    let closeConfirmed = false, exitCode = null, signal = null, exitObserved = false;
    let killAttempted = false, killReturned = null, killError = null, cleanupDeadlineExceeded = false;
    let signaling = false, completeAfterSignal = false;

    function complete() {
      if (settled) return;
      if (signaling) { completeAfterSignal = true; return; }
      settled = true;
      if (deadline !== undefined) timers.clearTimeout(deadline);
      if (cleanup !== undefined) timers.clearTimeout(cleanup);
      const stdout = output.stdout.subarray(0, sizes.stdout).toString('utf8');
      const stderr = output.stderr.subarray(0, sizes.stderr).toString('utf8');
      let observation = null;
      try { observation = JSON.parse(stdout); } catch { failure ??= 'Non-JSON response'; }
      resolve({ stdout, stderr, exitCode: closeConfirmed ? exitCode : null,
        signal: closeConfirmed ? signal : null, failure, observation,
        remoteOutcomeUnknown: !closeConfirmed || exitCode !== 0 || failure !== null,
        sshCloseConfirmed: closeConfirmed, sshExitObserved: exitObserved,
        localSshPid: Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null,
        killAttempted, killReturn: killReturned, killError,
        captureTimeoutMs: timeoutMs, cleanupTimeoutMs: SSH_CLEANUP_TIMEOUT_MS,
        cleanupDeadlineExceeded });
    }

    function fail(reason) {
      if (settled) return;
      failure ??= reason;
      if (deadline !== undefined) { timers.clearTimeout(deadline); deadline = undefined; }
      if (cleanup === undefined) cleanup = timers.setTimeout(() => {
        cleanupDeadlineExceeded = true;
        complete();
      }, SSH_CLEANUP_TIMEOUT_MS);
      if (!killAttempted && child) {
        killAttempted = true;
        signaling = true;
        try { const returned = child.kill(); killReturned = typeof returned === 'boolean' ? returned : null; }
        catch (error) { killError = String(error?.message ?? error).slice(0, 500); }
        finally {
          signaling = false;
          if (completeAfterSignal) { completeAfterSignal = false; complete(); }
        }
      }
    }

    function collect(stream, chunk, maximum) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximum - sizes[stream];
      if (remaining > 0) {
        const capturedLength = Math.min(bytes.length, remaining);
        bytes.copy(output[stream], sizes[stream], 0, capturedLength);
        sizes[stream] += capturedLength;
      }
      if (bytes.length > remaining) fail(`${stream} limit; remote outcome unknown`);
    }

    try {
      child = spawnChild('ssh.exe', args, { windowsHide: true, cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      failure = `SSH spawn failure: ${String(error?.code ?? error?.message ?? error).slice(0, 500)}`;
      complete();
      return;
    }
    // Retain guarded error handlers after settlement: late stream/process errors must not crash.
    child.on('error', error => fail(`SSH process error: ${String(error?.code ?? error?.message ?? error).slice(0, 500)}`));
    child.on('exit', () => { if (!settled) exitObserved = true; });
    child.on('close', (code, closedSignal) => {
      if (settled) return;
      closeConfirmed = true;
      exitCode = Number.isInteger(code) ? code : null;
      signal = typeof closedSignal === 'string' ? closedSignal : null;
      if (exitCode !== 0 || signal !== null) failure ??= 'SSH closed without a successful exit; remote outcome unknown';
      complete();
    });
    child.stdout.on('data', bytes => collect('stdout', bytes, MAX_STDOUT_BYTES));
    child.stderr.on('data', bytes => collect('stderr', bytes, MAX_STDERR_BYTES));
    child.stdout.on('error', () => fail('SSH stdout error; remote outcome unknown'));
    child.stderr.on('error', () => fail('SSH stderr error; remote outcome unknown'));
    child.stdin.on('error', () => fail('SSH stdin error; remote outcome unknown'));
    deadline = timers.setTimeout(() => fail('SSH deadline; remote outcome unknown'), timeoutMs);
    try { child.stdin.end(script); }
    catch (error) { fail(`SSH stdin write failed: ${String(error?.code ?? error?.message ?? error).slice(0, 500)}`); }
  });
}

export async function runReviewedScript(source, label, timeoutMs = 30000) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid evidence label');
  source = path.resolve(root, source);
  if (!source.startsWith(root + path.sep)) throw new Error('Script outside project');
  const priv = path.join(root, '.runtime/fz3b-private');
  const known = path.join(priv, 'known_hosts');
  if (fs.readFileSync(known, 'utf8').trim() !== '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ') throw new Error('Host continuity mismatch');
  const script = fs.readFileSync(source);
  if (script.length > 1024 * 1024) throw new Error('Script size limit');
  const sha = data => createHash('sha256').update(data).digest('hex');
  const directory = path.join(root, 'output/hardware/2026-10-16-continuation', label, String(Date.now()));
  fs.mkdirSync(directory, { recursive: true });
  const args = ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-i', path.join(priv, 'fz3b_acceptance_ed25519'), 'root@169.254.220.254', 'python3 -B -'];
  const started = new Date().toISOString();
  const { stdout, stderr, ...captured } = await captureOwnedSsh(script, args, { timeoutMs });
  let sourceUnchanged = false;
  try { sourceUnchanged = sha(script) === sha(fs.readFileSync(source)); }
  catch { captured.failure ??= 'Reviewed source could not be rechecked'; captured.remoteOutcomeUnknown = true; }
  if (!sourceUnchanged) { captured.failure ??= 'Reviewed source changed'; captured.remoteOutcomeUnknown = true; }
  const receipt = { started, ended: new Date().toISOString(), source: path.relative(root, source),
    sourceSha256: sha(script), sourceUnchanged,
    authentication: 'project-public-key', hostTrust: 'TOFU-continuity', ...captured };
  fs.writeFileSync(path.join(directory, 'stdout.json'), stdout);
  fs.writeFileSync(path.join(directory, 'stderr.log'), stderr);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ directory, exitCode: receipt.exitCode, failure: receipt.failure,
    sourceUnchanged: receipt.sourceUnchanged, sshCloseConfirmed: receipt.sshCloseConfirmed,
    remoteOutcomeUnknown: receipt.remoteOutcomeUnknown }));
  if (receipt.exitCode !== 0 || receipt.failure || !receipt.sourceUnchanged || !receipt.sshCloseConfirmed) process.exitCode = 1;
  return receipt;
}
