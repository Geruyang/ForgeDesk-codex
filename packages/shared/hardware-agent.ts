import type { EmbeddedProgress } from '../engineering-runner/embedded/types.js';

export const HARDWARE_AGENT_TOOLS = ['embedded_status', 'embedded_build', 'embedded_inspect',
  'embedded_request_flash', 'embedded_verify', 'embedded_export'] as const;
export type HardwareAgentToolName = typeof HARDWARE_AGENT_TOOLS[number];
export type HardwareAgentPhase = 'ready' | 'building' | 'inspecting' | 'awaiting_native_approval' |
  'flashing' | 'verifying' | 'exporting' | 'completed' | 'stopped' | 'needs_attention';
export interface HardwareAgentBinding {
  runId: string; sessionId: string; taskId: string; model: string;
  generation: number; threadId: string; turnId?: string; instruction?: string;
}
export interface HardwareAgentToolContext {
  runId: string; sessionId: string; taskId: string; generation: number;
  threadId: string; turnId: string; callId: string;
}
export interface HardwareAgentArtifactView {
  id: string; buildId: string; hexSha256: string; axfSha256: string;
  sourceSha256: string; profileSha256: string;
}
export interface HardwareAgentOperationView {
  id: string; kind: 'build' | 'inspect' | 'flash' | 'verify';
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown';
  processExited?: boolean; detail?: string; progress?: EmbeddedProgress;
}
export interface HardwareAgentToolResult {
  runId: string; callId: string; tool: HardwareAgentToolName; ok: boolean;
  result: 'status' | 'succeeded' | 'failed' | 'unknown' | 'stopped';
  phase: HardwareAgentPhase; operation?: HardwareAgentOperationView;
  artifact?: HardwareAgentArtifactView; export?: { path: string; sha256: string }; message?: string;
}
export interface HardwareAgentCallAudit {
  callId: string; tool: HardwareAgentToolName; receivedAt: string; completedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown' | 'replayed' | 'rejected' | 'stopped';
  requestKey?: string; operationId?: string; replayedFromCallId?: string;
  error?: string; result?: HardwareAgentToolResult;
}
export interface HardwareAgentRunView extends HardwareAgentBinding {
  schemaVersion: 1; status: 'active' | 'completed' | 'stopped' | 'needs_attention';
  phase: HardwareAgentPhase; active: boolean; hardwareBusy: boolean; stopRequested: boolean;
  nativeApproval: 'not_requested' | 'pending' | 'approved' | 'cancelled' | 'expired' | 'unknown';
  createdAt: string; updatedAt: string; currentTool?: HardwareAgentToolName;
  calls: HardwareAgentCallAudit[]; artifact?: HardwareAgentArtifactView;
  failure?: string; export?: { path: string; sha256: string };
}
