import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { STARTUP_HISTORY_OUTPUT_LIMIT, type StartupHistoryProjection, type StartupHistoryRequest } from './release-recovery-history-worker.js';

// This interface is the existing process-host owned child contract, not arbitrary code execution.
export interface StartupHistoryChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; on(event: 'error', listener: () => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; on(event: 'error', listener: () => void): unknown };
  stdin: { on(event: 'error', listener: () => void): unknown; end(frame: Buffer): unknown };
  kill(): boolean;
}
type Schedule = (callback: () => void, ms: number) => () => void;
const schedule: Schedule = (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); };
const flags = ['admissionAuthorized', 'releaseAuthorized', 'newRunAuthorized', 'activeEpochAdopted', 'currentBootEstablished',
  'automaticReplay', 'strictFinalizationVerified', 'operationalQuarantineVerified'] as const;
type Result = Readonly<{ status: 'observed' | 'held' | 'unknown'; closeConfirmed: boolean; reason: string | null; projection: StartupHistoryProjection | null }>;

function projection(value: any): value is StartupHistoryProjection {
  const keys = ['schemaVersion', 'status', 'observationPhase', 'observation', 'failure', 'suppliedEntriesSha256', 'rows', ...flags];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.schemaVersion !== 1 ||
    value.observationPhase !== 'post-startup-reconciliation' ||
    !flags.every(key => value[key] === false) || !Array.isArray(value.rows) || value.rows.length > 128) return false;
  if (value.status === 'history-read-held') return value.observation === 'unavailable' &&
    value.failure === 'history-read-or-validation-refused' && value.suppliedEntriesSha256 === null && value.rows.length === 0;
  if (value.status !== 'history-only-blocked' || value.observation !== 'stable-existing-json-census' || value.failure !== null ||
    typeof value.suppliedEntriesSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.suppliedEntriesSha256)) return false;
  const names = new Set<string>();
  return value.rows.every((row: any) => {
    const rowKeys = ['filename', 'runId', 'envelopeSha256', 'originalStatus', 'originalPhase', 'originalActive', 'originalHardwareBusy',
      'originalNativeApproval', 'unknownOperations', 'unknownCalls', 'originalHoldReasons', 'operations', 'classification',
      'releaseStructureObserved', 'opaquePreflightHistoryObserved', 'strictFinalizationVerified'];
    if (!row || Object.keys(row).sort().join(',') !== rowKeys.sort().join(',') || typeof row.runId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(row.runId) || row.filename !== row.runId + '.json' || names.has(row.filename) ||
      typeof row.envelopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.envelopeSha256) || row.strictFinalizationVerified !== false ||
      !['active', 'completed', 'stopped', 'needs_attention'].includes(row.originalStatus) || typeof row.originalPhase !== 'string' ||
      typeof row.originalNativeApproval !== 'string' || !['originalActive', 'originalHardwareBusy', 'releaseStructureObserved', 'opaquePreflightHistoryObserved'].every(key => typeof row[key] === 'boolean') ||
      !['unresolved-observed', 'historical-release-structure-unqualified', 'terminal-history-unqualified'].includes(row.classification) ||
      ![row.unknownOperations, row.unknownCalls].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
      !Array.isArray(row.originalHoldReasons) || row.originalHoldReasons.length > 4000 || !row.originalHoldReasons.every((v: unknown) => typeof v === 'string') ||
      !Array.isArray(row.operations) || row.operations.length > 1000) return false;
    names.add(row.filename);
    return row.operations.every((op: any) => op && Object.keys(op).sort().join(',') === 'id,kind,originalStatus' && typeof op.id === 'string' &&
      ['build', 'inspect', 'semantic'].includes(op.kind) && ['prepared', 'running', 'succeeded', 'failed', 'unknown'].includes(op.originalStatus));
  });
}

/** Main-only, single-use. launch must be the pinned process-host child, never renderer-selected. No default launch. */
export function createStartupHistoryAsyncReader(dataDir: string, packaged: boolean, launch: () => StartupHistoryChild,
  timer: Schedule = schedule) {
  if (!path.isAbsolute(dataDir) || dataDir.includes('\0') || typeof packaged !== 'boolean') throw new Error('Startup history trusted configuration');
  const request: StartupHistoryRequest = { schemaVersion: 1, kind: 'startup-history-existing-read', nonce: randomBytes(32).toString('hex'), dataDir, packaged };
  const frame = Buffer.from(JSON.stringify(request) + '\n');
  if (frame.length > 8192) throw new Error('Startup history trusted configuration budget');
  let pending: Promise<Result> | undefined;
  return Object.freeze({ read(): Promise<Result> {
    return pending ??= new Promise(resolve => {
      let child: StartupHistoryChild, spawned = false, finished = false, closing = false, rejected: string | null = null;
      let outputBytes = 0, errorBytes = 0; const output: Buffer[] = [];
      let cancelDeadline = () => {}, cancelClose = () => {};
      const finish = (status: Result['status'], closeConfirmed: boolean, reason: string | null, value: StartupHistoryProjection | null = null) => {
        if (finished) return; finished = true; cancelDeadline(); cancelClose();
        resolve(Object.freeze({ status, closeConfirmed, reason, projection: value }));
      };
      const refuse = (reason: string) => {
        if (closing || finished) return; closing = true; rejected = reason; cancelDeadline();
        // Kill is only a request to the existing Job host. Its return value is never a close witness.
        cancelClose = timer(() => finish('unknown', false, 'owned-worker-close-unconfirmed'), 5000);
        try { child.kill(); } catch { /* Keep waiting for actual close; otherwise unknown. */ }
      };
      try { child = launch(); } catch { finish('unknown', false, 'owned-worker-launch-unconfirmed'); return; }
      child.once('spawn', () => { spawned = true; });
      child.once('error', () => refuse('owned-worker-error'));
      child.stdout.on('error', () => refuse('owned-worker-stdout-error'));
      child.stderr.on('error', () => refuse('owned-worker-stderr-error'));
      child.stdout.on('data', chunk => {
        if (finished) return;
        outputBytes += chunk.length;
        if (outputBytes > STARTUP_HISTORY_OUTPUT_LIMIT) refuse('owned-worker-output-budget'); else output.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => { if (!finished && (errorBytes += chunk.length) > 0) refuse('owned-worker-stderr'); });
      child.stdin.on('error', () => refuse('owned-worker-input-error'));
      child.once('close', (code, signal) => {
        if (finished) return;
        if (rejected || !spawned || code !== 0 || signal !== null || errorBytes > 0) { finish('held', true, rejected ?? 'owned-worker-not-normal-close'); return; }
        try {
          const bytes = Buffer.concat(output), text = bytes.toString('utf8'), response = JSON.parse(text);
          if (!Buffer.from(text).equals(bytes) || JSON.stringify(response) + '\n' !== text ||
            Object.keys(response).sort().join(',') !== 'kind,nonce,projection,schemaVersion' || response.schemaVersion !== 1 ||
            response.kind !== 'startup-history-existing-result' || response.nonce !== request.nonce || !projection(response.projection)) throw Error();
          finish('observed', true, null, response.projection);
        } catch { finish('held', true, 'owned-worker-response-refused'); }
      });
      cancelDeadline = timer(() => refuse('owned-worker-deadline'), 20000);
      try { child.stdin.end(frame); } catch { refuse('owned-worker-input-error'); }
    });
  } });
}
