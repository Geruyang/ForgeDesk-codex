import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root } from './ssh_script_receipt.mjs';

const py = 'C:/Users/ruyangge/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const base = 'output/hardware/2026-10-16-continuation';
const manifestPath = path.join(root, base, 'deployment-bundle-v2/manifest.json');
const approved = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09';
const sha = b => createHash('sha256').update(b).digest('hex');
if (sha(fs.readFileSync(manifestPath)) !== approved) throw new Error('Approved manifest changed');
execFileSync(py, ['-I', '-B', 'engineering/fz3b/tools/prepare_deployment.py', 'verify',
  '--manifest', manifestPath, '--bundle', `${base}/deployment-bundle-v2/data.tar`,
  '--base-archive', `${base}/canonical-baseline-v2/upstream-application-gitcanonical.tar`,
  '--expected-manifest-sha256', approved], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const runId = `ps-security-${Date.now()}`;
const out = path.join(root, base, 'live-plan', runId);
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const request = { schema: 1, mode: 'deploy', run_id: runId, expected_sha256: {}, payloads: {} };
for (const entry of manifest.files.filter(x => x.role !== 'reference-only')) {
  const raw = fs.readFileSync(path.join(root, base, 'release-source-v2', entry.path));
  if (sha(raw) !== entry.new_sha256) throw new Error('Payload mismatch');
  request.expected_sha256[entry.target] = entry.base_sha256;
  request.payloads[entry.target] = raw.toString('base64');
}
request.expected_sha256['config.json'] = 'd20110909e8e4c578f85bfbc200383e349df6f01b1db8c47822647ca93e3b452';
const requestPath = path.join(out, 'request.json');
fs.writeFileSync(requestPath, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
const transaction = path.join(root, 'engineering/fz3b/tools/ps_security_transaction.py');
if (sha(fs.readFileSync(transaction)) !== '9b0bf3212e10fd539872e8976814474edac0df4611655d8b01cafea8202b3a02') throw new Error('Reviewed transaction changed');
const generated = execFileSync(py, ['-B', transaction, '--emit', requestPath, '--output', path.join(out, 'deploy.py'), '--approved-manifest', manifestPath], { cwd: root }).toString();
fs.writeFileSync(path.join(out, 'generation.json'), generated, { flag: 'wx' });
const tcp = fs.readFileSync(path.join(root, 'engineering/fz3b/tools/fixed_tcp_acceptance.py'), 'utf8');
if (sha(Buffer.from(tcp)) !== '460bae822a42262c610541ef5e2b45423e588d3b43e749327a98aed8cc818710') throw new Error('Reviewed TCP checks changed');
for (const mode of ['status', 'negative', 'one-image']) {
  if (tcp.split("DEFAULT_MODE = 'status'").length !== 2) throw new Error('Unexpected default mode declaration');
  fs.writeFileSync(path.join(out, `${mode}.py`), tcp.replace("DEFAULT_MODE = 'status'", `DEFAULT_MODE = '${mode}'`), { flag: 'wx' });
}
const record = { runId, output: path.relative(root, out), manifestSha256: approved, deployPayloadSha256: sha(fs.readFileSync(path.join(out, 'deploy.py'))), createdAt: new Date().toISOString(), executed: false };
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(record));
