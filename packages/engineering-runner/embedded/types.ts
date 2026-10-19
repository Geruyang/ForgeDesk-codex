import type { GESTURESCREEN_PROFILE } from './profile.js';
import type { FlashOutcome } from '../device/types.js';
import type { ProcessControl, ProcessResult } from '../processes.js';
import type { CommandSpec } from '../types.js';

export interface EmbeddedArtifact {
  id: string; buildId: string; hexPath: string; axfPath: string;
  hexSha256: string; axfSha256: string; sourceSha256: string; profileSha256: string;
}
export const EMBEDDED_PROGRESS_STAGES = ['preflight', 'probe_discovery', 'connecting', 'identifying',
  'backup_read_1', 'backup_read_2', 'backup_saved', 'preflash_compare', 'erase_program',
  'readback', 'reset', 'cdc_discovery', 'cdc_challenge_1', 'cdc_challenge_2', 'finalizing'] as const;
export interface EmbeddedProgress {
  schemaVersion: 1; operationId: string; action: 'inspect' | 'flash' | 'verify';
  stage: typeof EMBEDDED_PROGRESS_STAGES[number]; updatedAt: string; sequence: number;
  /** Counts describe only the current stage. Missing counts mean indeterminate progress. */
  completed?: number; total?: number; unit?: 'bytes' | 'fraction' | 'steps'; message?: string;
}
export interface EmbeddedHardwareContext {
  taskId: string; operationId: string; operationDir: string; nonce: string;
  profile: typeof GESTURESCREEN_PROFILE; artifact?: EmbeddedArtifact;
  backup?: { path: string; sha256: string };
}
export interface EmbeddedHardwareAdapter {
  inspect(context: EmbeddedHardwareContext): Promise<FlashOutcome>;
  flash(context: EmbeddedHardwareContext): Promise<FlashOutcome>;
  verify(context: EmbeddedHardwareContext): Promise<FlashOutcome>;
  readProgress?(action: EmbeddedProgress['action'], operationId: string, operationDir: string): Promise<EmbeddedProgress | undefined>;
  confirmProcessExited?(operationId: string, operationDir?: string): Promise<boolean>;
}
export interface EmbeddedOptions {
  dataDir: string; templateRoot: string; processHost?: string;
  hardware?: EmbeddedHardwareAdapter; onChange?: () => void; now?: () => number;
  /** Test injection; desktop main uses the default process-host executor. */
  execute?: (command: CommandSpec, control: ProcessControl, processHost?: string) => Promise<ProcessResult>;
}
export interface EmbeddedToolPaths { keilExecutable: string }
export interface EmbeddedFile { path: string; sha256: string; bytes: number }
export interface EmbeddedBuild extends EmbeddedArtifact {
  createdAt: string; sourceRoot: string; projectSourceBefore: string; projectSourceAfter: string;
  snapshotSourceBefore: string; snapshotSourceAfter: string;
  files: EmbeddedFile[]; toolHashes: Record<string, string>; templateSha256: string;
  logPath: string; logSha256: string; processExit: number | null;
}
export interface EmbeddedOperation {
  id: string; requestKey: string; kind: 'build' | 'inspect' | 'flash' | 'verify';
  argsDigest: string; nonce: string; status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string; updatedAt: string; processExited?: boolean; detail?: string;
  receipt?: string; artifactId?: string;
  recoveredAt?: string;
  /** Persisted before dispatch; a prepared not-started record proves no worker was invoked. */
  dispatchPhase?: 'not-started' | 'may-have-started';
  /** Informational worker telemetry; never changes the operation outcome or grants. */
  progress?: EmbeddedProgress;
}
export interface EmbeddedGrantPreview {
  id: string; taskId: string; artifactId: string; hexSha256: string; axfSha256: string;
  buildId: string; sourceSha256: string; profileId: string; profileSha256: string;
  backupSha256: string;
  identity: { probeSerial: string; uid: string; chipId: number; flashKiB: number; cdcSerial: string };
  scope: 'flash-and-verify-once'; expiresAt: string;
}
export interface EmbeddedGrant extends EmbeddedGrantPreview { approvedAt?: string; consumedBy?: string }
export interface EmbeddedTaskState {
  schemaVersion: 1; taskId: string; projectRoot: string; configuredAt: string;
  tools: EmbeddedToolPaths; profileSha256: string; builds: EmbeddedBuild[];
  operations: EmbeddedOperation[]; grant?: EmbeddedGrant;
}
export interface EmbeddedStatus {
  configured: boolean; taskId: string; profileId: string; profileSha256: string;
  limitation: string; projectRoot?: string; artifact?: EmbeddedBuild;
  operations: EmbeddedOperation[]; grant?: EmbeddedGrant; hardwareAvailable: boolean;
}
