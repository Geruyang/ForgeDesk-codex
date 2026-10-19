import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const host = join(process.cwd(), 'vendor', 'process-host', 'process-host.exe');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await delay(50);
  }
  assert.equal(alive(pid), false, `process ${pid} remained alive`);
}

async function collect(child) {
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { errors += data.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { exitCode, output, errors };
}

async function firstLine(stream) {
  return await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for child output')); }, 5000);
    function cleanup() {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    }
    function onError(error) { cleanup(); reject(error); }
    function onData(data) {
      buffer += data.toString();
      const newline = buffer.indexOf('\n');
      if (newline >= 0) { cleanup(); resolve(buffer.slice(0, newline)); }
    }
    stream.on('data', onData);
    stream.once('error', onError);
  });
}

test('process host preserves arguments and propagates child exit', { skip: process.platform !== 'win32' || !existsSync(host) }, async () => {
  assert.match(process.execPath, / /, 'test requires a target path containing spaces');
  const args = ['one two', 'quote"inside', 'trailing\\'];
  const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(23)';
  const child = spawn(host, ['--', process.execPath, '-e', code, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const result = await collect(child);
  assert.equal(result.exitCode, 23, result.errors);
  assert.deepEqual(JSON.parse(result.output), args);
});

test('killing the host closes the job and removes child and grandchild', { skip: process.platform !== 'win32' || !existsSync(host) }, async () => {
  const code = `const {spawn}=require('node:child_process'); const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({child:process.pid,grandchild:grandchild.pid})); setInterval(()=>{},1000);`;
  const supervisor = spawn(host, ['--', process.execPath, '-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let pids;
  try {
    pids = JSON.parse(await firstLine(supervisor.stdout));
    assert.equal(alive(pids.child), true);
    assert.equal(alive(pids.grandchild), true);
    supervisor.kill();
    await new Promise(resolve => supervisor.once('exit', resolve));
    await waitForGone(pids.child);
    await waitForGone(pids.grandchild);
  } finally {
    if (supervisor.exitCode === null) supervisor.kill();
    for (const pid of [pids?.child, pids?.grandchild]) {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
});

test('parent exit closes the job and removes child and grandchild', { skip: process.platform !== 'win32' || !existsSync(host) }, async () => {
  const workerCode = `const {spawn}=require('node:child_process'); const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({child:process.pid,grandchild:grandchild.pid})); setInterval(()=>{},1000);`;
  const parentCode = `const {spawn}=require('node:child_process'); const host=spawn(process.argv[1],['--',process.execPath,'-e',process.argv[2]],{stdio:['ignore','pipe','pipe'],windowsHide:true}); host.stdout.once('data',data=>{process.stdout.write(data); host.unref(); process.exit(0)});`;
  const parent = spawn(process.execPath, ['-e', parentCode, host, workerCode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let pids;
  try {
    pids = JSON.parse(await firstLine(parent.stdout));
    await new Promise(resolve => parent.once('exit', resolve));
    await waitForGone(pids.child);
    await waitForGone(pids.grandchild);
  } finally {
    if (parent.exitCode === null) parent.kill();
    for (const pid of [pids?.child, pids?.grandchild]) {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
});
