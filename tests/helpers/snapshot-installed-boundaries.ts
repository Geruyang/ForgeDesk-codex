import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Independent observer contract. These are compared with the installed producer's
// recorded arguments, not substituted for an observation of the installed app.
export const reviewedInstalledSandboxArgs = [
  '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"',
  '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.writable_roots=[]',
  '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'cli_auth_credentials_store="file"',
  '-c', 'analytics.enabled=false', '-c', 'default_permissions="forgedesk_workspace_v1"',
  '-c', 'permissions.forgedesk_workspace_v1={extends=":workspace",filesystem={":tmpdir"="read",":slash_tmp"="read"},network={enabled=false}}',
  '-c', 'windows.sandbox="unelevated"', 'sandbox', '--include-managed-config',
  '--permission-profile', 'forgedesk_workspace_v1', '--',
] as const;

export function assertInstalledSandboxArgs(value: unknown): asserts value is string[] {
  assert.deepEqual(value, [...reviewedInstalledSandboxArgs], 'Installed producer did not record the exact reviewed no-TEMP workspace profile');
}

export function assertNaturalSnapshotCompletion(operation: { status: string; cleanup: string; exitCode?: number | null; signal?: string | null }): void {
  assert.equal(operation.status, 'succeeded');
  // Runner cleanup reports termination work, not whether close was observed.
  // A successful natural close does not invoke termination and stays not-needed.
  assert.equal(operation.cleanup, 'not-needed', 'Clean baseline must not require forced termination');
  assert.equal(operation.exitCode, 0); assert.equal(operation.signal, null);
}

export async function trustBootstrappedFixture(options: { launch: () => Promise<unknown>; read: () => Promise<Buffer>;
  append: (suffix: Buffer) => Promise<void>; engineeringRoot: string }) {
  // Production bootstrap owns config.toml and replaces pre-launch contents.
  // Modify only the fresh fixture after launch, preserving that managed prefix.
  await options.launch();
  const before = await options.read();
  const text = before.toString('utf8');
  assert.ok(text.startsWith('# ForgeDesk-managed product configuration.'), 'Expected the fresh product bootstrap configuration');
  assert.equal(/^\s*\[projects(?:\.|\])/m.test(text), false, 'Fresh fixture unexpectedly contains a project trust table');
  assert.ok(path.isAbsolute(options.engineeringRoot));
  const trustKey = path.resolve(options.engineeringRoot).toLowerCase();
  const suffix = Buffer.from(`\n[projects.${JSON.stringify(trustKey)}]\ntrust_level = "trusted"\n`, 'utf8');
  await options.append(suffix);
  const after = await options.read();
  assert.ok(after.equals(Buffer.concat([before, suffix])), 'Fixture trust append changed the managed prefix or exact trust suffix');
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return { stage: 'after-installed-bootstrap-and-template-enable' as const, trustKey, beforeBytes: before.length,
    afterBytes: after.length, appendedBytes: suffix.length, beforeSha256: sha256(before), afterSha256: sha256(after),
    appendedSha256: sha256(suffix), managedPrefixPreserved: true, exactTrustReadback: true };
}

export function installedFixtureEnvironment(source: NodeJS.ProcessEnv, dataDir: string, temp: string, tmp: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)', 'USERNAME', 'USERDOMAIN',
    'SESSIONNAME', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  return { ...env, FORGEDESK_DATA_DIR: dataDir, TEMP: temp, TMP: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}

export function isolatedNativeEnvironment(source: NodeJS.ProcessEnv, home: string, temp: string, tmp: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  return { ...env, CODEX_HOME: home, TEMP: temp, TMP: tmp, ELECTRON_RUN_AS_NODE: '1' };
}

export type BoundaryTarget = { kind: string; directory: string; marker: string; database: string; allowed: boolean };
export type BoundaryChildObservation = { kind: string; fs: { created: boolean; errorCode?: string };
  sqlite: { opened: boolean; written: boolean; openErrorCode?: string; writeErrorCode?: string; closeErrorCode?: string } };
export type BoundaryHostObservation = { kind: string; markerPresent: boolean; markerMatches: boolean;
  databasePresent: boolean; sqliteHeader: boolean; auxiliaryPresent: string[]; hostPositiveControl: boolean; cleanupComplete: boolean };

export function boundaryTargets(cwd: string, temp: string, tmp: string, protectedRoot: string, nonce: string): BoundaryTarget[] {
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  return Object.entries({ workspace: cwd, TEMP: temp, TMP: tmp, protected: protectedRoot,
    ...Object.fromEntries(['.git', '.codex', '.agents', '.aws'].map(name => [name, path.join(cwd, name)])) })
    .map(([kind, directory]) => ({ kind, directory, marker: path.join(directory, `.installed-boundary-${nonce}`),
      database: path.join(directory, `.installed-boundary-${nonce}.db`), allowed: kind === 'workspace' }));
}

export function assertBoundaryObservations(targets: BoundaryTarget[], child: unknown, host: BoundaryHostObservation[]): void {
  assert.ok(Array.isArray(child));
  assert.equal(child.length, targets.length); assert.equal(host.length, targets.length);
  assert.deepEqual(child.map(item => item.kind).sort(), targets.map(item => item.kind).sort());
  assert.deepEqual(host.map(item => item.kind).sort(), targets.map(item => item.kind).sort());
  for (const target of targets) {
    const reported = child.find(item => item.kind === target.kind) as BoundaryChildObservation;
    const observed = host.find(item => item.kind === target.kind)!;
    assert.equal(observed.hostPositiveControl, true, `${target.kind}: host write/SQLite positive control missing`);
    assert.equal(observed.cleanupComplete, true, `${target.kind}: cleanup not confirmed`);
    assert.equal(reported.fs.created, target.allowed, `${target.kind}: filesystem result`);
    assert.equal(observed.markerPresent, target.allowed, `${target.kind}: independent filesystem observation`);
    assert.equal(observed.markerMatches, target.allowed, `${target.kind}: marker contents`);
    assert.equal(reported.sqlite.opened, target.allowed, `${target.kind}: SQLite open result`);
    assert.equal(reported.sqlite.written, target.allowed, `${target.kind}: SQLite write result`);
    assert.equal(observed.databasePresent, target.allowed, `${target.kind}: independent SQLite observation`);
    assert.equal(observed.sqliteHeader, target.allowed, `${target.kind}: SQLite header`);
    assert.deepEqual(observed.auxiliaryPresent, [], `${target.kind}: SQLite auxiliary files remain`);
    if (target.allowed) {
      assert.equal(reported.fs.errorCode, undefined);
      assert.equal(reported.sqlite.openErrorCode, undefined); assert.equal(reported.sqlite.writeErrorCode, undefined);
      assert.equal(reported.sqlite.closeErrorCode, undefined);
    } else {
      assert.ok(['EPERM', 'EACCES'].includes(reported.fs.errorCode ?? ''), `${target.kind}: filesystem denial code`);
      assert.ok(['EPERM', 'EACCES', 'ERR_SQLITE_ERROR'].includes(reported.sqlite.openErrorCode ?? ''), `${target.kind}: SQLite must fail at open`);
      assert.equal(reported.sqlite.writeErrorCode, undefined); assert.equal(reported.sqlite.closeErrorCode, undefined);
    }
  }
}

export const installedBoundaryProbeCode = [
  'const fs=require("node:fs"),path=require("node:path"),{DatabaseSync}=require("node:sqlite");',
  'const [nonce,json]=process.argv.slice(1),targets=JSON.parse(json);',
  'const observations=targets.map(t=>{const r={kind:t.kind,fs:{created:false},sqlite:{opened:false,written:false}};',
  'try{fs.writeFileSync(t.marker,nonce,{flag:"wx"});r.fs.created=true;}catch(e){r.fs.errorCode=e.code||"UNKNOWN";}',
  'let db;try{db=new DatabaseSync(process.platform==="win32"?path.toNamespacedPath(t.database):t.database);r.sqlite.opened=true;}catch(e){r.sqlite.openErrorCode=e.code||"UNKNOWN";}',
  'if(db){try{db.exec("CREATE TABLE boundary(value TEXT); INSERT INTO boundary VALUES (\'fixed-positive-control\');");r.sqlite.written=true;}catch(e){r.sqlite.writeErrorCode=e.code||"UNKNOWN";}finally{try{db.close();}catch(e){r.sqlite.closeErrorCode=e.code||"UNKNOWN";}}}',
  'return r;});process.stdout.write(JSON.stringify({schemaVersion:1,nonce,pid:process.pid,nodeVersion:process.versions.node,observations})+"\\n");',
].join('\n');
