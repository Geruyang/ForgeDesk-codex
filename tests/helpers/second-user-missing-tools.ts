import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertSecondDesktop, type DesktopIdentity, type SnapshotSmokeScope } from './snapshot-smoke-scope';

export const approvedMissingToolsSid = 'S-1-5-21-1196670755-766692816-2897134863-1006';

export function missingToolsGateEnvironment(environment: NodeJS.ProcessEnv, argv: string[]): NodeJS.ProcessEnv {
  assert.equal(argv.length, 2, 'Missing-tools entry accepts no identity, path or mode arguments');
  for (const [key, value] of Object.entries(environment)) {
    if (value && (/^FORGEDESK_(?:SNAPSHOT|MISSING_TOOLS)_/i.test(key) ||
      /^(?:FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i.test(key))) {
      assert.fail(`Open a clean second-user PowerShell; remove ambient ${key}`);
    }
  }
  return { ...environment, FORGEDESK_SNAPSHOT_SECOND_USER: '1', FORGEDESK_SNAPSHOT_REAL_MODEL: '1' };
}

export function assertMissingToolsDesktop(identity: DesktopIdentity): void {
  assertSecondDesktop(identity);
  assert.equal(identity.sid, approvedMissingToolsSid, 'BLOCKED: only the approved ForgeDeskTest SID 1006 may run this smoke');
}

export function missingToolsPaths(scope: SnapshotSmokeScope) {
  assert.equal(scope.secondUser, true, 'Missing-tools smoke never supports the primary or development scope');
  assert.ok(scope.identity && scope.installed, 'Missing-tools smoke requires the verified installed second-user scope');
  assertMissingToolsDesktop(scope.identity);
  const runtime = path.join(scope.runtime, 'missing-tools');
  return { runtime, workspace: path.join(runtime, 'workspace'), emptyPath: path.join(runtime, 'empty-path'),
    verifier: path.join(runtime, 'trusted-verifier.mjs'),
    output: path.join(scope.root, 'output', 'second-user', scope.identity.sid, 'evidence', 'missing-tools', scope.runId) };
}

export function missingToolsAppEnvironment(environment: NodeJS.ProcessEnv, emptyPath: string, dataDir: string): Record<string, string> {
  assert.ok(path.isAbsolute(emptyPath) && path.isAbsolute(dataDir), 'Child environment requires exact absolute owned paths');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !/^(?:PATH|FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i.test(key)) result[key] = value;
  }
  return { ...result, PATH: emptyPath, FORGEDESK_DATA_DIR: dataDir };
}

export async function assertMissingToolsPlainPath(root: string, filename: string): Promise<void> {
  const relative = path.relative(root, filename);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Missing-tools output escaped the project');
  const parsed = path.parse(filename); let current = parsed.root;
  for (const part of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { assert.equal((await lstat(current)).isSymbolicLink(), false, 'Missing-tools paths cannot contain reparse points'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function assertMissingGitResult(result: { rejected: boolean; error: string }): void {
  assert.equal(result.rejected, true, 'Missing Git must reject, never return an empty successful diff');
  assert.match(result.error, /无法读取 Git 差异/);
  assert.match(result.error, /spawn git ENOENT/, 'A repository/configuration error is not a missing executable result');
}

export function assertMissingNodeResult(result: { rejected: boolean; error: string }): void {
  assert.equal(result.rejected, true, 'Missing Node must reject before configuring or executing the verifier');
  assert.match(result.error, /Executable not found: node(?:\b|$)/);
}

export function assertAcceptanceUnchanged(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const key of ['acceptance', 'profileRevision', 'snapshotProfile', 'operations', 'evidence', 'status', 'updatedAt']) {
    assert.deepEqual(after[key], before[key], `Missing-tool rejection changed task ${key}`);
  }
}
