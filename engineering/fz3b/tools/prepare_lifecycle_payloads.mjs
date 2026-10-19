import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './ssh_script_receipt.mjs';
const destination = path.join(root, 'output/hardware/2026-10-16-continuation/live-plan/ps-security-1792122514610');
const bytes = fs.readFileSync(path.join(root, 'engineering/fz3b/tools/service_lifecycle.py'));
if (createHash('sha256').update(bytes).digest('hex') !== 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b') throw new Error('Reviewed lifecycle changed');
const source = bytes.toString('utf8');
const boundary = '\nif __name__ == ';
if (source.split(boundary).length !== 2) throw new Error('Unexpected lifecycle entry point');
const body = source.slice(0, source.indexOf(boundary));
for (const mode of ['stop', 'start']) {
  const trailer = `\nRESULT = lifecycle('${mode}', '5ceb45a3-8903-4efc-9484-ec75c17280df', ${mode === 'start' ? 'dict(APPROVED_HASHES)' : 'None'})\nprint(json.dumps(RESULT, sort_keys=True))\nsys.exit(0 if RESULT['result'] == 'passed' else 2)\n`;
  fs.writeFileSync(path.join(destination, `${mode}-service.py`), body + trailer, { flag: 'wx' });
}
console.log(JSON.stringify({ directory: destination, executed: false }));
