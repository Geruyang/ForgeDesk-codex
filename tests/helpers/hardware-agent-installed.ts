import assert from 'node:assert/strict';
import path from 'node:path';
import { HARDWARE_AGENT_TOOLS, type HardwareAgentRunView } from '../../packages/shared/hardware-agent';
import type { EmbeddedStatus } from '../../packages/engineering-runner/embedded/types';
import { redact } from '../../packages/engineering-runner/redaction';
import { assertEmbeddedBuild, assertFlashGrant, inside, persistentEmbeddedOperations, samePath, successfulOperation, type EmbeddedInstalledPlan } from './embedded-installed';

export const HARDWARE_AGENT_MODEL = 'gpt-6.1-sol';
export const HARDWARE_AGENT_INSTRUCTION = 'Run the fixed GestureScreen workflow for this task. Use only the six supplied embedded tools with empty JSON arguments. Build the firmware, inspect the exact target and create its backup, request native flash approval exactly once and wait for its result, verify the live device, and export the evidence. The native dialog must be approved separately by the operator; never claim or supply approval yourself. Stop on cancellation, failure, timeout, or unknown outcome. Do not retry a write, use a shell, modify files, change targets, or call another MCP server. Finish only after the authoritative tools report completion.';

export interface HardwareAgentInstalledPlan extends Omit<EmbeddedInstalledPlan, 'scope' | 'artifactTamperPreflight'> {
  scope: 'real-model-fixed-target-installed-T2';
  dataDir: string;
  model: typeof HARDWARE_AGENT_MODEL;
}
export interface HardwareAgentInstalledScope { root: string; dataDir: string; output: string; plan: HardwareAgentInstalledPlan }

export function sanitizeHardwareAgentEvidence(value: unknown): unknown {
  const visit = (current: unknown, trail: string[]): unknown => {
    if (typeof current === 'string') return redact(current);
    if (Array.isArray(current)) return current.map((item, index) => visit(item, [...trail, String(index)]));
    if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([key, item]) => {
      const controlState = trail.length === 1 && trail[0] === 'controls' && key === 'nativeAuthorization' &&
        typeof item === 'string' && ['pending', 'passed', 'failed'].includes(item);
      if (controlState) return [key, item];
      return [key, /password|credential|authorization|access.?token|refresh.?token|api.?key|binding.?key/i.test(key)
        ? '[REDACTED]' : visit(item, [...trail, key])];
    }));
    return current;
  };
  return visit(value, []);
}

export function assertHardwareAgentPolicy(value: unknown, executableSha256: string) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const policy = value as Record<string, unknown>;
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.profile, 'restricted-hardware'); assert.equal(policy.model, HARDWARE_AGENT_MODEL);
  assert.deepEqual(policy.tools, [...HARDWARE_AGENT_TOOLS]); assert.deepEqual(policy.environments, []);
  assert.equal(policy.externalMcp, 'disabled'); assert.equal(policy.freshThreadOnly, true); assert.equal(policy.executableSha256, executableSha256);
  assert.equal(typeof policy.protocolVersion, 'string'); assert.ok(policy.protocolVersion);
  for (const key of ['bundledCatalogSha256', 'catalogSha256', 'effectiveConfigSha256']) assert.match(policy[key] as string, /^[a-f0-9]{64}$/);
  return policy;
}

export function hardwareAgentExportDestination(dataDir: string, run: HardwareAgentRunView): string {
  const file = run.export?.path; assert.ok(file && path.isAbsolute(file));
  const destination = path.join(dataDir, 'exports/hardware-agent', run.runId);
  assert.equal(path.basename(file), 'evidence.json');
  assert.ok(samePath(path.dirname(path.dirname(file)), destination), 'The export must belong to this exact controller run');
  const prefix = `forgedesk-embedded-${run.taskId}-`, bundle = path.basename(path.dirname(file));
  assert.ok(bundle.startsWith(prefix));
  assert.match(bundle.slice(prefix.length), /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  return destination;
}

export function deriveHardwareAgentInstalledScope(root: string, value: unknown, environment: NodeJS.ProcessEnv): HardwareAgentInstalledScope {
  assert.ok(path.isAbsolute(root));
  const plan = value as HardwareAgentInstalledPlan;
  assert.equal(plan?.schemaVersion, 1); assert.equal(plan.scope, 'real-model-fixed-target-installed-T2');
  assert.match(plan.runId, /^hardware-agent-\d{13}-[a-f0-9]{6}$/);
  assert.equal(plan.version, '0.4.0'); assert.match(plan.runtimeCommit, /^[a-f0-9]{40}$/);
  assert.equal(plan.model, HARDWARE_AGENT_MODEL);
  assert.ok(samePath(plan.dataDir, path.join(root, '.runtime/app')), 'Use the existing primary product home without copying credentials');
  assert.ok(samePath(plan.installedExe, path.join(root, 'install/ForgeDesk.exe')), 'Only the reviewed installed executable is allowed');
  for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) assert.ok(!environment[key], `Remove ambient ${key}`);
  for (const [key, item] of Object.entries(environment)) if ((key.startsWith('FORGEDESK_T2_') || key.startsWith('FORGEDESK_HARDWARE_AGENT_')) && item) {
    assert.ok(key === 'FORGEDESK_HARDWARE_AGENT_NATIVE_OPERATOR' && item === 'delegated-ui', `Unsupported hardware-agent override: ${key}`);
  }
  for (const [label, filename] of Object.entries({ dataDir: plan.dataDir, installedExe: plan.installedExe, installerPath: plan.installerPath, projectRoot: plan.projectRoot })) {
    assert.equal(typeof filename, 'string', label); assert.ok(path.isAbsolute(filename), label);
    assert.ok(inside(root, filename) && !samePath(root, filename), label);
  }
  assert.ok(inside(path.join(root, 'release'), plan.installerPath));
  assert.equal(path.basename(plan.installerPath), 'ForgeDesk-0.4.0-x64-setup.exe');
  assert.ok(inside(path.join(root, 'output/hardware'), plan.projectRoot), 'Only the operator-prepared software copy is allowed');
  const output = path.join(root, 'output/hardware-agent', plan.runId);
  for (const [a, b] of [[plan.projectRoot, plan.dataDir], [plan.projectRoot, path.dirname(plan.installedExe)], [plan.projectRoot, output], [output, plan.dataDir]]) {
    assert.equal(inside(a, b) || inside(b, a), false, 'Project, evidence, installation and account data must remain disjoint');
  }
  const required = ['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
    'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe', 'hardware/python/python.exe', 'hardware/manifest.json',
    'hardware-worker.py', 'templates/gesturescreen-v1/overlay-manifest.json', 'templates/gesturescreen-v1/App/Inc/forgedesk_build_id.h',
    'templates/gesturescreen-v1/BSP/Src/gs_usb_capture.c', 'templates/gesturescreen-v1/Modules/UsbCapture/Inc/gs_usb_protocol.h',
    'templates/gesturescreen-v1/Modules/UsbCapture/Src/gs_usb_protocol.c'];
  for (const item of required) assert.ok(Object.hasOwn(plan.resourceHashes ?? {}, `resources/${item}`), `Missing resource pin: ${item}`);
  for (const [relative, hash] of Object.entries(plan.resourceHashes)) {
    assert.match(relative, /^resources\/[a-zA-Z0-9._/-]+$/); assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
  for (const hash of [plan.installerSha256, plan.executableSha256, plan.expectedProfile.sha256]) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(plan.expectedProfile.id, 'gesturescreen-challenger-v1'); assert.equal(plan.expectedProfile.chipId, 0x419); assert.equal(plan.expectedProfile.flashKiB, 1024);
  assert.match(plan.expectedProfile.uid, /^[a-f0-9]{24}$/); assert.match(plan.expectedProfile.probeSerial, /^[a-zA-Z0-9]+$/); assert.match(plan.expectedProfile.cdcSerial, /^[a-zA-Z0-9]+$/);
  assert.ok(samePath(plan.keilExecutable, 'D:/STSoft/Keil5/UV4/UV4.exe'));
  return { root: path.resolve(root), dataDir: path.resolve(plan.dataDir), output, plan };
}

export function assertHardwareAgentCompletion(run: HardwareAgentRunView, hardware: EmbeddedStatus, profile: HardwareAgentInstalledPlan['expectedProfile']) {
  assert.equal(run.taskId, hardware.taskId); assert.equal(run.model, HARDWARE_AGENT_MODEL);
  assert.ok(run.sessionId && run.threadId && run.turnId); assert.ok(Number.isSafeInteger(run.generation) && run.generation > 0);
  assert.equal(run.status, 'completed'); assert.equal(run.phase, 'completed'); assert.equal(run.active, false); assert.equal(run.hardwareBusy, false);
  assert.equal(run.stopRequested, false); assert.equal(run.nativeApproval, 'approved'); assert.equal(run.failure, undefined);
  const ids = new Set<string>();
  for (const call of run.calls) {
    assert.ok(HARDWARE_AGENT_TOOLS.includes(call.tool)); assert.ok(call.callId && !ids.has(call.callId), 'Every actual dynamic call must have a unique ID'); ids.add(call.callId);
    assert.equal(call.status, 'succeeded', `Call ${call.callId} is not successful`); assert.ok(call.completedAt);
    assert.ok(Date.parse(call.completedAt) >= Date.parse(call.receivedAt)); assert.equal(call.error, undefined);
    assert.ok(call.result?.ok); assert.equal(call.result.callId, call.callId); assert.equal(call.result.runId, run.runId); assert.equal(call.result.tool, call.tool);
  }
  assert.equal(run.calls[0]?.tool, 'embedded_status', 'The real model must inspect authoritative status before requesting actions');
  assert.equal(run.calls[0].result!.result, 'status');
  const artifact = assertEmbeddedBuild(hardware, profile);
  assert.equal(hardware.operations.length, 4, 'The initial real-model workflow must execute exactly one build, inspect, flash and verify');
  const ordered = ['embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'] as const;
  let position = -1;
  for (const name of ordered) {
    const matches = run.calls.filter(call => call.tool === name); assert.equal(matches.length, 1, `Exactly one actual ${name} call is required`);
    const call = matches[0]; const next = run.calls.indexOf(call); assert.ok(next > position, 'Workflow calls must follow the authorized order'); position = next;
    assert.equal(call.result!.result, 'succeeded');
    if (name !== 'embedded_export') {
      const kind = name === 'embedded_request_flash' ? 'flash' : name.slice('embedded_'.length) as 'build' | 'inspect' | 'verify';
      const op = successfulOperation(hardware, kind); assert.equal(call.operationId, op.id); assert.equal(call.requestKey, op.requestKey);
      assert.equal(call.result!.operation?.id, op.id); assert.equal(call.result!.operation?.status, 'succeeded'); assert.equal(call.result!.operation?.processExited, true);
    }
  }
  assert.ok(run.export?.path && run.export.sha256); const exported = run.calls.find(call => call.tool === 'embedded_export')!;
  assert.deepEqual(exported.result!.export, run.export); assert.equal(run.artifact?.buildId, artifact.buildId); assert.equal(run.artifact?.hexSha256, artifact.hexSha256);
  assertFlashGrant(hardware, profile, successfulOperation(hardware, 'flash'));
  return { artifact, flash: successfulOperation(hardware, 'flash'), verify: successfulOperation(hardware, 'verify') };
}

export function assertHardwareAgentNoReplay(before: HardwareAgentRunView, after: HardwareAgentRunView, oldHardware: EmbeddedStatus, newHardware: EmbeddedStatus) {
  assert.deepEqual(persistedJson(after), persistedJson(before), 'Restart must not resume or fabricate controller calls');
  assert.deepEqual(persistedJson(persistentEmbeddedOperations(newHardware.operations)), persistedJson(persistentEmbeddedOperations(oldHardware.operations)));
  assert.deepEqual(persistedJson(newHardware.artifact), persistedJson(oldHardware.artifact));
}

// JSON persistence omits undefined object properties, but no other value changes are tolerated.
function persistedJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return value; }
  if (Array.isArray(value)) {
    assert.equal(Object.keys(value).length, value.length, 'Sparse or decorated arrays are not JSON evidence');
    return value.map(persistedJson);
  }
  assert.ok(value && typeof value === 'object', 'Evidence contains a non-JSON value');
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  assert.equal(Object.getOwnPropertySymbols(value).length, 0);
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, persistedJson(item)]));
}
