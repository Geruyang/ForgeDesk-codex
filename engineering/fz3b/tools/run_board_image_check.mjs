import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const privateRoot = path.join(root, '.runtime/fz3b-private');
const source = path.join(root, 'output/hardware/2026-10-16-continuation/board-baseline/1792117963050/board-image-check-payload.py');
const runDir = path.join(root, 'output/hardware/2026-10-16-continuation/board-image-live', String(Date.now()));
const knownHosts = path.join(privateRoot, 'known_hosts');
const pin = '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ';
if (fs.readFileSync(knownHosts, 'utf8').trim() !== pin) throw new Error('Host-key continuity mismatch');
const script = fs.readFileSync(source);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(runDir, { recursive: true });
const args = ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=NUL',
  '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1',
  '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-i', path.join(privateRoot, 'fz3b_acceptance_ed25519'),
  'root@169.254.220.254', 'python3 -B -'];
const started = new Date().toISOString();
const child = spawn('ssh.exe', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', failure = null;
const timer = setTimeout(() => { failure = 'SSH deadline'; child.kill(); }, 30000);
for (const [stream, limit, key] of [[child.stdout, 128 * 1024, 'stdout'], [child.stderr, 16384, 'stderr']]) {
  stream.on('data', bytes => {
    const current = key === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(current) + bytes.length > limit) { failure = `${key} limit`; child.kill(); }
    else if (key === 'stdout') stdout += bytes.toString('utf8');
    else stderr += bytes.toString('utf8');
  });
}
child.on('error', error => { failure = error.code ?? 'spawn failed'; });
child.stdin.on('error', () => { failure ??= 'stdin closed'; });
child.stdin.end(script);
const [exitCode, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
clearTimeout(timer);
let observation = null;
try { observation = JSON.parse(stdout); } catch { failure ??= 'Invalid JSON response'; }
const unchanged = sha(script) === sha(fs.readFileSync(source));
const receipt = { started, ended: new Date().toISOString(), exitCode, signal, failure,
  sourceSha256: sha(script), unchanged, authentication: 'project-public-key',
  hostKeyTrust: 'TOFU-observed-continuity', observation,
  result: exitCode === 0 && !failure && unchanged && observation?.passed === true ? 'passed' : 'failed' };
fs.writeFileSync(path.join(runDir, 'stdout.json'), stdout);
fs.writeFileSync(path.join(runDir, 'stderr.log'), stderr);
fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, evidence: path.join(runDir, 'evidence.json') }, null, 2));
process.exitCode = receipt.result === 'passed' ? 0 : 1;
