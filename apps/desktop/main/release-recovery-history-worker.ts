import path from 'node:path';
import { Fz3bBackend } from '../../../packages/engineering-runner/fz3b/backend.js';
import { initializeFz3bHostAclHelper } from '../../../packages/engineering-runner/fz3b/host-acl.js';
import { historicalFz3bProfileDefinitions } from '../../../packages/engineering-runner/fz3b/profile-history.js';
import { readReleaseRecoveryHistory } from './release-recovery-history.js';

export type StartupHistoryProjection = Awaited<ReturnType<typeof readReleaseRecoveryHistory>>;
export const STARTUP_HISTORY_OUTPUT_LIMIT = 2 * 1024 * 1024;
export interface StartupHistoryRequest { schemaVersion: 1; kind: 'startup-history-existing-read'; nonce: string; dataDir: string; packaged: boolean }

/** Child-only composition. Constructor does not initialize the ledger; no operational adapter exists. */
export async function acquireStartupHistoryInChild(dataDir: string, packaged: boolean): Promise<StartupHistoryProjection> {
  initializeFz3bHostAclHelper(packaged);
  const forbidden = () => { throw new Error('Startup history operational port forbidden'); };
  const backend = new Fz3bBackend({ dataDir, fixture: historicalFz3bProfileDefinitions()[0]!.fixture,
    adapter: { build: forbidden, inspect: forbidden, semantic: forbidden, readPublicEvidence: forbidden }, requestSemantic: forbidden,
    assertOwner: forbidden, checkRuntime: forbidden });
  return readReleaseRecoveryHistory(backend);
}

/** Fixed stdin request, not an IPC/renderer API. Caller must run this in a separately owned child. */
export async function startupHistoryWorkerFrame(frame: Buffer,
  acquire: typeof acquireStartupHistoryInChild = acquireStartupHistoryInChild): Promise<Buffer> {
  if (!Buffer.isBuffer(frame) || frame.length > 8192) throw new Error('Startup history request budget');
  const text = frame.toString('utf8'), request: StartupHistoryRequest = JSON.parse(text);
  if (!Buffer.from(text).equals(frame) || JSON.stringify(request) + '\n' !== text ||
    Object.keys(request).sort().join(',') !== 'dataDir,kind,nonce,packaged,schemaVersion' ||
    request.schemaVersion !== 1 || request.kind !== 'startup-history-existing-read' ||
    typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(request.nonce) || typeof request.packaged !== 'boolean' ||
    typeof request.dataDir !== 'string' || !path.isAbsolute(request.dataDir) || request.dataDir.includes('\0'))
    throw new Error('Startup history request refused');
  const projection = await acquire(request.dataDir, request.packaged);
  const result = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'startup-history-existing-result', nonce: request.nonce, projection }) + '\n');
  if (result.length > STARTUP_HISTORY_OUTPUT_LIMIT) throw new Error('Startup history response budget');
  return result;
}
