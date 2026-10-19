export interface CommandSpec {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  artifactPaths?: string[];
}

export interface AcceptanceDefinition {
  id: string;
  title: string;
  kind: 'automated' | 'manual';
  required?: boolean;
  command?: CommandSpec;
  verifierFiles?: string[];
  expectedExitCode?: number;
}

export interface AcceptanceItem extends AcceptanceDefinition {
  schemaVersion: 1;
  taskId: string;
  status: 'pending' | 'passed' | 'failed' | 'stale';
  evidenceId?: string;
  fixedProfileId?: 'forgedesk.node-software.v1';
}

export interface SourceSnapshot {
  schemaVersion: 1;
  evidenceLevel: 'A';
  capturedAt: string;
  inputDigest: string;
  gitCommit: string | null;
  dirtyDiffDigest: string | null;
  untrackedDigest: string;
  files: { path: string; sha256: string; bytes: number }[];
  directories?: string[];
  excludedGeneratedDirs: string[];
  limitation: string;
}

export interface ToolIdentity {
  executable: string;
  sha256: string;
  version: string;
  processHost?: { executable: string; sha256: string };
}

export interface Evidence {
  schemaVersion: 1;
  id: string;
  taskId: string;
  operationId: string;
  acceptanceId?: string;
  evidenceLevel: 'A' | 'B';
  result: 'passed' | 'failed' | 'stale' | 'unknown';
  createdAt: string;
  inputDigest: string;
  configurationDigest: string;
  sourceBefore: SourceSnapshot;
  sourceAfter?: SourceSnapshot;
  tool: ToolIdentity;
  artifacts: { path: string; sha256: string; bytes: number }[];
  logRef: string;
  limitation: string;
  snapshot?: TaskSnapshot;
}

export interface Operation {
  schemaVersion: 1;
  id: string;
  taskId: string;
  requestKey: string;
  argsDigest: string;
  kind: 'build' | 'test';
  acceptanceId?: string;
  command: CommandSpec;
  status: 'prepared' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  failureReason?: string;
  logRef?: string;
  evidenceId?: string;
  cleanup: 'not-needed' | 'confirmed' | 'unconfirmed';
  evidenceLevel?: 'A' | 'B';
  snapshotId?: string;
  snapshot?: TaskSnapshot;
  phase?: 'snapshotting' | 'sandbox_probe' | 'permission_probe' | 'building' | 'verifying' | 'finalizing';
}

export interface EngineeringTask {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  sessionId: string;
  title: string;
  status: 'draft' | 'running' | 'passed' | 'failed' | 'interrupted' | 'needs_attention';
  profileRevision: number;
  createdAt: string;
  updatedAt: string;
  acceptance: AcceptanceItem[];
  operations: Operation[];
  evidence: Evidence[];
  snapshotProfile?: SnapshotProfile;
}

export interface RunnerOptions {
  dataDir: string;
  onChange?: () => void;
  /** Native Windows Job Object supervisor. Configured failures never fall back silently. */
  processHost?: string;
  /** Explicit generated directory paths relative to the project; .git is always excluded. */
  excludedGeneratedDirs?: string[];
  maxFingerprintFiles?: number;
  maxFingerprintBytes?: number;
  snapshotTemplateDirectory?: string;
  snapshotPolicyDigest?: (projectRoot: string) => string;
  /** Main-owned closed-policy config/read for the actual execution cwd; never model supplied. */
  snapshotExecutionPolicy?: (cwd: string) => Promise<SnapshotPolicyEvidence>;
  snapshotSandbox?: SnapshotSandbox;
}

export interface SnapshotIsolationReceipt {
  schemaVersion: 1;
  method: 'engine-sandbox-write-denial';
  policyDigest: string;
  projectRoot: string;
  protectedRoot: string;
  verifiedAt: string;
  probeLogRef: string;
  probeLogSha256: string;
}

export interface SnapshotProfileInput {
  id: 'forgedesk.node-software.v1';
  nodeExecutable: string;
  isolation: SnapshotIsolationReceipt;
}

export interface SnapshotProfile extends SnapshotProfileInput {
  schemaVersion: 1;
  revision: number;
  configuredAt: string;
  templateDirectory: string;
  trustedFiles: { path: string; sha256: string }[];
  profileDigest: string;
  sandbox: SnapshotSandbox;
}

export interface SnapshotSandbox {
  executable: string;
  codexHome: string;
  mode: 'mxc' | 'elevated' | 'unelevated';
}

export interface TaskSnapshot {
  schemaVersion: 1;
  id: string;
  taskId: string;
  operationId: string;
  createdAt: string;
  inputRoot: string;
  outputRoot: string;
  manifestPath: string;
  manifestDigest: string;
  contentDigest: string;
  sourceInputDigest: string;
  profileId: 'forgedesk.node-software.v1';
  profileRevision: number;
  isolation: SnapshotIsolationReceipt;
  permissionProbe?: { build: Record<string, unknown>; verify: Record<string, unknown> };
  verifierReceipt?: Record<string, unknown>;
  sandboxProbe?: Record<string, unknown>;
  verificationResult?: 'passed' | 'failed' | 'unknown';
  executionPolicies?: SnapshotExecutionStagePolicy[];
}
import type { SnapshotPolicyEvidence } from '../engine-adapter/snapshot-isolation.js';


export interface SnapshotExecutionPolicy {
  schemaVersion: 1;
  permissionProfileId: 'forgedesk_workspace_v1';
  sandboxArgsDigest: string;
  commandDigest: string;
  status: 'pending' | 'verified' | 'rejected';
  policyDigest?: string;
  before?: SnapshotPolicyEvidence;
  after?: SnapshotPolicyEvidence;
}

export interface SnapshotExecutionStagePolicy extends SnapshotExecutionPolicy {
  file: 'build.mjs' | 'verify.mjs' | 'permission-probe.mjs' | 'sandbox-probe.mjs';
  phase: NonNullable<Operation['phase']>;
  nonce: string;
  permissionStage?: 'build' | 'verify';
}
