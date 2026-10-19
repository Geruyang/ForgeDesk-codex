import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('real SSH late-clock guard refuses invalid windows, admits the positive boundary and samples once', async () => {
  const raw = await readFile(new URL('./worker.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('worker.ts', raw, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'ProductionFz3bAdapter')!;
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'ssh')!;
  const source = ts.transpileModule('class Fixture {' + method.getText(tree) + '}; Fixture.prototype.ssh;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const expires = '2026-10-17T00:05:00.000Z';
  for (const clock of [NaN, Infinity, -Infinity, Date.parse(expires), Date.parse(expires) - 300001, Date.parse(expires) - 1]) {
    let spawns = 0, samples = 0;
    const ssh = runInNewContext(source, { path, process: { platform: 'win32', env: { SystemRoot: 'C:/OfflineWindows' } },
      fz3bSshEnvironment: () => ({ ProgramData: 'C:/OfflineProgramData' }), noLinks: async () => {},
      lstat: async () => ({ isFile: () => true, isDirectory: () => true }),
      spawn: () => { spawns++; throw Error('Unexpected mocked spawn'); }, fixedFz3bSshArgs: () => [],
      Buffer, setTimeout, clearTimeout, DEADLINE: { semantic: 240000 } });
    const pending = ssh.call({ options: { processHost: 'C:/OfflineProcessHost.exe' }, now: () => { samples++; return clock; } },
      'semantic', Buffer.alloc(0), 'offline-key-not-read', 'offline-known-hosts', 'offline-directory', expires);
    if (clock === Date.parse(expires) - 1) { await assert.rejects(pending, /Unexpected mocked spawn/); assert.equal(spawns, 1); }
    else { const result = await pending; assert.equal(result.spawned, false); assert.equal(spawns, 0); }
    assert.equal(samples, 1);
  }
});
