import { spawn } from 'node:child_process';
import net from 'node:net';
import { crc32 } from 'node:zlib';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './ssh_script_receipt.mjs';

const priv = path.join(root, '.runtime/fz3b-private');
const known = path.join(priv, 'known_hosts');
if (fs.readFileSync(known, 'utf8').trim() !== '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ') throw new Error('Host pin mismatch');
for (const port of [8765, 8766]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
  });
}
const out = path.join(root, 'output/hardware/2026-10-16-continuation/tunnel-live', String(Date.now()));
fs.mkdirSync(out, { recursive: true });
const record = { started: new Date().toISOString(), hostTrust: 'TOFU-continuity', checks: [], closed: false };
const save = () => fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(record, null, 2) + '\n');
const args = ['-F', 'NUL', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes',
  '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
  '-i', path.join(priv, 'fz3b_acceptance_ed25519'),
  '-L', '127.0.0.1:8765:127.0.0.1:8765', '-L', '127.0.0.1:8766:127.0.0.1:8766', 'root@169.254.220.254'];
const child = spawn('ssh.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', closed = false;
child.stderr.on('data', b => { if (stderr.length < 16384) stderr += b.toString(); });
child.on('error', e => { record.error = e.code; save(); });
child.on('close', code => { closed = true; record.closed = true; record.exitCode = code; record.ended = new Date().toISOString(); save(); fs.writeFileSync(path.join(out, 'ssh.stderr.log'), stderr); });
function hello(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('HELLO deadline')), 6000);
    function finish(error, value) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); }
    socket.on('error', error => finish(error));
    socket.on('connect', () => {
      const payload = Buffer.from('{"op":"hello","protocol":1}');
      const h = Buffer.alloc(16); h.write('FZVA'); h[4] = 1; h[5] = 1;
      h.writeUInt32LE(payload.length, 8); h.writeUInt32LE(crc32(payload), 12);
      socket.write(Buffer.concat([h, payload]));
    });
    socket.on('data', b => {
      data = Buffer.concat([data, b]);
      if (data.length > 1024 * 1024) return finish(new Error('HELLO extent'));
      if (data.length < 16) return;
      const size = data.readUInt32LE(8);
      if (data.subarray(0, 4).toString() !== 'FZVA' || data[4] !== 1 || data[5] !== 1 || size > 65536) return finish(new Error('HELLO header'));
      if (data.length < 16 + size) return;
      const payload = data.subarray(16, 16 + size);
      if (crc32(payload) !== data.readUInt32LE(12)) return finish(new Error('HELLO CRC'));
      try {
        const value = JSON.parse(payload);
        if (value.type !== 'hello' || value.ok !== true || value.protocol !== 1 || value.contract_id !== '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e') throw new Error('HELLO identity');
        finish(null, { port, bootId: value.boot_id, contract: value.contract_id, inference: value.inference, queryRevision: value.query_revision });
      } catch (e) { finish(e); }
    });
  });
}
async function check() {
  const results = [];
  for (const port of [8765, 8766]) results.push(await hello(port));
  record.checks.push({ at: new Date().toISOString(), results }); save();
  console.log(JSON.stringify({ result: 'tunnel-hello-passed', evidence: path.join(out, 'evidence.json'), results }));
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  if (line.trim() === 'close') { input.close(); child.kill(); }
  else if (line.trim() === 'check') { try { await check(); } catch (e) { console.log(JSON.stringify({ error: e.message })); } }
});
input.on('close', () => { if (!closed) child.kill(); });
const max = setTimeout(() => { input.close(); child.kill(); }, 30 * 60 * 1000);
child.once('close', () => { clearTimeout(max); input.close(); });
await new Promise(resolve => setTimeout(resolve, 2000));
try { if (closed) throw new Error('SSH exited'); await check(); } catch (e) { record.error = e.message; save(); input.close(); child.kill(); process.exitCode = 1; }
