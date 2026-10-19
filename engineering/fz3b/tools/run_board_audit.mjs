import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const privateRoot = path.join(root, '.runtime/fz3b-private');
const source = path.join(root, 'engineering/fz3b/tools/audit_board_readonly.py');
const runDir = path.join(root, 'output/hardware/2026-10-16-continuation/ssh-audit', String(Date.now()));
const pin = '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ';
const knownHosts = path.join(privateRoot, 'known_hosts');
if (fs.readFileSync(knownHosts, 'utf8').trim() !== pin) throw new Error('Observed host-key continuity pin mismatch');
const script = fs.readFileSync(source);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(runDir, { recursive: true });
const args = ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=NUL',
  '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1',
  '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-i', path.join(privateRoot, 'fz3b_acceptance_ed25519'),
  'root@169.254.220.254', 'python3 -B - --include-loader-status'];
const started = new Date().toISOString();
const child = spawn('ssh.exe', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', failure = null;
const timer = setTimeout(() => { failure = 'local SSH audit deadline exceeded'; child.kill(); }, 25000);
child.stdout.on('data', bytes => {
  if (Buffer.byteLength(stdout) + bytes.length > 128 * 1024) { failure = 'stdout limit'; child.kill(); }
  else stdout += bytes.toString('utf8');
});
child.stderr.on('data', bytes => {
  if (Buffer.byteLength(stderr) + bytes.length > 16 * 1024) { failure = 'stderr limit'; child.kill(); }
  else stderr += bytes.toString('utf8');
});
child.stdin.on('error', () => { failure ??= 'SSH stdin closed'; });
child.on('error', error => { failure = error.code ?? 'SSH spawn failed'; });
child.stdin.end(script);
const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
clearTimeout(timer);
let observation = null;
try { observation = JSON.parse(stdout); } catch { failure ??= 'Remote audit did not return JSON'; }
const sourceUnchanged = digest(script) === digest(fs.readFileSync(source));
const receipt = {
  schemaVersion: 1, started, ended: new Date().toISOString(), host: '169.254.220.254', username: 'root',
  authenticationMethod: 'project-public-key', hostKeyTrust: 'TOFU-observed-continuity-not-independent-chip-attestation',
  sourceSha256: digest(script), sourceUnchanged, exitCode: code, signal, failure,
  result: code === 0 && !failure && sourceUnchanged && observation ? 'collected-readonly' : 'failed',
  compute: 'not-attempted', programming: 'not-attempted', serviceActions: 'not-attempted', observation,
};
fs.writeFileSync(path.join(runDir, 'ssh.stderr.log'), stderr);
fs.writeFileSync(path.join(runDir, 'evidence.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ result: receipt.result, evidence: path.join(runDir, 'evidence.json'), observation }, null, 2));
process.exitCode = receipt.result === 'collected-readonly' ? 0 : 1;
