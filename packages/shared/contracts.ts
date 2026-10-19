export interface Project { id: string; name: string; root: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: string; timestamp: string }
export interface Session { id: string; projectId: string; title: string; threadId?: string; turnId?: string; model?: string; status: string; messages: Message[]; historyIncomplete?: boolean; engineUncertain?: boolean; engineProfile?: 'stm32' | 'fz3b'; taskId: string }
export interface Approval { generation: number; id: string | number; method: string; params: unknown; decisions: string[] }
export interface Fz3bEmptyHomeReceipt { schemaVersion: 1; nonce: string; canonicalHomeAbsent: true; preservedEmpty: true; intentSha256: string }
export interface AcceptanceView { id: string; title: string; kind: 'automated' | 'manual'; status: string; command?: { executable: string; args: string[]; timeoutMs?: number }; verifierFiles?: string[] }
export interface TaskView { id: string; status: string; acceptance: AcceptanceView[]; operations: Array<{ id: string; status: string; kind?: string; type?: string; [key: string]: unknown }>; evidence: Array<Record<string, unknown>>; [key: string]: unknown }
export interface AppSnapshot {
  schemaVersion: 1; version: string; projects: Project[]; sessions: Session[];
  engine: { state: string; executable: string; home: string; error?: string };
  account: { loggedIn: boolean; label: string }; models: Array<{ id: string; label: string }>;
  approvals: Approval[]; tasks: TaskView[]; diagnostics: string[];
  hardware: { enabled: false; reason: string; userDriven?: boolean; modeActive?: boolean }; dataDir: string;
  hardwareAgent?: { activeRunId?: string; runs: HardwareAgentRunView[]; engineState: string; policy?: unknown };
  fz3bAgent?: { activeRunId?: string; recoveryTaskId?: string; recoveryActions?: { runId: string; taskId: string; sessionId: string; reconcileInspect: boolean; reconcilePreflightRefusedInspect?: boolean; finishPreflightRefusal?: boolean; quarantineEmptyHome?: boolean; isolateFailedEmptyIntent?: boolean; maintenanceExit: boolean; exportEvidence: boolean }; runs: Fz3bRunView[]; engineState: string; policy?: unknown;
    available: boolean; status: Fz3bAvailabilityStatus | 'unchecked' | 'invalid-state'; resourcesVerified: boolean; keyImportAllowed: boolean; reason?: string };
}
export interface DesktopAPI {
  snapshot(): Promise<AppSnapshot>;
  importProject(): Promise<Project | null>;
  createSession(projectId: string, title: string): Promise<Session>;
  send(sessionId: string, text: string, model?: string): Promise<void>;
  steer(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  approve(generation: number, id: string | number, decision: string): Promise<void>;
  connect(): Promise<void>;
  login(): Promise<void>;
  diff(projectId: string): Promise<{ text: string; truncated: boolean }>;
  setAcceptance(taskId: string, items: Array<{ id: string; title: string; kind: 'automated' | 'manual'; command?: { executable: string; args: string[]; timeoutMs?: number }; verifierFiles?: string[] }>): Promise<void>;
  runAcceptance(taskId: string, acceptanceId: string, requestKey: string): Promise<void>;
  enableSnapshot(taskId: string): Promise<void>;
  runSnapshotBuild(taskId: string, requestKey: string): Promise<void>;
  refreshEvidence(taskId: string): Promise<void>;
  readOperationLog(taskId: string, operationId: string): Promise<string>;
  cancelOperation(taskId: string, operationId: string): Promise<void>;
  exportTask(taskId: string): Promise<string | null>;
  exportDiagnostics(): Promise<string | null>;
  openProject(projectId: string): Promise<void>;
  hardwareSnapshot(taskId: string): Promise<EmbeddedStatus>;
  hardwareConfigure(taskId: string): Promise<EmbeddedStatus>;
  hardwareBuild(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
  hardwareInspect(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
  hardwareFlash(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
  hardwareVerify(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
  hardwareExport(taskId: string): Promise<string | null>;
  hardwareRecover(taskId: string): Promise<EmbeddedStatus>;
  hardwareLeaveMode(): Promise<void>;
  hardwareAgentStart(taskId: string, instruction: string, model: string): Promise<HardwareAgentRunView>;
  hardwareAgentStop(runId: string): Promise<HardwareAgentRunView>;
  fz3bSnapshot(taskId: string): Promise<Fz3bRunView | null>;
  fz3bAgentStart(taskId: string, instruction: string, model: string): Promise<Fz3bRunView>;
  fz3bAgentStop(runId: string): Promise<Fz3bRunView>;
  fz3bRecover(taskId: string): Promise<Fz3bRunView | null>;
  fz3bReconcileInspect(runId: string): Promise<Fz3bRunView>;
  fz3bReconcilePreflightRefusedInspect(runId: string): Promise<Fz3bRunView>;
  fz3bMaintenanceExit(runId: string): Promise<void>;
  fz3bQuarantineEmptyHostHome(runId: string): Promise<Fz3bEmptyHomeReceipt | null>;
  fz3bIsolateFailedEmptyIntent(runId: string): Promise<{ runId: string; sourceName: string; failureEvidenceSha256: string; recoveryId: string; observationSha256: string; nativeSealSha256: string; proofSha256: string; targetSha256: string; completeChainSha256: string; candidateSourceSha256: string } | null>;
  fz3bExport(taskId: string): Promise<string | null>;
  fz3bLeaveMode(): Promise<void>;
  fz3bImportKey(): Promise<void>;
  subscribe(callback: (snapshot: AppSnapshot) => void): () => void;
}
declare global { interface Window { forgeDesk: DesktopAPI } }
import type { EmbeddedStatus } from '../engineering-runner/embedded/types';
import type { HardwareAgentRunView } from './hardware-agent';
import type { Fz3bRunView } from '../engineering-runner/fz3b/types';
import type { Fz3bAvailabilityStatus } from '../engineering-runner/fz3b/availability';
