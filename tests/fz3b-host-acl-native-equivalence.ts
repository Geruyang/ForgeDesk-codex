import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { currentSid, fz3bHostDependencyAclSync, fz3bPrivateAclBatchSync, fz3bPrivateAclSync } from '../packages/engineering-runner/fz3b/credentials';

// Manual, opt-in entry: only fresh project-output directories/files, never product data.
assert.equal(process.env.FORGEDESK_ISOLATED_ACL_CHECK, '1');
assert.equal(process.platform, 'win32');
const project = fs.realpathSync(path.resolve('.'));
assert.equal(path.basename(project), 'ForgeDesk-codex');
const base = path.join(project, 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization/acl-native-equivalence');
fs.mkdirSync(base, { recursive: true });
const home = fs.mkdtempSync(path.join(base, 'run-'));
assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(base));
const system = process.env.SystemRoot ?? 'C:/Windows';
const executable = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sid = await currentSid();
const sourceBytes = fs.readFileSync(path.join(project, 'packages/engineering-runner/fz3b/credentials.ts'));
const source = ts.createSourceFile('credentials.ts', sourceBytes.toString('utf8'), ts.ScriptTarget.Latest, true);
const legacyNode = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === 'PRIVATE_ACL_SCRIPT')); assert.ok(legacyNode);
const legacy = runInNewContext(ts.transpileModule(`${legacyNode.getText(source)}\nPRIVATE_ACL_SCRIPT`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText) as string;
const calls: Array<{ name: string; ms: number; passed: boolean; failure?: string }> = [];
const report: Record<string, unknown> = {
  schemaVersion: 1, scope: 'isolated-project-output-acl-equivalence-not-installed-acceptance',
  home, sid, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  actualProductDataRead: false, actualPrivateBytesRead: false, appModelSshDeviceActions: 0,
  phaseDeadlineMs: 5000, overallMainDeadlineUnchangedMs: 60000, backendReadTicketUnchangedMs: 30000,
  observationLimit: 'Fresh PowerShell processes; not a Windows reboot or a guarantee under arbitrary load.',
};
function timed<T>(name: string, action: () => T): T {
  const start = performance.now();
  try { const result = action(); calls.push({ name, ms: performance.now() - start, passed: true }); return result; }
  catch (error) { calls.push({ name, ms: performance.now() - start, passed: false, failure: String(error) }); throw error; }
}
function native(script: string, file: string, extra: Record<string, string> = {}): string {
  assert.ok(file === home || file.startsWith(`${home}${path.sep}`));
  return execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    timeout: 5000, maxBuffer: 8192, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: system, FORGEDESK_PRIVATE_PATH: file, FORGEDESK_PRIVATE_SID: sid, ...extra },
  });
}
function legacyGate(file: string, expectedSid = sid, update = false): void {
  const script = legacy + ";if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value){throw 'Unexpected private owner'};if($a.Access[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Unexpected private rights'}";
  assert.equal(native(script, file, { FORGEDESK_PRIVATE_SID: expectedSid, FORGEDESK_SET_ACL: update ? '1' : '0' }).trim(), 'FZ3B_PRIVATE_ACL_OK');
}
function descriptor(file: string): string {
  const text = native(`$ErrorActionPreference='Stop';$p=$env:FORGEDESK_PRIVATE_PATH;$attr=[IO.File]::GetAttributes($p);$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access;if(($attr -band [IO.FileAttributes]::Directory) -ne 0){$direct=[IO.Directory]::GetAccessControl($p,$sections)}else{$direct=[IO.File]::GetAccessControl($p,$sections)};$cmdlet=Get-Acl -LiteralPath $p;$a=$direct.GetSecurityDescriptorSddlForm($sections);$b=$cmdlet.GetSecurityDescriptorSddlForm($sections);if($a -cne $b){throw 'Descriptor mismatch'};[Console]::Out.WriteLine($a)`, file);
  return text.trim();
}
function setterScript(file: string): string {
  const helpers = source.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source).startsWith('HOST_ACL_DOTNET_')));
  const method = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fz3bPrivateAclSync'); assert.ok(method);
  let script = '';
  const code = [...helpers.map(node => node.getText(source)), method.getText(source).replace(/^export /, ''), 'fz3bPrivateAclSync;'].join('\n');
  const capture = runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    Buffer, path, process,
    execFileSync: (_file: string, args: string[]) => { script = Buffer.from(args[3], 'base64').toString('utf16le'); return 'FZ3B_PRIVATE_ACL_OK'; },
  }) as (file: string, sid: string, update: boolean) => void;
  capture(file, sid, true); assert.ok(script); return script;
}
function change(file: string, kind: 'read' | 'extra' | 'deny' | 'unprotected' | 'dependency'): void {
  const script = `$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';$p=$env:FORGEDESK_PRIVATE_PATH;$s=[Security.Principal.SecurityIdentifier]::new($env:FORGEDESK_PRIVATE_SID);$d=([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) -ne 0;if($d){$old=[IO.Directory]::GetAccessControl($p);$a=[Security.AccessControl.DirectorySecurity]::new()}else{$old=[IO.File]::GetAccessControl($p);$a=[Security.AccessControl.FileSecurity]::new()};if($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value){throw 'Unexpected fixture owner'};$a.SetAccessRuleProtection($true,$false);$kind=$env:FORGEDESK_FIXTURE_CASE;$rights='FullControl';if($kind -eq 'read'){$rights='Read'};[void]$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,$rights,'Allow'));if($kind -eq 'extra' -or $kind -eq 'deny'){$type='Allow';if($kind -eq 'deny'){$type='Deny'};[void]$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read',$type))};if($kind -eq 'unprotected'){$a.SetAccessRuleProtection($false,$false)};if($kind -eq 'dependency'){foreach($value in @($s.Value,'S-1-5-18','S-1-5-32-544')){[void]$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}};if($d){[IO.Directory]::SetAccessControl($p,$a)}else{[IO.File]::SetAccessControl($p,$a)};[Console]::Out.WriteLine('FIXTURE_CHANGED')`;
  assert.equal(native(script, file, { FORGEDESK_FIXTURE_CASE: kind }).trim(), 'FIXTURE_CHANGED');
}
try {
  // These are the first ACL phases for their respective brand-new empty homes.
  const first = path.join(home, 'first-create'); fs.mkdirSync(first); assert.deepEqual(fs.readdirSync(first), []);
  timed('dotnet-first-create-empty-directory-set-verify', () => fz3bPrivateAclSync(first, sid, true));
  assert.deepEqual(fs.readdirSync(first), []);
  const existing = path.join(home, 'existing-empty'); fs.mkdirSync(existing); assert.deepEqual(fs.readdirSync(existing), []);
  timed('dotnet-existing-empty-directory-set-verify', () => fz3bPrivateAclSync(existing, sid, true));
  assert.deepEqual(fs.readdirSync(existing), []);
  const former = path.join(home, 'legacy-empty'); fs.mkdirSync(former);
  timed('legacy-cmdlet-empty-directory-set-verify', () => legacyGate(former, sid, true));
  assert.equal(timed('dotnet-descriptor-vs-cmdlet-first', () => descriptor(first)), timed('legacy-descriptor-vs-dotnet', () => descriptor(former)));
  const file = path.join(first, "empty ' [file] \u6d4b\u8bd5.txt"); fs.closeSync(fs.openSync(file, 'wx'));
  assert.equal(fs.statSync(file).size, 0);
  timed('dotnet-empty-file-set-verify-before-bytes', () => fz3bPrivateAclSync(file, sid, true));
  assert.equal(fs.statSync(file).size, 0);
  timed('legacy-read-direct-created-file', () => legacyGate(file));
  timed('file-descriptor-equivalence', () => descriptor(file));
  fs.writeFileSync(file, 'synthetic-public-sentinel');
  timed('dotnet-readonly-batch', () => fz3bPrivateAclBatchSync([first, existing, file], sid));
  const negative: string[] = [];
  for (const kind of ['read', 'extra', 'deny', 'unprotected'] as const) {
    const target = path.join(home, `negative-${kind}.txt`); fs.closeSync(fs.openSync(target, 'wx'));
    change(target, kind); const before = descriptor(target);
    timed(`negative-${kind}-both-reject`, () => {
      assert.throws(() => fz3bPrivateAclSync(target, sid, false));
      assert.throws(() => legacyGate(target));
      assert.throws(() => fz3bPrivateAclBatchSync([target], sid));
    });
    assert.equal(descriptor(target), before); assert.equal(fs.statSync(target).size, 0); negative.push(kind);
  }
  timed('wrong-expected-owner-both-reject', () => {
    assert.throws(() => fz3bPrivateAclSync(file, 'S-1-5-18', false));
    assert.throws(() => legacyGate(file, 'S-1-5-18'));
  });
  const beforeOwnerUpdate = descriptor(file), beforeOwnerBytes = fs.readFileSync(file);
  timed('wrong-expected-owner-update-refuses-without-write', () => assert.throws(() => fz3bPrivateAclSync(file, 'S-1-5-18', true)));
  assert.equal(descriptor(file), beforeOwnerUpdate); assert.deepEqual(fs.readFileSync(file), beforeOwnerBytes);
  const readback = path.join(home, 'readback-failure'); fs.mkdirSync(readback);
  const originalScript = setterScript(readback), boundary = ';$a=Read-HostAcl $p};Assert-HostPrivateAcl';
  assert.equal(originalScript.split(boundary).length, 2);
  const tamper = `;$bad=[Security.AccessControl.DirectorySecurity]::new();$bad.SetAccessRuleProtection($true,$false);[void]$bad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'Read','Allow'));[IO.Directory]::SetAccessControl($p,$bad)`;
  const injectedScript = originalScript.replace(boundary, `${tamper}${boundary}`);
  timed('setter-final-readback-rejects-post-set-dacl-change', () => assert.throws(() => native(injectedScript, readback, { FORGEDESK_SET_ACL: '1' }), (error: any) => Number.isInteger(error.status) && error.status !== 0 && !String(error.stdout).includes('FZ3B_PRIVATE_ACL_OK')));
  assert.deepEqual(fs.readdirSync(readback), []);
  const dependency = path.join(home, 'dependency-root'); fs.mkdirSync(dependency);
  change(dependency, 'dependency'); const dependencyAgent = path.join(dependency, 'fz3b-agent'); fs.mkdirSync(dependencyAgent);
  const fakeMac = path.join(dependencyAgent, 'binding.key'); fs.closeSync(fs.openSync(fakeMac, 'wx'));
  // Existing dependency children may inherit the closed current-SID/SYSTEM/Admins ACL.
  const beforeDependency = [dependency, dependencyAgent, fakeMac].map(descriptor);
  timed('dotnet-readonly-dependency-three-fixed-paths', () => fz3bHostDependencyAclSync(dependency, sid));
  assert.deepEqual([dependency, dependencyAgent, fakeMac].map(descriptor), beforeDependency);
  change(dependency, 'extra'); const invalidDependency = descriptor(dependency);
  timed('dependency-untrusted-principal-rejected-without-repair', () => assert.throws(() => fz3bHostDependencyAclSync(dependency, sid)));
  assert.equal(descriptor(dependency), invalidDependency);
  const alias = path.join(home, 'directory-alias'); fs.symlinkSync(first, alias, 'junction'); const beforeAlias = descriptor(first);
  timed('reparse-alias-rejected-before-acl-update', () => {
    assert.throws(() => fz3bPrivateAclSync(alias, sid, true));
    assert.throws(() => fz3bPrivateAclSync(alias, sid, false));
    assert.throws(() => fz3bPrivateAclBatchSync([alias], sid));
  });
  assert.equal(descriptor(first), beforeAlias);
  report.negativeCases = [...negative, 'wrong-expected-owner', 'wrong-owner-update-no-write', 'setter-final-readback', 'dependency-untrusted-principal', 'reparse-alias'];
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  report.calls = calls; report.finishedAt = new Date().toISOString();
  const target = path.join(home, 'evidence.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ report: target, passed: report.passed, calls, error: report.error }));
}
