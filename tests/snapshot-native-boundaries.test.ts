import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SANDBOX_ARGS } from '../packages/engine-adapter/snapshot-isolation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = 'const fs=require("node:fs");const items=JSON.parse(process.argv[1]);console.log(JSON.stringify(items.map(x=>{try{fs.writeFileSync(x.path,x.nonce,{flag:"wx"});return {kind:x.kind,allowed:true};}catch(e){return {kind:x.kind,allowed:false,code:e.code};}})));';

test('fixed native snapshot profile excludes distinct TEMP/TMP and retains metadata denial with fresh and historical capabilities', { skip: process.platform !== 'win32' }, async () => {
  const evidenceRoot = path.join(root, 'output/qa/snapshot-native-boundaries'); await mkdir(evidenceRoot, { recursive: true });
  const base = await mkdtemp(path.join(evidenceRoot, 'run-'));
  const executable = path.join(root, 'vendor/codex/codex.exe'); const processHost = path.join(root, 'vendor/process-host/process-host.exe');
  for (const [file, expected] of [[executable, 'e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e'],
    [processHost, '722cfcd0d9ea9d187663c2f58b2e31f3dde2a00500a9aec3471d7ecedbe8d4ab']]) {
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), expected);
  }
  const records: unknown[] = [];
  for (const scenario of ['fresh', 'historical']) {
    const directory = path.join(base, scenario); const cwd = path.join(directory, 'workspace'); const home = path.join(directory, 'home');
    const temp = path.join(directory, 'TEMP with spaces'); const tmp = path.join(directory, 'TMP-测试');
    const protectedRoot = path.join(directory, 'protected');
    const roots = { workspace: cwd, TEMP: temp, TMP: tmp, protected: protectedRoot,
      ...Object.fromEntries(['.git', '.codex', '.agents', '.aws'].map(n => [n, path.join(cwd, n)])) };
    for (const dir of [home, ...Object.values(roots)]) await mkdir(dir, { recursive: true });
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home, ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)']) {
      const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key); if (entry) env[key] = entry[1];
    }
    env.TEMP = temp; env.TMP = tmp;
    for (const baseline of scenario === 'historical' ? [true, false] : [false]) {
      const nonce = randomUUID(); const items = Object.entries(roots).map(([kind, dir]) => ({ kind, path: path.join(dir, `probe-${nonce}`), nonce }));
      const args = [...SNAPSHOT_SANDBOX_ARGS];
      // Reproduce only the old built-in selection against project-owned temporary directories.
      if (baseline) args[args.indexOf('--permission-profile') + 1] = ':workspace';
      const started = Date.now(); let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false;
      const child = spawn(processHost, ['--', executable, ...args, process.execPath, '-e', code, JSON.stringify(items)], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', b => { stdout += b; if (Buffer.byteLength(stdout) > 65536) { overflow = true; child.kill(); } });
      child.stderr.on('data', b => { stderr += b; if (Buffer.byteLength(stderr) > 65536) { overflow = true; child.kill(); } });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
      const exit = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      }).finally(() => clearTimeout(timer));
      const reports = stdout.trim() ? JSON.parse(stdout.trim()) : [];
      const independent = [];
      for (const item of items) {
        let observedWrite = false;
        try { assert.equal(await readFile(item.path, 'utf8'), nonce); observedWrite = true; await unlink(item.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        independent.push({ kind: item.kind, observedWrite, cleaned: true });
      }
      const record = { scenario, baseline, durationMs: Date.now() - started, exit, timedOut, overflow, reports, independent, stderr };
      records.push(record);
      await writeFile(path.join(base, 'evidence.json'), JSON.stringify({ scope: 'Native module boundaries, not installed/model/second-SID acceptance', records }, null, 2));
      assert.equal(timedOut, false); assert.equal(overflow, false); assert.equal(exit.code, 0, stderr); assert.equal(exit.signal, null);
      for (const observation of independent) {
        const report = reports.find((r: {kind: string}) => r.kind === observation.kind);
        assert.equal(report?.allowed, observation.observedWrite);
        assert.equal(observation.observedWrite, observation.kind === 'workspace' || (baseline && ['TEMP', 'TMP'].includes(observation.kind)), `${scenario} baseline=${baseline} ${observation.kind}`);
        if (!observation.observedWrite) assert.ok(['EPERM', 'EACCES'].includes(report.code));
      }
    }
  }
});
