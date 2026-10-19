import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, runReviewedScript } from './ssh_script_receipt.mjs';

const base = 'output/hardware/2026-10-16-continuation';
const plan = `${base}/live-plan/ps-security-1792122514610`;
const json = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const hash = name => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const assets = json(`${base}/runtime-assets-reviewed-live/1792122906631/evidence.json`);
if (assets.exitCode !== 0 || assets.failure || assets.observation.result !== 'pinned-file-hashes-match' || assets.observation.issues.length) throw new Error('Asset evidence not accepted');
const tunnel = json(`${base}/tunnel-live/1792121714095/evidence.json`);
if (tunnel.closed || tunnel.checks.length < 1 || tunnel.checks[0].results.some(x => x.bootId !== '5ceb45a3-8903-4efc-9484-ec75c17280df' || x.inference.state !== 'STOPPED' || x.inference.error)) throw new Error('Tunnel prerequisite missing');
if (hash('engineering/fz3b/tools/service_lifecycle.py') !== 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b') throw new Error('Lifecycle changed');
if (hash(`${plan}/deploy.py`) !== '0a70d18307c0aac3e05afbd3c09bbd709dd8c793e5edd627dfa2068303e42c3b') throw new Error('Deployment payload changed');
const source = fs.readFileSync(path.join(root, 'engineering/fz3b/tools/service_lifecycle.py'), 'utf8');
for (const mode of ['stop', 'start']) {
  const expected = source.slice(0, source.indexOf('\nif __name__ == ')) + `\nRESULT = lifecycle('${mode}', '5ceb45a3-8903-4efc-9484-ec75c17280df', ${mode === 'start' ? 'dict(APPROVED_HASHES)' : 'None'})\nprint(json.dumps(RESULT, sort_keys=True))\nsys.exit(0 if RESULT['result'] == 'passed' else 2)\n`;
  if (fs.readFileSync(path.join(root, plan, `${mode}-service.py`), 'utf8') !== expected) throw new Error('Lifecycle payload differs');
}
const lock = path.join(root, '.runtime/fz3b-private/active-hardware-acceptance.lock');
const fd = fs.openSync(lock, 'wx');
const record = { runId: 'ps-security-1792122514610', started: new Date().toISOString(), scope: 'normal application stop, exact PS patch, normal start; no PL programming', phases: [], result: 'running' };
fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); fs.closeSync(fd);
const output = path.join(root, plan, 'execution.json');
const save = () => fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
save();
try {
  const stopped = await runReviewedScript(`${plan}/stop-service.py`, 'ps-stop-live', 400000);
  record.phases.push({ phase: 'stop', receipt: stopped }); save();
  if (stopped.exitCode !== 0 || stopped.failure || stopped.observation?.result !== 'passed') throw new Error('Stop not verified; no deployment attempted');
  const deployed = await runReviewedScript(`${plan}/deploy.py`, 'ps-deployment-live', 60000);
  record.phases.push({ phase: 'deploy', receipt: deployed }); save();
  if (deployed.exitCode !== 0 || deployed.failure || deployed.observation?.status !== 'deployed') throw new Error('Deployment not verified; no start attempted');
  const started = await runReviewedScript(`${plan}/start-service.py`, 'ps-start-live', 100000);
  record.phases.push({ phase: 'start', receipt: started }); save();
  if (started.exitCode !== 0 || started.failure || started.observation?.result !== 'passed') throw new Error('Start not verified; no automatic retry or rollback');
  record.result = 'passed-ps-deployment'; record.ended = new Date().toISOString(); save();
  const owned = JSON.parse(fs.readFileSync(lock, 'utf8'));
  if (owned.runId !== record.runId) throw new Error('Outer lock ownership changed');
  fs.unlinkSync(lock);
} catch (error) {
  record.result = 'held-for-root-review'; record.error = error.message; record.ended = new Date().toISOString(); save();
  process.exitCode = 1;
}
console.log(JSON.stringify({ result: record.result, error: record.error, evidence: output }));
