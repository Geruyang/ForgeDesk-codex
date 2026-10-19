import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fz3bPrivateAclBatchSync, fz3bPrivateAclSync } from '../../../packages/engineering-runner/fz3b/credentials';
import { readFz3bHostLocalProof, assertFz3bHostLocalProof, type Fz3bHostFinalizationStore, type Fz3bHostLocalProof } from './host-finalization-store';
import { installFailedEmptyIntentRecovery, type CurrentOwnedOperations, type FailedIntentDeployment, type FailedIntentProof } from './host-failed-empty-intent';

declare const __FORGEDESK_FAILED_INTENT_RESOURCE_ROOT__: string;
declare const __FORGEDESK_FAILED_INTENT_MANIFEST_SHA256__: string;
declare const __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__: string;
declare const __FORGEDESK_FAILED_INTENT_POLICY_SHA256__: string;

const approvedRoot = path.resolve('E:/AiProject/agent-design/ForgeDesk-codex/.runtime/app');
const runId = '07427a29-0eae-44c7-ac35-34d6650eebee';
const sessionId = '9309dc73-fb48-4d29-9226-c5496ca2640d';
const originalAbsence = '30d5200a0c40363b2eb8c4a02769ce51f55f758005dd3297be9f46a3e7bfbb18';
const requirement = Object.freeze({ runId, sourceName: 'fz3b-host-empty-8104f45cce47e24a6cb06ba756a118f2df979d7bbd1922b30bdebf7b3da9cebf.intent.json', failureEvidenceSha256: 'dda40e380782f2578c7261de3a052a689378e42699ebaeff390d8f2854f4887c' });
export function incidentFailedIntentRequired(root: string, currentRunId: string): boolean { return path.resolve(root).toLowerCase() === approvedRoot.toLowerCase() && currentRunId === runId; }
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new Error(`FZ3B_FAILED_EMPTY_INTENT_MAIN_${code}`); }
function pinnedRead(file: string, maximum: number): Buffer {
  let current = path.resolve(file);
  for (;;) { const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) fail('LINK'); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  const named = fs.lstatSync(file); if (!named.isFile() || named.nlink !== 1 || named.size < 1 || named.size > maximum) fail('FILE');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const same = (stat: fs.Stats) => stat.dev === named.dev && stat.ino === named.ino && stat.nlink === named.nlink && stat.size === named.size && stat.ctimeMs === named.ctimeMs && stat.mtimeMs === named.mtimeMs;
    if (!same(fs.fstatSync(descriptor))) fail('FILE_CHANGED'); const bytes = fs.readFileSync(descriptor);
    if (!same(fs.fstatSync(descriptor)) || !same(fs.lstatSync(file)) || bytes.length !== named.size) fail('FILE_CHANGED'); return bytes;
  } finally { fs.closeSync(descriptor); }
}
export interface FailedIntentMainComposition {
  root: string; sid: string; packaged: boolean; resourcesPath: string; store: Fz3bHostFinalizationStore;
  assertCurrentScope(): void;
  assertOwner(owner: FailedIntentProof['completion']['owner']): Promise<void>;
}
/** Exact root/run recovery policy reviewed for this incident. The immutable requirement is never cleared. */
export function composeIncidentFailedIntentRecovery(options: FailedIntentMainComposition): void {
  if (path.resolve(options.root).toLowerCase() !== approvedRoot.toLowerCase()) return;
  if (typeof __FORGEDESK_FAILED_INTENT_RESOURCE_ROOT__ === 'undefined' || typeof __FORGEDESK_FAILED_INTENT_MANIFEST_SHA256__ === 'undefined' ||
      typeof __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__ === 'undefined' || typeof __FORGEDESK_FAILED_INTENT_POLICY_SHA256__ === 'undefined') fail('BUILD_PINS_REQUIRED');
  const resourceRoot = options.packaged ? path.join(options.resourcesPath, 'host-failed-empty-intent') : __FORGEDESK_FAILED_INTENT_RESOURCE_ROOT__;
  const verifyResource = () => {
    if (!path.isAbsolute(resourceRoot) || fs.readdirSync(resourceRoot).sort().join(',') !== 'FailedEmptyIntentHelper.exe,manifest.json') fail('RESOURCE_CLOSED_INVENTORY');
    const manifestBytes = pinnedRead(path.join(resourceRoot, 'manifest.json'), 65536);
    if (sha(manifestBytes) !== __FORGEDESK_FAILED_INTENT_MANIFEST_SHA256__) fail('MANIFEST_PIN');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (Object.keys(manifest).sort().join(',') !== 'executableSha256,policySourceSha256,protocol,schemaVersion' || manifest.schemaVersion !== 1 || manifest.protocol !== 'fz3b-failed-empty-intent-v1' || manifest.policySourceSha256 !== __FORGEDESK_FAILED_INTENT_POLICY_SHA256__ || manifest.executableSha256 !== __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__) fail('RESOURCE_PIN');
    const executable = pinnedRead(path.join(resourceRoot, 'FailedEmptyIntentHelper.exe'), 1048576);
    if (sha(executable) !== __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__) fail('RESOURCE_PIN'); return { manifestBytes, executable };
  };
  const resources = verifyResource();
  const cacheParent = path.join(options.root, 'fz3b-host-maintenance-helper-v1');
  const cache = path.join(cacheParent, `${__FORGEDESK_FAILED_INTENT_POLICY_SHA256__.slice(0, 16)}-${__FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__.slice(0, 16)}`);
  for (const directory of [cacheParent, cache]) {
    if (!fs.existsSync(directory)) { fs.mkdirSync(directory); fz3bPrivateAclSync(directory, options.sid, true); }
    const info = fs.lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail('CACHE_DIRECTORY');
    fz3bPrivateAclBatchSync([directory], options.sid);
  }
  const existingCache = fs.readdirSync(cache).sort();
  if (existingCache.length && existingCache.join(',') !== 'FailedEmptyIntentHelper.exe,manifest.json') fail('CACHE_INCOMPLETE');
  if (!existingCache.length) {
    for (const [name, bytes] of [['FailedEmptyIntentHelper.exe', resources.executable], ['manifest.json', resources.manifestBytes]] as const) {
      const file = path.join(cache, name), descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      try { fz3bPrivateAclSync(file, options.sid, true); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
  }
  const deployment: FailedIntentDeployment = { executable: path.join(cache, 'FailedEmptyIntentHelper.exe'), executableSha256: __FORGEDESK_FAILED_INTENT_EXECUTABLE_SHA256__,
    candidateSourceSha256: __FORGEDESK_FAILED_INTENT_POLICY_SHA256__, approvedIsolationSourceSha256s: [__FORGEDESK_FAILED_INTENT_POLICY_SHA256__] };
  const assertDeployment = () => {
    verifyResource();
    if (fs.readdirSync(cache).sort().join(',') !== 'FailedEmptyIntentHelper.exe,manifest.json' || sha(pinnedRead(path.join(cache, 'manifest.json'), 65536)) !== __FORGEDESK_FAILED_INTENT_MANIFEST_SHA256__ || sha(pinnedRead(deployment.executable, 1048576)) !== deployment.executableSha256) fail('CACHE_PIN');
    fz3bPrivateAclBatchSync([cacheParent, cache, path.join(cache, 'manifest.json'), deployment.executable], options.sid);
  };
  const children = new Map<ChildProcessWithoutNullStreams, { closed: boolean; code?: number | null; signal?: NodeJS.Signals | null }>();
  const captures = new WeakMap<object, string>();
  let active: ChildProcessWithoutNullStreams | undefined;
  const assertIdle = () => {
    options.assertCurrentScope();
    for (const [child, state] of children) if (!state.closed && child !== active) fail('UNRESOLVED_OWNED_CHILD');
  };
  const assertProof = (proof: FailedIntentProof) => {
    assertFz3bHostLocalProof(options.store, proof as Fz3bHostLocalProof);
    if (proof.completion.owner.runId !== runId || proof.completion.owner.taskId !== sessionId || proof.completion.owner.sessionId !== sessionId) fail('INCIDENT_OWNER');
  };
  installFailedEmptyIntentRecovery({ root: options.root, deployment,
    readProof: async requested => { if (requested !== runId) fail('INCIDENT_RUN'); const proof = await readFz3bHostLocalProof(options.store, requested); assertProof(proof); return proof; },
    assertProof, assertOwner: options.assertOwner, assertPrivateDeployment: assertDeployment,
    requirements: () => [requirement],
    captureCurrentOwnedIdle: () => {
      assertIdle(); if (active && !children.get(active)?.closed) fail('OWNED_CHILD_ALREADY_ACTIVE');
      const capture = Object.freeze({ schemaVersion: 1, runId, mainPid: process.pid, currentOwnedOperationsIdle: true, priorAppAbsenceEvidenceSha256: originalAbsence,
        historicalChildExitUnproved: true, requirement });
      const result = { capture, sha256: sha(JSON.stringify(capture)) }; captures.set(result, result.sha256); return result;
    },
    assertCurrentOwnedIdle: (capture: CurrentOwnedOperations) => {
      assertIdle(); if (captures.get(capture) !== capture.sha256 || sha(JSON.stringify(capture.capture)) !== capture.sha256) fail('CURRENT_CAPTURE_PROVENANCE');
    },
    ownChild: child => {
      assertIdle(); if (active && !children.get(active)?.closed || children.has(child)) fail('OWNED_CHILD_COLLISION');
      children.set(child, { closed: false }); active = child;
    },
    recordChildClose: (child, code, signal) => {
      const state = children.get(child); if (!state || state.closed || child !== active) fail('OWNED_CHILD_CLOSE_PROVENANCE');
      state.closed = true; state.code = code; state.signal = signal; active = undefined;
    },
  });
}
