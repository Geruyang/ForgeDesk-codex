import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ClientRequest } from "../../schemas/ClientRequest";
import type { InitializeParams } from "../../schemas/InitializeParams";
import type { SandboxPolicy } from "../../schemas/v2/SandboxPolicy";
import type { ThreadStartParams } from "../../schemas/v2/ThreadStartParams";
import type { ThreadResumeParams } from "../../schemas/v2/ThreadResumeParams";
import type { TurnStartParams } from "../../schemas/v2/TurnStartParams";
import type { TurnSteerParams } from "../../schemas/v2/TurnSteerParams";
import type { McpServerElicitationRequestResponse } from "../../schemas/v2/McpServerElicitationRequestResponse";
import { digestSnapshotPolicyValue, type SnapshotPolicyEvidence } from "./snapshot-isolation";
import { assertWorkspacePolicyConfig, assertWorkspacePolicyRequirements, workspacePolicyConfigArgs } from "./workspace-policy";

export type EngineState = "stopped" | "starting" | "ready" | "stopping" | "failed";
export type EngineEvent = { generation: number; sequence: number; method: string; params: unknown };
export type EngineApproval = {
  generation: number;
  id: string | number;
  method: string;
  params: unknown;
  decisions: string[];
};
export type CodexAdapterOptions = {
  executable: string;
  home: string;
  onEvent: (event: EngineEvent) => void;
  requestTimeoutMs?: number;
  env?: Record<string, string>;
  processHost?: string;
};

type RpcId = string | number;
type RecordValue = Record<string, unknown>;
type Pending = {
  generation: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type AllowedMethod = Extract<ClientRequest["method"],
  "initialize" | "model/list" | "account/read" | "account/login/start" |
  "thread/start" | "thread/resume" | "turn/start" | "turn/steer" |
  "turn/interrupt" | "config/read" | "configRequirements/read" | "windowsSandbox/readiness">;

const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const CODEX_PROTOCOL_VERSION = "0.162.0-alpha.17.2";
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_APPROVALS = 128;
const MAX_DIAGNOSTICS = 100;
const SCALAR_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];
const NOTIFICATIONS = new Set([
  "error", "warning", "guardianWarning", "deprecationNotice", "configWarning",
  "thread/started", "thread/status/changed", "thread/archived", "thread/deleted",
  "thread/unarchived", "thread/closed", "thread/reverted", "thread/name/updated",
  "thread/tokenUsage/updated", "thread/settings/updated", "thread/compacted",
  "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated",
  "item/started", "item/completed", "item/agentMessage/delta", "item/plan/delta",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "serverRequest/resolved", "mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed",
  "account/updated", "account/rateLimits/updated", "account/login/completed",
  "windows/worldWritableWarning", "windowsSandbox/setupCompleted", "model/rerouted",
  "model/verification", "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted",
  "hook/started", "hook/completed", "skills/changed",
]);

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function idKey(id: RpcId): string { return `${typeof id}:${id}`; }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function requiredText(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`Invalid ${name}`);
  }
}

function elicitationShape(value: unknown, depth = 0, key = "", budget = { remaining: 2048 }): unknown {
  if (budget.remaining < 32) return "[size limit]";
  budget.remaining -= 32;
  if (depth > 5) return "[depth limit]";
  if (value === null) return null;
  if (Array.isArray(value)) {
    const shape: unknown[] = [];
    for (const item of value.slice(0, 16)) {
      if (budget.remaining < 32) { shape.push("[size limit]"); break; }
      shape.push(elicitationShape(item, depth + 1, key, budget));
    }
    return shape;
  }
  if (record(value)) {
    const shape: RecordValue = {};
    for (const [name, item] of Object.entries(value).slice(0, 24)) {
      if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
      const label = name.slice(0, 80);
      const cost = Buffer.byteLength(label) + 8;
      if (budget.remaining < cost + 32) { shape["[truncated]"] = true; break; }
      budget.remaining -= cost;
      shape[label] = elicitationShape(item, depth + 1, name, budget);
    }
    return shape;
  }
  if (typeof value === "string" && ["type", "mode", "codex_approval_kind", "codex_request_type", "persist"].includes(key) &&
    ["object", "string", "boolean", "integer", "number", "array", "form", "openai/form", "openaiForm", "url", "mcp_tool_call", "browser_auth", "tool_suggestion", "approval_request", "session", "always"].includes(value)) return value;
  return `[${typeof value}]`;
}

function engineeringToolConfirmation(params: unknown): params is RecordValue & { threadId: string; turnId: string } {
  if (!record(params) || params.serverName !== "engineering" || params.mode !== "form" ||
    typeof params.threadId !== "string" || !params.threadId.trim() ||
    typeof params.turnId !== "string" || !params.turnId.trim() ||
    typeof params.message !== "string" || !params.message.trim() || params.message.length > 2048 ||
    !record(params.requestedSchema) || !record(params._meta)) return false;
  const schema = params.requestedSchema;
  const meta = params._meta;
  if (schema.type !== "object" || !record(schema.properties) || Object.keys(schema.properties).length !== 0 ||
    Object.keys(schema).some((key) => !["type", "properties", "required"].includes(key)) ||
    (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
    meta.codex_approval_kind !== "mcp_tool_call" || meta.codex_requires_user_input === true ||
    (meta.codex_request_type !== undefined && meta.codex_request_type !== "approval_request")) return false;
  return Buffer.byteLength(JSON.stringify(params)) <= 32 * 1024;
}

// Protocol payloads can contain tool environment values; redact them at the UI boundary.
export function redact(value: unknown, depth = 0, secrets: readonly string[] = []): unknown {
  if (depth > 30) return "[redacted: depth limit]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, secrets));
  if (record(value)) {
    const output: RecordValue = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      output[key] = /(?:access.?token|refresh.?token|id.?token|api.?key|secret|password|authorization|credential)|^token$/i.test(key)
        ? "[redacted]" : redact(item, depth + 1, secrets);
    }
    return output;
  }
  if (typeof value === "string") {
    let text = value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)["']?\s*[=:]\s*["']?)[^\s"'&,;}\]]+/gi, "$1[redacted]");
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    return text;
  }
  return value;
}

export class CodexAdapter {
  private process?: ChildProcessWithoutNullStreams;
  private phase: EngineState = "stopped";
  private generation = Date.now() * 1000 + randomInt(1000);
  private sequence = 0;
  private requestNumber = 0;
  private pending = new Map<string, Pending>();
  private approvals = new Map<string, EngineApproval>();
  private workspaces = new Map<string, string>();
  private lifecycle = 0;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private diagnostics = 0;
  private droppedDiagnostics = 0;
  private privateHome: string;
  private requestTimeoutMs: number;
  private shutdown?: Promise<void>;
  private readonly secrets: string[];

  constructor(private readonly options: CodexAdapterOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.home)) {
      throw new Error("Engine executable and product CODEX_HOME must be absolute paths");
    }
    this.privateHome = resolve(options.home);
    if (options.processHost !== undefined && !isAbsolute(options.processHost)) throw new Error("Process host must be an absolute path");
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^FORGEDESK_RUNNER_[A-Z0-9_]+$/.test(key) && key !== "ELECTRON_RUN_AS_NODE") {
        throw new Error(`Engine environment override is not allowed: ${key}`);
      }
      if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid engine environment value");
    }
    this.secrets = Object.entries(options.env ?? {}).filter(([key, value]) => /TOKEN|PASSWORD|SECRET|KEY/i.test(key) && value.length >= 8).map(([, value]) => value);
    if (inside(resolve(homedir(), ".codex"), this.privateHome)) {
      throw new Error("Product CODEX_HOME must be separate from the existing Codex directory");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs < 10 || this.requestTimeoutMs > 120_000) {
      throw new Error("Request timeout must be between 10 and 120000 ms");
    }
  }

  get state(): EngineState { return this.phase; }
  get connectionGeneration(): number { return this.generation; }

  async snapshotPolicy(projectRoot: string): Promise<SnapshotPolicyEvidence> {
    if (this.phase !== "ready") throw new Error("Engine is not ready for snapshot policy verification");
    requiredText(projectRoot, "snapshot project root");
    if (!isAbsolute(projectRoot)) throw new Error("Snapshot project root must be absolute");
    const cwd = await realpath(projectRoot);
    if (!(await stat(cwd)).isDirectory() || inside(cwd, this.privateHome) || inside(this.privateHome, cwd)) {
      throw new Error("Snapshot project root overlaps product engine data or is invalid");
    }
    const generation = this.generation;
    const config = await this.request("config/read", { includeLayers: false, cwd });
    this.checkConfig(config);
    const requirements = await this.request("configRequirements/read", {});
    this.checkRequirements(requirements);
    if (generation !== this.generation || this.phase !== "ready" || !record(config) || !record(config.config) || !record(requirements)) {
      throw new Error("Engine connection changed during snapshot policy verification");
    }
    const effective: RecordValue = {};
    for (const key of ["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "default_permissions", "permissions", "windows", "features"]) {
      effective[key] = config.config[key] ?? null;
    }
    const managed: RecordValue = {};
    if (record(requirements.requirements)) {
      for (const key of ["allowedApprovalPolicies", "allowedSandboxModes", "allowedWindowsSandboxImplementations", "allowedPermissionProfiles", "defaultPermissions", "featureRequirements", "allowLoginShell"]) {
        managed[key] = requirements.requirements[key] ?? null;
      }
    }
    return { schemaVersion: 1, method: "app-server/config-read", generation, observedAt: new Date().toISOString(),
      projectRoot: cwd, home: this.privateHome, effectivePolicySha256: digestSnapshotPolicyValue(effective), managedPolicySha256: digestSnapshotPolicyValue(managed) };
  }

  start(): Promise<void> {
    if (this.phase === "ready") return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start());
    this.starting = this.startConnection().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startConnection(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    await this.stopProcess();
    if (lifecycle !== this.lifecycle) throw new Error("Engine startup was cancelled");
    await mkdir(this.privateHome, { recursive: true });
    if (lifecycle !== this.lifecycle) throw new Error("Engine startup was cancelled");
    this.privateHome = await realpath(this.privateHome);
    if (lifecycle !== this.lifecycle) throw new Error("Engine startup was cancelled");
    if (inside(resolve(homedir(), ".codex"), this.privateHome)) {
      throw new Error("Product CODEX_HOME resolves into the existing Codex directory");
    }
    const generation = ++this.generation;
    this.sequence = 0;
    this.diagnostics = 0;
    this.droppedDiagnostics = 0;
    this.workspaces.clear();
    this.approvals.clear();
    this.setState("starting");
    try {
      const child = this.createProcess(this.childEnvironment());
      this.process = child;
      this.attach(child, generation);
      const params: InitializeParams = {
        clientInfo: { name: "forgedesktop", title: "ForgeDesk", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      const initialized = await this.request("initialize", params, true);
      if (!record(initialized) || typeof initialized.userAgent !== "string" ||
        !initialized.userAgent.startsWith(`forgedesktop/${CODEX_PROTOCOL_VERSION} (`)) {
        throw new Error(`Engine version does not match the generated protocol ${CODEX_PROTOCOL_VERSION}`);
      }
      if (typeof initialized.codexHome !== "string" || relative(this.privateHome, resolve(initialized.codexHome)) !== "") {
        throw new Error("Engine initialized outside the product CODEX_HOME");
      }
      await this.write({ method: "initialized" }, generation);
      const config = await this.request("config/read", { includeLayers: false, cwd: this.privateHome }, true);
      this.checkConfig(config);
      const requirements = await this.request("configRequirements/read", {}, true);
      this.checkRequirements(requirements);
      if (process.platform === "win32") {
        const readiness = await this.request("windowsSandbox/readiness", {}, true);
        this.emit("engine/sandboxReadiness", readiness);
      }
      if (generation !== this.generation || this.process !== child || this.phase !== "starting") {
        throw new Error("Engine connection changed during initialization");
      }
      this.emit("engine/initialized", initialized);
      this.emit("engine/policy", { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
      this.setState("ready");
    } catch (error) {
      if (lifecycle === this.lifecycle) this.fail(error instanceof Error ? error : new Error(String(error)), generation);
      await this.stopProcess();
      throw error;
    }
  }

  protected createProcess(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    const args = [
      "app-server", "--listen", "stdio://", "--strict-config",
      ...workspacePolicyConfigArgs({ windowsSandbox: process.platform === "win32" ? "unelevated" : undefined }),
    ];
    return spawn(this.options.processHost ?? this.options.executable,
      this.options.processHost ? ["--", this.options.executable, ...args] : args,
      { cwd: this.privateHome, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/(?:CODEX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL)/i.test(key)) env[key] = value;
    }
    env.CODEX_HOME = this.privateHome;
    Object.assign(env, this.options.env ?? {});
    return env;
  }

  private attach(child: ChildProcessWithoutNullStreams, generation: number): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation !== this.generation || this.process !== child || this.state === "failed") return;
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          this.fail(new Error("Engine protocol line exceeded its size limit"), generation);
          void this.stopProcess();
          return;
        }
        if (line.trim()) this.receive(line, generation);
        if (this.phase === "failed") return;
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        buffer = "";
        this.fail(new Error("Engine protocol line exceeded its size limit"), generation);
        void this.stopProcess();
      }
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer.trim() && generation === this.generation && this.process === child && this.phase !== "stopping") {
        this.fail(new Error("Engine stdout ended with an incomplete JSONL message"), generation);
      }
    });
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr.on("data", (chunk: Buffer) => this.diagnostic(stderrDecoder.write(chunk).slice(0, 2048), generation));
    child.stdin.on("error", (error) => this.fail(new Error(`Engine input failed: ${error.message}`), generation));
    child.on("error", (error) => this.fail(new Error(`Engine process failed: ${error.message}`), generation));
    child.on("close", (code, signal) => {
      if (generation !== this.generation || this.process !== child) return;
      this.process = undefined;
      this.rejectPending(new Error(`Engine exited (code ${code}, signal ${signal})`));
      this.approvals.clear();
      this.workspaces.clear();
      this.emit("engine/exit", { code, signal });
      this.setState(this.phase === "stopping" ? "stopped" : "failed");
    });
  }

  private receive(line: string, generation: number): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.fail(new Error("Engine stdout contained invalid JSON"), generation); void this.stopProcess(); return; }
    if (!record(message)) {
      this.fail(new Error("Engine stdout contained a non-object protocol message"), generation);
      void this.stopProcess();
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message) {
        if (!rpcId(message.id)) { this.fail(new Error("Engine request used an invalid ID"), generation); return; }
        void this.serverRequest(message.method, message.id, message.params, generation).catch((error: Error) => this.fail(error, generation));
      } else {
        if (message.method === "serverRequest/resolved" && record(message.params) && rpcId(message.params.requestId)) {
          this.approvals.delete(idKey(message.params.requestId));
        }
        if (NOTIFICATIONS.has(message.method)) this.emit(message.method, message.params ?? null);
        else this.diagnostic(`Unknown notification: ${message.method.slice(0, 100)}`, generation);
      }
      return;
    }
    if (!rpcId(message.id)) { this.fail(new Error("Engine response omitted its request ID"), generation); return; }
    const pending = this.pending.get(idKey(message.id));
    if (!pending || pending.generation !== generation) {
      this.diagnostic("Ignored an unmatched or expired engine response", generation);
      return;
    }
    this.pending.delete(idKey(message.id));
    clearTimeout(pending.timer);
    if (record(message.error)) {
      pending.reject(new Error(`Engine ${pending.method}: ${String(this.publicValue(message.error.message ?? "RPC failed"))}`));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(`Engine ${pending.method} returned an invalid response`));
    }
  }

  private async serverRequest(method: string, id: RpcId, params: unknown, generation: number): Promise<void> {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      if (this.phase !== "ready") {
        await this.write({ id, result: { decision: "cancel" } }, generation);
        return;
      }
      if (!record(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string" || typeof params.itemId !== "string" ||
        !this.workspaces.has(params.threadId)) {
        await this.write({ id, error: { code: -32602, message: "Invalid approval parameters" } }, generation);
        return;
      }
      const key = idKey(id);
      if (this.approvals.has(key)) {
        this.fail(new Error("Engine reused a pending approval request ID"), generation);
        await this.stopProcess();
        return;
      }
      if (this.approvals.size >= MAX_APPROVALS) {
        await this.write({ id, result: { decision: "cancel" } }, generation);
        this.diagnostic("Approval queue limit reached; request cancelled", generation);
        return;
      }
      // This version exposes four scalar decisions, plus amendment objects we do not grant.
      const availableDecisions = params.availableDecisions;
      const decisions = Array.isArray(availableDecisions)
        ? SCALAR_DECISIONS.filter((decision) => availableDecisions.includes(decision))
        : [...SCALAR_DECISIONS];
      if (!decisions.length) {
        await this.write({ id, error: { code: -32602, message: "No supported approval decisions" } }, generation);
        return;
      }
      const approval: EngineApproval = { generation, id, method, params: this.publicValue(params), decisions };
      this.approvals.set(key, approval);
      this.emit("engine/approval", approval);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      const request = record(params) ? params : {};
      const supported = this.phase === "ready" && engineeringToolConfirmation(params) && this.workspaces.has(params.threadId);
      this.diagnostic("MCP elicitation request shape", generation, {
        id,
        supported,
        threadId: typeof request.threadId === "string" ? request.threadId.slice(0, 128) : null,
        turnId: typeof request.turnId === "string" ? request.turnId.slice(0, 128) : null,
        serverName: request.serverName === "engineering" ? "engineering" : "[other/unknown server]",
        mode: typeof request.mode === "string" && ["form", "openai/form", "openaiForm", "url"].includes(request.mode) ? request.mode : "[unknown mode]",
        message: typeof request.message === "string" ? request.message.slice(0, 512) : null,
        requestedSchema: elicitationShape(request.requestedSchema),
        _meta: elicitationShape(request._meta),
      });
      if (supported) {
        const key = idKey(id);
        if (this.approvals.has(key)) {
          this.fail(new Error("Engine reused a pending approval request ID"), generation);
          await this.stopProcess();
          return;
        }
        if (this.approvals.size < MAX_APPROVALS) {
          const approval: EngineApproval = {
            generation, id, method, params: this.publicValue(params), decisions: ["accept", "decline", "cancel"],
          };
          this.approvals.set(key, approval);
          this.emit("engine/approval", approval);
          return;
        }
        this.diagnostic("Approval queue limit reached; MCP confirmation cancelled", generation);
      }
      await this.write({ id, result: { action: "cancel", content: null, _meta: null } }, generation);
    } else if (method === "item/permissions/requestApproval") {
      await this.write({ id, result: { permissions: {}, scope: "turn" } }, generation);
    } else if (method === "item/tool/requestUserInput") {
      await this.write({ id, error: { code: -32601, message: "Interactive user-input tools are not supported by this client" } }, generation);
    } else {
      await this.write({ id, error: { code: -32601, message: "Server request method is not supported by this client" } }, generation);
    }
    this.diagnostic(`Responded to unsupported server request: ${method.slice(0, 100)}`, generation);
  }

  private request(method: AllowedMethod, params: unknown, initializing = false): Promise<unknown> {
    if ((!initializing && this.phase !== "ready") || !this.process || this.phase === "stopping" || this.phase === "failed") {
      return Promise.reject(new Error("Engine is not ready"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Too many pending engine requests"));
    const generation = this.generation;
    const id = `forge:${generation}:${++this.requestNumber}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id));
        this.emit("engine/requestTimeout", { method, requestId: id, outcomeUnknown: true });
        reject(new Error(`Engine ${method} timed out; request was not replayed`));
      }, this.requestTimeoutMs);
      this.pending.set(idKey(id), { generation, method, resolve: resolveRequest, reject, timer });
      void this.write({ id, method, params }, generation).catch((error: Error) => {
        const pending = this.pending.get(idKey(id));
        if (pending) { clearTimeout(pending.timer); this.pending.delete(idKey(id)); pending.reject(error); }
      });
    });
  }

  private write(message: unknown, generation: number): Promise<void> {
    const child = this.process;
    if (generation !== this.generation || !child || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error("Engine connection is no longer writable"));
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) + child.stdin.writableLength > MAX_OUTBOUND_BYTES) {
      return Promise.reject(new Error("Engine input queue exceeded its size limit"));
    }
    return new Promise((resolveWrite, reject) => {
      child.stdin.write(line, (error) => error ? reject(error) : resolveWrite());
    });
  }

  private checkConfig(value: unknown): void {
    if (!record(value) || !record(value.config)) throw new Error("Engine config/read returned an invalid configuration");
    assertWorkspacePolicyConfig(value.config);
  }

  private checkRequirements(value: unknown): void {
    if (!record(value)) throw new Error("Engine config requirements were not readable");
    if (value.requirements === null) return;
    if (!record(value.requirements)) throw new Error("Engine returned invalid config requirements");
    const requirements = value.requirements;
    assertWorkspacePolicyRequirements(requirements);
    for (const [key, needed] of [["allowedApprovalPolicies", "on-request"], ["allowedSandboxModes", "workspace-write"]]) {
      const allowed = requirements[key!];
      if (Array.isArray(allowed) && !allowed.includes(needed)) throw new Error(`Managed policy disallows ${needed}`);
    }
    if (typeof requirements.cliAuthCredentialsStore === "string" && requirements.cliAuthCredentialsStore !== "file") {
      throw new Error("Managed credential storage is incompatible with product authentication isolation");
    }
    if (process.platform === "win32" && Array.isArray(requirements.allowedWindowsSandboxImplementations) &&
      !requirements.allowedWindowsSandboxImplementations.includes("unelevated")) {
      throw new Error("Managed policy disallows the product's unelevated Windows sandbox");
    }
    for (const key of ["sqliteHome", "logDir"]) {
      const path = requirements[key];
      if (typeof path === "string" && !inside(this.privateHome, resolve(path))) {
        throw new Error(`Managed ${key} redirects engine data outside product CODEX_HOME`);
      }
    }
    this.emit("engine/configRequirements", {
      allowedApprovalPolicies: requirements.allowedApprovalPolicies ?? null,
      allowedSandboxModes: requirements.allowedSandboxModes ?? null,
      allowedWindowsSandboxImplementations: requirements.allowedWindowsSandboxImplementations ?? null,
    });
  }

  async models(): Promise<unknown> {
    return this.publicValue(await this.request("model/list", { limit: 100, includeHidden: false }));
  }

  async account(): Promise<unknown> {
    const result = await this.request("account/read", { refreshToken: false });
    if (!record(result)) throw new Error("Engine returned invalid account data");
    const account = result.account;
    const publicAccount = record(account) ? {
      type: account.type,
      ...(typeof account.email === "string" ? { email: account.email } : {}),
      ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
    } : null;
    return { account: publicAccount, requiresOpenaiAuth: result.requiresOpenaiAuth === true };
  }

  async login(): Promise<unknown> {
    const result = await this.request("account/login/start", { type: "chatgpt" });
    if (!record(result) || result.type !== "chatgpt" || typeof result.loginId !== "string" || typeof result.authUrl !== "string") {
      throw new Error("Engine returned an unsupported login response");
    }
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.username || url.password) {
      throw new Error("Engine returned an untrusted login URL");
    }
    return { type: "chatgpt", loginId: result.loginId, authUrl: url.href };
  }

  private async workspace(cwd: string): Promise<string> {
    requiredText(cwd, "workspace directory");
    if (!isAbsolute(cwd)) throw new Error("Workspace directory must be absolute");
    const path = await realpath(cwd);
    if (!(await stat(path)).isDirectory()) throw new Error("Workspace path must be a directory");
    if (inside(path, this.privateHome) || inside(this.privateHome, path)) throw new Error("Workspace and product engine data must not overlap");
    this.checkConfig(await this.request("config/read", { includeLayers: false, cwd: path }));
    return path;
  }

  private rememberThread(result: unknown, cwd: string): unknown {
    if (!record(result) || !record(result.thread) || typeof result.thread.id !== "string" ||
      result.approvalPolicy !== "on-request" || result.approvalsReviewer !== "user" || !record(result.sandbox) ||
      result.sandbox.type !== "workspaceWrite" || result.sandbox.networkAccess !== false ||
      result.sandbox.excludeTmpdirEnvVar !== true || result.sandbox.excludeSlashTmp !== true) {
      throw new Error("Engine thread did not confirm the requested workspace and approval policy");
    }
    if (typeof result.cwd !== "string" || relative(cwd, resolve(result.cwd)) !== "") {
      throw new Error("Engine thread returned an unexpected workspace directory");
    }
    const roots = result.sandbox.writableRoots;
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !inside(cwd, resolve(root)))) {
      throw new Error("Engine thread returned an unexpected writable root");
    }
    this.workspaces.set(result.thread.id, cwd);
    return this.publicValue(result);
  }

  async startThread(cwd: string, model?: string, developerInstructions?: string): Promise<unknown> {
    const path = await this.workspace(cwd);
    if (model !== undefined) requiredText(model, "model");
    if (developerInstructions !== undefined) requiredText(developerInstructions, "developer instructions");
    const params: ThreadStartParams = { cwd: path, model, developerInstructions, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
    return this.rememberThread(await this.request("thread/start", params), path);
  }

  async resumeThread(threadId: string, cwd: string, developerInstructions?: string): Promise<unknown> {
    requiredText(threadId, "thread ID");
    const path = await this.workspace(cwd);
    if (developerInstructions !== undefined) requiredText(developerInstructions, "developer instructions");
    const params: ThreadResumeParams = { threadId, cwd: path, developerInstructions, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
    return this.rememberThread(await this.request("thread/resume", params), path);
  }

  async send(threadId: string, text: string, model?: string): Promise<unknown> {
    requiredText(threadId, "thread ID"); requiredText(text, "message");
    const cwd = this.workspaces.get(threadId);
    if (!cwd) throw new Error("Thread must be started or resumed in this connection before sending");
    if (model !== undefined) requiredText(model, "model");
    const sandboxPolicy: SandboxPolicy = {
      type: "workspaceWrite", writableRoots: [cwd], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    };
    const params: TurnStartParams = {
      threadId, input: [{ type: "text", text, text_elements: [] }], cwd, model,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy,
    };
    return this.publicValue(await this.request("turn/start", params));
  }

  async steer(threadId: string, turnId: string, text: string): Promise<unknown> {
    requiredText(threadId, "thread ID"); requiredText(turnId, "turn ID"); requiredText(text, "message");
    if (!this.workspaces.has(threadId)) throw new Error("Thread is not loaded in this connection");
    const params: TurnSteerParams = { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] };
    return this.publicValue(await this.request("turn/steer", params));
  }

  async interrupt(threadId: string, turnId: string): Promise<unknown> {
    requiredText(threadId, "thread ID"); requiredText(turnId, "turn ID");
    if (!this.workspaces.has(threadId)) throw new Error("Thread is not loaded in this connection");
    return this.publicValue(await this.request("turn/interrupt", { threadId, turnId }));
  }

  pendingApprovals(): EngineApproval[] {
    return structuredClone([...this.approvals.values()]);
  }

  async approve(generation: number, id: RpcId, decision: string): Promise<void> {
    if (this.phase !== "ready" || generation !== this.generation) throw new Error("Approval belongs to an expired engine connection");
    if (!rpcId(id)) throw new Error("Invalid approval request ID");
    const key = idKey(id);
    const approval = this.approvals.get(key);
    if (!approval || approval.generation !== generation) throw new Error("Approval request is no longer pending");
    if (!approval.decisions.includes(decision)) throw new Error("Decision is not allowed for this approval request");
    this.approvals.delete(key);
    try {
      if (approval.method === "mcpServer/elicitation/request") {
        if (decision !== "accept" && decision !== "decline" && decision !== "cancel") throw new Error("Invalid MCP approval decision");
        const result: McpServerElicitationRequestResponse = {
          action: decision, content: decision === "accept" ? {} : null, _meta: null,
        };
        await this.write({ id, result }, generation);
      } else {
        await this.write({ id, result: { decision } }, generation);
      }
      this.emit("engine/approvalResolved", { id, decision });
    } catch (error) {
      this.fail(new Error("Approval delivery failed; connection cannot be reused"), generation);
      await this.stopProcess();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.lifecycle;
    this.stopping = (async () => {
      if (this.droppedDiagnostics) this.emit("engine/diagnosticsSummary", { samples: this.diagnostics, dropped: this.droppedDiagnostics });
      this.setState("stopping");
      this.rejectPending(new Error("Engine was stopped"));
      this.approvals.clear(); this.workspaces.clear();
      await this.stopProcess();
      await this.starting?.catch(() => {});
      this.setState("stopped");
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async stopProcess(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    const child = this.process;
    if (!child) return;
    this.shutdown = new Promise<void>((resolveStop) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(killTimer); child.off("close", finish); resolveStop(); };
      child.once("close", finish);
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === "win32" && child.pid) {
            const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
            killer.once("error", () => child.kill());
          } else child.kill("SIGKILL");
        }, 1500);
        child.stdin.end();
      }
    }).finally(() => { this.shutdown = undefined; });
    await this.shutdown;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private fail(error: Error, generation: number): void {
    if (generation !== this.generation || this.phase === "stopping" || this.phase === "stopped") return;
    this.rejectPending(error); this.approvals.clear(); this.workspaces.clear();
    this.diagnostic(error.message, generation);
    this.setState("failed");
    void this.stopProcess();
  }

  private setState(state: EngineState): void { this.phase = state; this.emit("engine/state", { state }); }
  private diagnostic(message: string, generation: number, details?: unknown): void {
    if (generation !== this.generation) return;
    if (this.diagnostics >= MAX_DIAGNOSTICS) { this.droppedDiagnostics++; return; }
    this.diagnostics++;
    this.emit("engine/diagnostic", { message: message.slice(0, 2048), sample: this.diagnostics, ...(details === undefined ? {} : { details }) });
  }
  private emit(method: string, params: unknown): void {
    const event: EngineEvent = { generation: this.generation, sequence: ++this.sequence, method, params: this.publicValue(params) };
    try { this.options.onEvent(event); }
    catch {
      this.rejectPending(new Error("Engine event consumer failed; event history may be incomplete"));
      this.approvals.clear(); this.workspaces.clear(); this.phase = "failed";
      void this.stopProcess();
    }
  }
  private publicValue(value: unknown): unknown { return redact(value, 0, this.secrets); }
}
