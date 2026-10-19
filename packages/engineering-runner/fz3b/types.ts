import type { Fz3bPreflightRefusalAnchor, Fz3bPreflightRefusalInput, Fz3bPreflightRefusalProof } from './preflight-refusal-proof.js';

export const FZ3B_TOOLS = ['fz3b_status', 'fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic', 'fz3b_export'] as const;
export type Fz3bToolName = typeof FZ3B_TOOLS[number];
export type Fz3bPhase = 'ready' | 'building' | 'inspecting' | 'awaiting_native_approval' | 'semantic' | 'exporting' | 'completed' | 'stopped' | 'needs_attention';
export interface Fz3bEncoderIdentity { contractId: string; weightSha256: string; bpeSha256: string; normalization: 'l2-float32-v1' }
export interface Fz3bSemanticFixture {
  id: 'fz3b-pillow-scene-v1'; manifestSha256: string; queriesSha256: string;
  imageSha256: string; predeclaredSha256: string; width: 914; height: 512;
  queryCount: 4; embeddingDimensions: 512; expectedLabel: 'pillow';
  queryIds: readonly ['pillow', 'cup', 'mobile-phone', 'bottle'];
  encoderIdentity: Fz3bEncoderIdentity;
}
export interface Fz3bBinding {
  runId: string; sessionId: string; taskId: string; model: string;
  generation: number; threadId: string; turnId?: string; instruction?: string;
}
export interface Fz3bToolContext extends Omit<Fz3bBinding, 'model' | 'instruction'> { turnId: string; callId: string }
export interface Fz3bIdentity {
  hostKeySha256: string; bootId: string; appRoot: string; platform: 'A0005';
  contractId: string; deployedManifestSha256: string; existingPlSha256: string;
  transport: 'pinned-ssh'; helloAuthenticated: false;
}
export interface Fz3bArtifact {
  id: string; kind: 'fixed-ps-fixture-package'; buildId: string;
  profileSha256: string; sourceManifestSha256: string; fixtureManifestSha256: string;
  queriesSha256: string; imageSha256: string; buildEvidenceSha256: string;
  packageSha256: string; packageManifestSha256: string;
  newPlBuilt: false; deployed: false;
}
export interface Fz3bProgress { stage: string; updatedAt: string; completed?: number; total?: number; unit?: 'bytes' | 'steps'; message?: string }
export interface Fz3bOperation {
  id: string; requestKey: string; nonce: string; kind: 'build' | 'inspect' | 'semantic';
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown';
  dispatchPhase: 'not-started' | 'may-have-started'; createdAt: string; updatedAt: string;
  processExited?: boolean; remoteQuiescent?: boolean; evidenceSha256?: string; detail?: string; progress?: Fz3bProgress;
}
export interface Fz3bRanking { id: 'pillow' | 'cup' | 'mobile-phone' | 'bottle'; label: string; score: number }
export interface Fz3bSemanticResult {
  jobId: string; frameId: number; queryRevision: number; completedFrames: 1;
  fixtureManifestSha256: string; queriesSha256: string; imageSha256: string;
  encoderIdentity: Fz3bEncoderIdentity; ranking: Fz3bRanking[]; bestId: Fz3bRanking['id'];
  semanticInput: 'real-text-encoder'; synthetic: false;
  classificationUnknown: boolean; threshold: 0.2; thresholdHit: boolean;
  expectedLabel: 'pillow'; expectedLabelMatched: boolean;
  inferenceStopped: true; newPlLoaded: false;
}
export interface Fz3bGrantPreview {
  id: string; runId: string; sessionId: string; taskId: string; artifactId: string;
  profileSha256: string; identity: Fz3bIdentity; fixture: Fz3bSemanticFixture;
  scope: 'existing-candidate008-real-text-single-image-once'; actions: readonly string[];
  planSha256: string; createdAt: string; expiresAt: string;
}
export interface Fz3bGrant extends Fz3bGrantPreview { approvedAt?: string; consumedBy?: string }
export interface Fz3bToolResult {
  runId: string; callId: string; tool: Fz3bToolName; ok: boolean;
  result: 'status' | 'succeeded' | 'failed' | 'unknown' | 'stopped'; phase: Fz3bPhase;
  operation?: Fz3bOperation; artifact?: Fz3bArtifact; identity?: Fz3bIdentity;
  semantic?: Fz3bSemanticResult; export?: { path: string; sha256: string }; message?: string;
}
export interface Fz3bCallAudit {
  callId: string; tool: Fz3bToolName; receivedAt: string; completedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown' | 'replayed' | 'rejected' | 'stopped';
  operationId?: string; replayedFromCallId?: string; error?: string; result?: Fz3bToolResult;
}
export interface Fz3bRunView extends Fz3bBinding {
  schemaVersion: 1; profileId: string; profileSha256: string;
  status: 'active' | 'completed' | 'stopped' | 'needs_attention'; phase: Fz3bPhase;
  active: boolean; hardwareBusy: boolean; stopRequested: boolean;
  nativeApproval: 'not_requested' | 'pending' | 'approved' | 'cancelled' | 'expired' | 'unknown';
  createdAt: string; updatedAt: string; currentTool?: Fz3bToolName;
  calls: Fz3bCallAudit[]; operations: Fz3bOperation[]; artifact?: Fz3bArtifact;
  identity?: Fz3bIdentity; grant?: Fz3bGrant; semantic?: Fz3bSemanticResult;
  export?: { path: string; sha256: string }; failure?: string;
  reconciliations?: Fz3bInspectReconciliation[]; maintenanceExit?: Fz3bMaintenanceExitSeal;
  preflightRefusalRecoveries?: Fz3bPreflightRefusalRecovery[];
}
export interface Fz3bQuiescence {
  runId: string; taskId: string; sessionId: string; active: boolean; stopRequested: boolean;
  starting: boolean; inflight: boolean; nativePending: boolean; persistencePending: boolean;
  hardwareBusy: boolean; quiescent: boolean;
}
export interface Fz3bAdapterContext {
  runId: string; sessionId: string; taskId: string; operationId: string; requestKey: string;
  nonce: string; profileSha256: string; fixture: Fz3bSemanticFixture;
  artifact?: Fz3bArtifact; identity?: Fz3bIdentity; grant?: Fz3bGrant;
}
export interface Fz3bReceiptBase {
  schemaVersion: 1; operationId: string; nonce: string; profileSha256: string;
  status: 'succeeded' | 'failed' | 'unknown'; processExited: boolean;
  remoteQuiescent: boolean; remoteOutcomeUnknown: boolean; evidenceSha256: string; detail?: string;
}
export interface Fz3bBuildReceipt extends Fz3bReceiptBase {
  kind: 'build'; sourceManifestSha256: string; fixtureManifestSha256: string;
  queriesSha256: string; imageSha256: string; newPlBuilt: false; deployed: false;
  packageSha256?: string; packageManifestSha256?: string;
}
export interface Fz3bInspectReceipt extends Fz3bReceiptBase { kind: 'inspect'; identity?: Fz3bIdentity; readOnly: true }
export interface Fz3bSemanticReceipt extends Fz3bReceiptBase { kind: 'semantic'; identity?: Fz3bIdentity; semantic?: Fz3bSemanticResult; grantId?: string }
export interface Fz3bPublicEvidenceFile {
  name: 'evidence.json' | 'ps-acceptance.tar' | 'package-manifest.json'; bytes: Buffer; sha256: string;
}
export interface Fz3bInspectReconciliationContext {
  schemaVersion: 1; id: string; nonce: string; createdAt: string;
  original: Fz3bAdapterContext; originalOperationSha256: string;
  originalEvidenceSha256: string; ownerBindingSha256: string;
}
export interface Fz3bInspectReconciliationProof {
  schemaVersion: 1; id: string; nonce: string; contextSha256: string;
  originalEvidenceSha256: string; originalIntentSha256: string; originalCloseSha256: string;
  originalResourceManifestSha256: string; localOriginalCloseConfirmed: true;
  identity: Fz3bIdentity; observedAt: string; evidenceSha256: string;
  transport: { spawned: true; closeConfirmed: true; exitCode: 0; timedOut: false };
  remote: { readOnly: true; metadataStable: true; deviceOwners: number[]; controlConnections: 0;
    inspectorPids: number[]; unfinishedJournalEntries: 0; scanCount: number;
    procScanComplete: true; journalScanComplete: true; originalInspectorAbsent: true };
}
export interface Fz3bInspectReconciliationFinalization {
  schemaVersion: 1; id: string; contextSha256: string; proofSha256: string;
  lockReleased: true; localProcessesClosed: true; evidenceSha256: string;
}
export interface Fz3bInspectReconciliation {
  schemaVersion: 1; context: Fz3bInspectReconciliationContext;
  status: 'preparing' | 'prepared' | 'released' | 'failed'; createdAt: string; updatedAt: string;
  proof?: Fz3bInspectReconciliationProof; finalization?: Fz3bInspectReconciliationFinalization; error?: string;
}
export interface Fz3bLocalProcessState {
  closed: boolean; liveChildren: number;
  operations: { operationId: string; nonce: string; closeConfirmed: boolean; evidenceSha256: string }[];
}
/** Legacy maintenance aggregate evidence, distinct from the raw process-exit file. */
export interface Fz3bMaintenanceLocalCloseProof {
  schemaVersion: 1; operationId: string; nonce: string; taskId: string; runId: string; sessionId: string; profileSha256: string;
  originalEvidenceSha256: string; originalIntentSha256: string; originalCloseSha256: string;
  closeConfirmed: true; historicalPidAttested: false;
  claim: 'Bound existing observed-close evidence plus current adapter child census only';
}
export interface Fz3bMaintenanceExitSeal {
  schemaVersion: 1; runId: string; sessionId: string; taskId: string; profileSha256: string;
  createdAt: string; unknownPreserved: true; localProcessesClosed: true;
  operationSnapshotSha256: string; processState: Fz3bLocalProcessState; sealSha256: string;
}
export interface Fz3bPreflightRefusalRecoveryContext {
  schemaVersion: 1; reason: 'boot-preflight-refused-before-device-v1';
  id: string; nonce: string; createdAt: string; expiresAt: string;
  original: Fz3bAdapterContext; ownerBindingSha256: string; originalOperationSha256: string; originalEvidenceSha256: string;
  sourceRecordSha256: string; sourceProjectionSha256: string; maintenanceExitSha256: string | null;
  sourceRun: Fz3bRunView; projection: Fz3bRunView; anchor: Fz3bPreflightRefusalAnchor;
}
export interface Fz3bPreflightRefusalRecoveryProof {
  schemaVersion: 1; reason: Fz3bPreflightRefusalRecoveryContext['reason']; id: string; nonce: string;
  contextSha256: string; observedAt: string; classification: Fz3bPreflightRefusalProof;
  originalLeaseSha256: string; processState: Fz3bLocalProcessState; evidenceSha256: string;
}
export interface Fz3bPreflightRefusalRecoveryFinalization {
  schemaVersion: 1; id: string; contextSha256: string; proofSha256: string; originalLeaseSha256: string;
  leaseUnlinked: true; barrierRetained: true; localProcessesClosed: true; finalizedAt: string; evidenceSha256: string;
}
export interface Fz3bPreflightRefusalRecoveryAck {
  schemaVersion: 1; method: 'fz3b-preflight-refusal-post-save-ack-v1';
  purpose: 'exact-local-inspect-release-only'; id: string; contextSha256: string; proofSha256: string;
  finalizationSha256: string; checkpointSha256: string; checkpointUpdatedAt: string; issuedAt: string; mac: string;
}
export interface Fz3bPreflightRefusalRecoveryAcknowledgment {
  schemaVersion: 1; id: string; contextSha256: string; proofSha256: string; finalizationSha256: string;
  ackSha256: string; originalLeaseSha256: string; localBarrierRemoved: true; localProcessesClosed: true; evidenceSha256: string;
}
export interface Fz3bPreflightRefusalRecoveryClosure {
  schemaVersion: 1; method: 'fz3b-preflight-refusal-worker-closed-v1'; purpose: 'actual-local-barrier-close-only';
  id: string; contextSha256: string; proofSha256: string; finalizationSha256: string; ackSha256: string;
  acknowledgmentSha256: string; checkpointSha256: string; issuedAt: string; mac: string;
}
export interface Fz3bPreflightRefusalRecovery {
  schemaVersion: 1; context: Fz3bPreflightRefusalRecoveryContext;
  status: 'preparing' | 'prepared' | 'release_prepared' | 'released' | 'failed'; createdAt: string; updatedAt: string;
  proof?: Fz3bPreflightRefusalRecoveryProof; finalization?: Fz3bPreflightRefusalRecoveryFinalization;
  ack?: Fz3bPreflightRefusalRecoveryAck; acknowledgment?: Fz3bPreflightRefusalRecoveryAcknowledgment; error?: string;
  closure?: Fz3bPreflightRefusalRecoveryClosure;
}
export interface Fz3bAdapter {
  build(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bBuildReceipt>;
  inspect(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bInspectReceipt>;
  semantic(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bSemanticReceipt>;
  readPublicEvidence(operationId: string, evidenceSha256: string): Promise<Fz3bPublicEvidenceFile[]>;
  prepareInspectReconciliation?(context: Readonly<Fz3bInspectReconciliationContext>): Promise<Fz3bInspectReconciliationProof>;
  finalizeInspectReconciliation?(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>): Promise<Fz3bInspectReconciliationFinalization>;
  readInspectReconciliationEvidence?(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>, finalization?: Readonly<Fz3bInspectReconciliationFinalization>):
    Promise<{ name: 'proof-evidence.json' | 'finalization-evidence.json'; bytes: Buffer; sha256: string }[]>;
  localProcessState?(contexts: readonly Fz3bAdapterContext[]): Promise<Fz3bLocalProcessState>;
  preparePreflightRefusalRecovery?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>): Promise<Fz3bPreflightRefusalRecoveryProof>;
  readPreflightRefusalRecoveryInput?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>):
    Promise<Pick<Fz3bPreflightRefusalInput, 'resources' | 'files'>>;
  finalizePreflightRefusalRecovery?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>):
    Promise<Fz3bPreflightRefusalRecoveryFinalization>;
  acknowledgePreflightRefusalRecovery?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>,
    finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, ack: Readonly<Fz3bPreflightRefusalRecoveryAck>,
    verifyAck: (value: Fz3bPreflightRefusalRecoveryAck) => void): Promise<Fz3bPreflightRefusalRecoveryAcknowledgment>;
  readPreflightRefusalRecoveryCompletion?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>,
    finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, verifyAck: (value: Fz3bPreflightRefusalRecoveryAck) => void,
    verifyClosure: (ack: Fz3bPreflightRefusalRecoveryAck, acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, value: Fz3bPreflightRefusalRecoveryClosure) => void):
    Promise<{ ack: Fz3bPreflightRefusalRecoveryAck; acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment; closure: Fz3bPreflightRefusalRecoveryClosure }>;
  certifyPreflightRefusalRecovery?(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>,
    finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, ack: Readonly<Fz3bPreflightRefusalRecoveryAck>,
    acknowledgment: Readonly<Fz3bPreflightRefusalRecoveryAcknowledgment>, closure: Readonly<Fz3bPreflightRefusalRecoveryClosure>,
    verifyClosure: (ack: Fz3bPreflightRefusalRecoveryAck, acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, value: Fz3bPreflightRefusalRecoveryClosure) => void): Promise<void>;
}
