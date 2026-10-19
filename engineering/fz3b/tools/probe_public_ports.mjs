import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './ssh_script_receipt.mjs';
const record = { started: new Date().toISOString(), host: '169.254.220.254', results: [], payloadSent: false };
for (const port of [8765, 8766]) {
  record.results.push(await new Promise(resolve => {
    const socket = net.connect(port, record.host);
    let ended = false;
    const finish = status => { if (!ended) { ended = true; clearTimeout(timer); socket.destroy(); resolve({ port, ...status }); } };
    const timer = setTimeout(() => finish({ reachable: false, observation: 'timeout' }), 3000);
    socket.on('connect', () => finish({ reachable: true, observation: 'connected' }));
    socket.on('error', e => finish({ reachable: false, observation: e.code }));
  }));
}
record.passed = record.results.every(x => !x.reachable);
record.ended = new Date().toISOString();
const directory = path.join(root, 'output/hardware/2026-10-16-continuation/public-ports-live', String(Date.now()));
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ ...record, directory }));
process.exitCode = record.passed ? 0 : 1;
