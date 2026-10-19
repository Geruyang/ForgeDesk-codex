import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DynamicToolCallParams } from "../../schemas/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "../../schemas/v2/DynamicToolCallResponse";
import { CODEX_PROTOCOL_VERSION, redact, type EngineEvent, type EngineState } from "./index";
import { presetTools, presetToolSpecs, type PresetToolName, type RestrictedPreset, type RestrictedToolName } from "./restricted-presets";
export { RESTRICTED_HARDWARE_TOOLS, type RestrictedHardwareToolName } from "./restricted-presets";

export const RESTRICTED_HARDWARE_MODEL = "gpt-6.1-sol";
export type RestrictedHardwareToolContext = Readonly<{ generation: number; threadId: string; turnId: string; callId: string }>;
export type RestrictedHardwareAdapterOptions<P extends RestrictedPreset = "stm32"> = {
  executable: string;
  home: string;
  processHost?: string;
  onEvent: (event: EngineEvent) => void;
  onToolCall: (context: RestrictedHardwareToolContext, name: PresetToolName<P>, args: Record<string, never>) => Promise<unknown>;
  requestTimeoutMs?: number;
  preset?: P;
};
export type RestrictedHardwarePolicySnapshot = {
  schemaVersion: 1;
  profile: "restricted-hardware" | "restricted-fz3b";
  protocolVersion: string;
  executableSha256: string;
  bundledCatalogSha256: string;
  catalogSha256: string;
  model: typeof RESTRICTED_HARDWARE_MODEL;
  tools: readonly RestrictedToolName[];
  environments: readonly [];
  externalMcp: "disabled";
  freshThreadOnly: true;
  effectiveConfigSha256: string;
};

const EXECUTABLE_SHA256 = "e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e";
const PROCESS_HOST_SHA256 = "722cfcd0d9ea9d187663c2f58b2e31f3dde2a00500a9aec3471d7ecedbe8d4ab";
const BUNDLED_SHA256 = "69af12f94a39dabd1a1ded8f5257b4884d2118902ea2b5b9cffbf4a1925dfa65";
const CATALOG_SHA256 = "93be33523cf97bae69f7cc8d2800552d2e15b1279a0e2f2e2aa7528949b80dac";
const DISABLED_FEATURES = ["shell_tool", "stable_environment_tools", "code_mode", "apps", "plugins", "hooks", "plugin_hooks", "multi_agent", "multi_agent_v2", "goals", "current_time_reminder", "sleep_tool", "memories", "tool_search", "skill_mcp_dependency_install", "remote_plugin", "tool_suggest"];
const LIMIT = 4 * 1024 * 1024;
const PROCESS_CLOSE_TIMEOUT_MS = 5000;
type Obj = Record<string, unknown>;
type Id = string | number;
type Pending = { generation: number; method: string; timer: ReturnType<typeof setTimeout>; resolve: (value: unknown) => void; reject: (error: Error) => void };
type Call = { fingerprint: string; result: Promise<DynamicToolCallResponse> };
function object(value: unknown): value is Obj { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is Id { return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value); }
function key(value: Id): string { return `${typeof value}:${value}`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function inside(root: string, path: string): boolean { const p = relative(root, path); return p === "" || p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p); }
async function fileHash(path: string): Promise<string> { const h = createHash("sha256"); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest("hex"); }
function safeText(value: unknown, name: string, limit = 65536): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > limit) throw new Error(`Invalid ${name}`);
}
/** A separate engine profile: no arbitrary RPC, resumed thread, environment, or tool definition. */
export class RestrictedHardwareAdapter<P extends RestrictedPreset = "stm32"> {
  private child?: ChildProcessWithoutNullStreams;
  private utility?: ChildProcess;
  private utilityClosing?: Promise<void>;
  private observedUtilities = new WeakSet<ChildProcess>();
  private closedUtilities = new WeakSet<ChildProcess>();
  private lifecycle = 0;
  private phase: EngineState = "stopped";
  private generation = Date.now() * 1000 + randomInt(1000);
  private sequence = 0;
  private requestNumber = 0;
  private pending = new Map<string, Pending>();
  private calls = new Map<string, Call>();
  private serverIds = new Map<string, string>();
  private repliedServerIds = new Set<string>();
  private threadId?: string;
  private threadRequested = false;
  private turnId?: string;
  private turnRequested = false;
  private turnFinished = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private closingChildren = new WeakSet<ChildProcess>();
  private privateHome: string;
  private workspace = "";
  private catalog = "";
  private disabledMcp: string[] = [];
  private policy?: RestrictedHardwarePolicySnapshot;
  private diagnostics = 0;
  private readonly timeout: number;
  private readonly preset: RestrictedPreset;

  constructor(private readonly options: RestrictedHardwareAdapterOptions<P>) {
    this.preset = options.preset ?? "stm32";
    presetTools(this.preset);
    if (!isAbsolute(options.executable) || !isAbsolute(options.home) || options.processHost !== undefined && !isAbsolute(options.processHost)) throw new Error("Restricted engine paths must be absolute");
    this.privateHome = resolve(options.home);
    if (inside(resolve(homedir(), ".codex"), this.privateHome)) throw new Error("Restricted engine must use the product CODEX_HOME");
    this.timeout = options.requestTimeoutMs ?? 30000;
    if (!Number.isFinite(this.timeout) || this.timeout < 10 || this.timeout > 120000) throw new Error("Invalid restricted request timeout");
  }
  get state(): EngineState { return this.phase; }
  get connectionGeneration(): number { return this.generation; }
  policySnapshot(): RestrictedHardwarePolicySnapshot {
    if (!this.policy || this.phase !== "ready") throw new Error("Restricted engine policy is not verified");
    return structuredClone(this.policy);
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
    try { await Promise.all([this.closeUtility(), this.closeChild()]); }
    catch (error) { if (lifecycle === this.lifecycle) this.fail(error); throw error; }
    if (lifecycle !== this.lifecycle) throw new Error("Restricted startup was cancelled");
    this.reset();
    this.setState("starting");
    try {
      await mkdir(this.privateHome, { recursive: true });
      this.privateHome = await realpath(this.privateHome);
      if (inside(resolve(homedir(), ".codex"), this.privateHome)) throw new Error("Restricted home resolves into existing Codex data");
      this.workspace = resolve(this.privateHome, this.preset === "fz3b" ? "restricted-fz3b-workspace" : "restricted-hardware-workspace");
      await mkdir(this.workspace, { recursive: true });
      if (relative(this.workspace, await realpath(this.workspace)) !== "") throw new Error("Restricted workspace must not be a symlink");
      if (lifecycle !== this.lifecycle) throw new Error("Restricted startup was cancelled");
      await this.prepareRuntime();
      if (lifecycle !== this.lifecycle) throw new Error("Restricted startup was cancelled");
      this.disabledMcp = [];
      let config = await this.openConnection();
      if (lifecycle !== this.lifecycle) throw new Error("Restricted startup was cancelled");
      if (!object(config.mcp_servers)) throw new Error("Restricted MCP configuration is invalid");
      this.disabledMcp = Object.keys(config.mcp_servers);
      if (this.disabledMcp.length > 128 || this.disabledMcp.some(name => !/^[A-Za-z0-9_-]{1,128}$/.test(name))) throw new Error("Restricted MCP server names cannot be safely disabled");
      if (this.disabledMcp.length) {
        await this.closeChild();
        config = await this.openConnection();
        if (lifecycle !== this.lifecycle) throw new Error("Restricted startup was cancelled");
      }
      this.checkConfig(config);
      this.policy = {
        schemaVersion: 1, profile: this.preset === "fz3b" ? "restricted-fz3b" : "restricted-hardware", protocolVersion: CODEX_PROTOCOL_VERSION,
        executableSha256: EXECUTABLE_SHA256, bundledCatalogSha256: BUNDLED_SHA256, catalogSha256: CATALOG_SHA256,
        model: RESTRICTED_HARDWARE_MODEL, tools: [...presetTools(this.preset)], environments: [], externalMcp: "disabled", freshThreadOnly: true,
        effectiveConfigSha256: hash(JSON.stringify({ approval: config.approval_policy, sandbox: config.sandbox_mode, features: config.features, catalog: CATALOG_SHA256, disabledMcpCount: this.disabledMcp.length, preset: this.preset, tools: presetTools(this.preset) })),
      };
      this.setState("ready");
      this.emit("engine/policy", this.policy);
    } catch (error) {
      if (lifecycle === this.lifecycle) { this.fail(error); await this.closeChild(); }
      throw error;
    }
  }
  protected async prepareRuntime(): Promise<void> {
    if (await fileHash(this.options.executable) !== EXECUTABLE_SHA256) throw new Error("Restricted engine binary hash mismatch");
    if (this.options.processHost && await fileHash(this.options.processHost) !== PROCESS_HOST_SHA256) throw new Error("Restricted process host hash mismatch");
    const env = this.environment();
    const bundled = await new Promise<string>((resolveOutput, reject) => {
      const process = spawn(this.options.executable, ["debug", "models", "--bundled"], { cwd: this.workspace, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.utility = process;
      this.observeUtility(process);
      const chunks: Buffer[] = []; let bytes = 0;
      let failed = false;
      const failUtility = (error: Error) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        void this.closeUtility().then(() => reject(error), cleanupError => reject(new AggregateError([error, cleanupError], "Bundled catalog failed and utility exit was not confirmed")));
      };
      const timer = setTimeout(() => failUtility(new Error("Bundled catalog timed out")), 15000);
      process.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > LIMIT) failUtility(new Error("Bundled catalog exceeded its limit")); else if (!failed) chunks.push(chunk); });
      process.stderr.resume();
      process.on("error", failUtility);
      process.on("close", code => { clearTimeout(timer); if (!failed) code === 0 ? resolveOutput(Buffer.concat(chunks).toString("utf8")) : reject(new Error("Bundled catalog extraction failed")); });
    });
    if (hash(bundled) !== BUNDLED_SHA256) throw new Error("Bundled model catalog hash mismatch");
    const parsed: unknown = JSON.parse(bundled);
    if (!object(parsed) || !Array.isArray(parsed.models)) throw new Error("Invalid bundled catalog");
    const model = parsed.models.find(value => object(value) && value.slug === RESTRICTED_HARDWARE_MODEL);
    if (!object(model)) throw new Error("Pinned model missing from bundled catalog");
    Object.assign(model, { shell_type: "disabled", apply_patch_tool_type: null, tool_mode: "direct", experimental_supported_tools: [], multi_agent_version: "disabled" });
    const content = JSON.stringify({ models: [model] }, null, 2);
    if (hash(content) !== CATALOG_SHA256) throw new Error("Restricted catalog hash mismatch");
    // Unique generated files avoid touching config.toml or authentication files.
    this.catalog = resolve(this.workspace, `catalog-${this.generation}-${randomInt(0x1000000)}.json`);
    await writeFile(this.catalog, content, { flag: "wx" });
  }
  private arguments(): string[] {
    const config = [
      `model=${JSON.stringify(RESTRICTED_HARDWARE_MODEL)}`, `model_provider=${JSON.stringify(this.providerName())}`, `model_catalog_json=${JSON.stringify(this.catalog.replaceAll("\\", "/"))}`,
      'approval_policy="never"', 'approvals_reviewer="user"', 'sandbox_mode="read-only"', 'web_search="disabled"',
      'cli_auth_credentials_store="file"', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', "analytics.enabled=false", "notify=[]", "project_doc_max_bytes=0", "include_environment_context=false", "check_for_update_on_startup=false",
      "tools.experimental_request_user_input.enabled=false", "tools.update_plan.enabled=false", ...DISABLED_FEATURES.map(name => `features.${name}=false`),
      ...this.disabledMcp.map(name => `mcp_servers.${name}.enabled=false`),
      ...this.providerOverrides(),
    ];
    return ["app-server", "--listen", "stdio://", "--strict-config", ...config.flatMap(value => ["-c", value])];
  }
  protected createProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    return spawn(this.options.processHost ?? this.options.executable, this.options.processHost ? ["--", this.options.executable, ...args] : args,
      { cwd: this.workspace, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  }
  // Trusted offline test subclasses replace only the provider transport, never tool policy.
  protected providerName(): string { return "openai"; }
  protected providerOverrides(): string[] { return []; }
  protected checkProvider(config: Obj): void {
    if (!object(config.model_providers) || config.model_providers.openai !== undefined || config.chatgpt_base_url !== "https://chatgpt.com/backend-api/" || config.openai_base_url != null) throw new Error("Restricted official provider cannot be overridden");
  }
  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!/(?:CODEX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL|FORGEDESK|NODE_OPTIONS|ELECTRON)/i.test(name)) env[name] = value;
    }
    env.CODEX_HOME = this.privateHome;
    return env;
  }
  private async openConnection(): Promise<Obj> {
    const generation = ++this.generation;
    const child = this.createProcess(this.arguments(), this.environment());
    this.child = child;
    this.attach(child, generation);
    const result = await this.request("initialize", { clientInfo: { name: "forgedesktop", title: "ForgeDesk restricted hardware", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } }, true);
    if (!object(result) || typeof result.userAgent !== "string" || !result.userAgent.startsWith(`forgedesktop/${CODEX_PROTOCOL_VERSION} (`) || typeof result.codexHome !== "string" || relative(this.privateHome, resolve(result.codexHome)) !== "") throw new Error("Restricted engine initialization identity mismatch");
    await this.write({ method: "initialized" }, generation);
    const config = await this.request("config/read", { includeLayers: false, cwd: this.workspace }, true);
    if (!object(config) || !object(config.config)) throw new Error("Restricted engine config is unreadable");
    return config.config;
  }
  private checkConfig(config: Obj): void {
    if (config.model_provider !== this.providerName() || config.model !== RESTRICTED_HARDWARE_MODEL || config.approval_policy !== "never" || config.sandbox_mode !== "read-only" || config.web_search !== "disabled" || config.model_catalog_json !== this.catalog) throw new Error("Restricted effective policy mismatch");
    const features = config.features;
    if (!object(features) || DISABLED_FEATURES.some(name => features[name] !== false)) throw new Error("Restricted features were not disabled");
    if (!object(config.mcp_servers) || Object.values(config.mcp_servers).some(server => !object(server) || server.enabled !== false)) throw new Error("Restricted external MCP is not disabled");
    this.checkProvider(config);
    if (config.notify != null && (!Array.isArray(config.notify) || config.notify.length)) throw new Error("Restricted notify command is not disabled");
  }
  async account(): Promise<unknown> {
    const value = await this.request("account/read", { refreshToken: false });
    if (!object(value)) throw new Error("Invalid restricted account response");
    const account = object(value.account) ? { type: value.account.type, ...(typeof value.account.email === "string" ? { email: value.account.email } : {}), ...(typeof value.account.planType === "string" ? { planType: value.account.planType } : {}) } : null;
    return redact({ account, requiresOpenaiAuth: value.requiresOpenaiAuth === true });
  }
  async startThread(model: string, developerInstructions: string): Promise<string> {
    this.checkModel(model);
    safeText(developerInstructions, "developer instructions");
    if (this.phase !== "ready" || this.threadRequested || this.pending.size) throw new Error("Restricted profile permits only one fresh thread");
    this.threadRequested = true;
    const value = await this.request("thread/start", { model, modelProvider: this.providerName(), cwd: this.workspace, runtimeWorkspaceRoots: [], ephemeral: true, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", environments: [], dynamicTools: presetToolSpecs(this.preset), baseInstructions: "You control only the fixed host tools supplied by ForgeDesk. Never request command execution, source editing, environments, external tools, credentials, paths, or authorization bypass. Native confirmation is owned by the host, not by model text.", developerInstructions });
    if (!object(value) || !object(value.thread) || typeof value.thread.id !== "string" || value.model !== model || value.modelProvider !== this.providerName() || value.approvalPolicy !== "never" || !object(value.sandbox) || value.sandbox.type !== "readOnly" || value.sandbox.networkAccess !== false || !Array.isArray(value.thread.environments) || value.thread.environments.length !== 0 || value.cwd !== this.workspace) {
      this.fail(new Error("Restricted thread did not confirm its policy"));
      await this.closeChild();
      throw new Error("Restricted thread did not confirm its policy");
    }
    this.threadId = value.thread.id;
    return this.threadId;
  }
  async send(threadId: string, text: string, model = RESTRICTED_HARDWARE_MODEL): Promise<unknown> {
    this.checkModel(model); safeText(text, "user text");
    if (threadId !== this.threadId || this.turnRequested) throw new Error("Restricted profile permits one turn on its fresh thread");
    this.turnRequested = true;
    const value = await this.request("turn/start", { threadId, model, environments: [], approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, input: [{ type: "text", text, text_elements: [] }] });
    if (!object(value) || !object(value.turn) || typeof value.turn.id !== "string" || this.turnId && this.turnId !== value.turn.id) throw new Error("Restricted turn identity mismatch");
    if (!this.turnFinished) this.turnId = value.turn.id;
    return redact(value);
  }
  interrupt(threadId: string, turnId: string): Promise<unknown> {
    if (threadId !== this.threadId || turnId !== this.turnId || this.turnFinished) return Promise.reject(new Error("Restricted turn identity mismatch"));
    return this.request("turn/interrupt", { threadId, turnId });
  }
  private checkModel(model: string): void { if (model !== RESTRICTED_HARDWARE_MODEL) throw new Error("Restricted profile requires the pinned model"); }
  private attach(child: ChildProcessWithoutNullStreams, generation: number): void {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation !== this.generation || child !== this.child || this.phase === "failed") return;
      buffer += decoder.write(chunk);
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1);
        if (Buffer.byteLength(line) > LIMIT) { this.fail(new Error("Restricted engine line limit exceeded")); return; }
        if (line.trim()) this.receive(line, generation);
        if (this.state === "failed" || child !== this.child || generation !== this.generation) return;
      }
      if (Buffer.byteLength(buffer) > LIMIT) this.fail(new Error("Restricted engine line limit exceeded"));
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer.trim() && generation === this.generation && child === this.child && !this.closingChildren.has(child)) this.fail(new Error("Restricted engine ended with incomplete JSONL"));
    });
    const current = () => generation === this.generation && child === this.child && !this.closingChildren.has(child);
    child.stderr.on("data", () => { if (current() && this.diagnostics++ < 20) this.emit("engine/diagnostic", { message: "Restricted engine emitted a diagnostic; raw output withheld" }); });
    child.stdin.on("error", () => { if (current()) this.fail(new Error("Restricted engine input failed")); });
    child.on("error", () => { if (current()) this.fail(new Error("Restricted engine process failed")); });
    child.on("close", (code, signal) => {
      if (generation !== this.generation || child !== this.child) return;
      this.child = undefined; this.rejectPending(new Error("Restricted engine exited")); this.policy = undefined;
      if (this.closingChildren.has(child)) return;
      this.emit("engine/exit", { code, signal }); this.setState(this.phase === "stopping" ? "stopped" : "failed");
    });
  }
  private receive(line: string, generation: number): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.fail(new Error("Invalid restricted engine JSON")); return; }
    if (!object(value)) { this.fail(new Error("Invalid restricted engine message")); return; }
    if (typeof value.method === "string") {
      if ("id" in value) {
        if (!id(value.id)) { this.fail(new Error("Invalid restricted server request ID")); return; }
        void this.serverRequest(value.id, value.method, value.params, generation).catch(() => { if (generation === this.generation && this.phase !== "stopping") this.fail(new Error("Restricted server response failed")); });
      } else {
        const params = value.params;
        if (value.method === "model/rerouted") { this.fail(new Error("Restricted model rerouting is forbidden")); return; }
        if (value.method === "turn/started" && object(params) && params.threadId === this.threadId && object(params.turn) && typeof params.turn.id === "string" && this.turnRequested && !this.turnId) this.turnId = params.turn.id;
        if (value.method === "turn/completed" && object(params) && params.threadId === this.threadId && object(params.turn) && params.turn.id === this.turnId) this.turnFinished = true;
        const boundThread = object(params) && params.threadId === this.threadId && !!this.threadId;
        const boundTurn = boundThread && (typeof params.turnId === "string" ? params.turnId === this.turnId : object(params.turn) ? params.turn.id === this.turnId : !value.method.startsWith("turn/"));
        if ((value.method === "error" || value.method === "warning") || boundTurn && /^(?:thread\/|turn\/|item\/(?:started|completed|agentMessage\/delta|reasoning\/))/.test(value.method)) this.emit(value.method, params ?? null);
      }
      return;
    }
    if (!id(value.id)) { this.fail(new Error("Restricted response omitted ID")); return; }
    const pending = this.pending.get(key(value.id));
    if (!pending || pending.generation !== generation) return;
    this.pending.delete(key(value.id)); clearTimeout(pending.timer);
    if (object(value.error)) pending.reject(new Error(`Engine ${pending.method}: ${String(redact(value.error.message ?? "RPC failed"))}`));
    else if ("result" in value) pending.resolve(value.result);
    else pending.reject(new Error("Invalid restricted response"));
  }
  private async serverRequest(requestId: Id, method: string, params: unknown, generation: number): Promise<void> {
    const reject = (message: string) => this.write({ id: requestId, error: { code: -32602, message } }, generation);
    if (method !== "item/tool/call") {
      if (method === "mcpServer/elicitation/request") await this.write({ id: requestId, result: { action: "cancel", content: null, _meta: null } }, generation);
      else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") await this.write({ id: requestId, result: { decision: "cancel" } }, generation);
      else await this.write({ id: requestId, error: { code: -32601, message: "Request forbidden in restricted hardware profile" } }, generation);
      return;
    }
    if (this.phase !== "ready" || !object(params) || params.threadId !== this.threadId || params.turnId !== this.turnId || this.turnFinished || !this.turnId || typeof params.callId !== "string" || !params.callId || params.callId.length > 256 || params.namespace !== null || !presetTools(this.preset).includes(params.tool as RestrictedToolName) || !object(params.arguments) || Object.keys(params.arguments).length !== 0 || Object.keys(params).some(name => !["threadId", "turnId", "callId", "namespace", "tool", "arguments"].includes(name))) {
      await reject("Tool call does not match the fixed restricted turn and schema"); return;
    }
    const call = params as unknown as DynamicToolCallParams;
    const ledgerKey = `${generation}:${call.threadId}:${call.turnId}:${call.callId}`;
    const fingerprint = JSON.stringify([call.namespace, call.tool, call.arguments]);
    const previous = this.calls.get(ledgerKey);
    if (previous && previous.fingerprint !== fingerprint) { await reject("Tool call ID was reused with different arguments"); return; }
    const previousRequest = this.serverIds.get(key(requestId));
    if (previousRequest) {
      if (previousRequest !== ledgerKey) await reject("Server request ID was reused");
      else if (previous && this.repliedServerIds.has(key(requestId))) await this.write({ id: requestId, result: await previous.result }, generation);
      return;
    }
    if (this.serverIds.size >= 256) { await reject("Restricted server request limit exceeded"); return; }
    this.serverIds.set(key(requestId), ledgerKey);
    if (!previous && this.calls.size >= 64) { await reject("Restricted tool call limit exceeded"); return; }
    const context = Object.freeze({ generation, threadId: call.threadId, turnId: call.turnId, callId: call.callId });
    const entry = previous ?? { fingerprint, result: Promise.resolve().then(async () => {
      if (generation !== this.generation || this.phase !== "ready" || this.turnFinished || call.threadId !== this.threadId || call.turnId !== this.turnId) return { contentItems: [{ type: "inputText" as const, text: "Restricted call is no longer active." }], success: false };
      this.emit("engine/restrictedTool", { ...context, name: call.tool, status: "started" });
      try {
        const result = await this.options.onToolCall(context, call.tool as PresetToolName<P>, {});
        const text = JSON.stringify(redact(result ?? null));
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Tool result exceeded its limit");
        if (generation === this.generation && this.phase === "ready") this.emit("engine/restrictedTool", { ...context, name: call.tool, status: "completed" });
        return { contentItems: [{ type: "inputText" as const, text }], success: true };
      } catch {
        if (generation === this.generation && this.phase === "ready") this.emit("engine/restrictedTool", { ...context, name: call.tool, status: "failed" });
        return { contentItems: [{ type: "inputText" as const, text: "Host rejected or failed the fixed operation. Do not retry automatically." }], success: false };
      }
    }) };
    this.calls.set(ledgerKey, entry);
    const result = await entry.result;
    if (generation !== this.generation || this.phase !== "ready" || this.turnFinished) return;
    await this.write({ id: requestId, result }, generation);
    this.repliedServerIds.add(key(requestId));
  }
  private request(method: "initialize" | "config/read" | "account/read" | "thread/start" | "turn/start" | "turn/interrupt", params: unknown, initializing = false): Promise<unknown> {
    if (!this.child || !initializing && this.phase !== "ready" || this.pending.size >= 32) return Promise.reject(new Error("Restricted engine is not ready"));
    const generation = this.generation; const requestId = `restricted:${generation}:${++this.requestNumber}`;
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key(requestId)); this.emit("engine/requestTimeout", { method, outcomeUnknown: true }); reject(new Error(`Engine ${method} timed out; request was not replayed`)); }, this.timeout);
      this.pending.set(key(requestId), { generation, method, timer, resolve: resolveValue, reject });
      void this.write({ id: requestId, method, params }, generation).catch(error => { const pending = this.pending.get(key(requestId)); if (pending) { clearTimeout(timer); this.pending.delete(key(requestId)); reject(error); } });
    });
  }
  private write(message: unknown, generation: number): Promise<void> {
    const child = this.child; const line = `${JSON.stringify(message)}\n`;
    if (generation !== this.generation || !child || !child.stdin.writable || child.stdin.destroyed || Buffer.byteLength(line) + child.stdin.writableLength > LIMIT) return Promise.reject(new Error("Restricted engine connection is not writable"));
    return new Promise((done, reject) => child.stdin.write(line, error => error ? reject(error) : done()));
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.lifecycle;
    this.stopping = (async () => {
      this.setState("stopping"); this.policy = undefined; this.rejectPending(new Error("Restricted engine stopped"));
      await Promise.all([this.closeUtility(), this.closeChild()]); await this.starting?.catch(() => {}); ++this.generation; this.reset(); this.setState("stopped");
    })().catch(error => { this.setState("failed"); throw error;
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private observeUtility(utility: ChildProcess): void {
    if (this.observedUtilities.has(utility)) return;
    this.observedUtilities.add(utility);
    utility.once("close", () => {
      this.closedUtilities.add(utility);
      if (this.utility === utility) this.utility = undefined;
    });
  }
  private async closeUtility(): Promise<void> {
    if (this.utilityClosing) return this.utilityClosing;
    const utility = this.utility;
    if (!utility) return;
    this.observeUtility(utility);
    if (this.closedUtilities.has(utility)) { if (this.utility === utility) this.utility = undefined; return; }
    this.utilityClosing = new Promise<void>((done, reject) => {
      const cleanup = () => { clearTimeout(timer); utility.off("close", onClose); };
      const onClose = () => { cleanup(); done(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Restricted utility exit was not confirmed")); }, PROCESS_CLOSE_TIMEOUT_MS);
      utility.once("close", onClose);
      // kill() acknowledges only the signal request. Only close confirms cleanup.
      try { utility.kill(); } catch (error) { cleanup(); reject(error); }
    }).finally(() => { this.utilityClosing = undefined; });
    return this.utilityClosing;
  }
  private async closeChild(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.closingChildren.add(child);
    this.rejectPending(new Error("Restricted connection closed"));
    this.closing = new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Restricted engine exit was not confirmed")), PROCESS_CLOSE_TIMEOUT_MS);
      child.once("close", () => { clearTimeout(timer); if (this.child === child) this.child = undefined; done(); });
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private reset(): void { this.threadId = undefined; this.threadRequested = false; this.turnId = undefined; this.turnRequested = false; this.turnFinished = false; this.calls.clear(); this.serverIds.clear(); this.repliedServerIds.clear(); this.policy = undefined; this.diagnostics = 0; }
  private rejectPending(error: Error): void { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
  private fail(error: unknown): void { this.policy = undefined; this.rejectPending(error instanceof Error ? error : new Error("Restricted engine failed")); this.setState("failed"); this.emit("engine/error", { message: error instanceof Error ? redact(error.message) : "Restricted engine failed" }); void this.closeChild().catch(() => {}); }
  private emit(method: string, params: unknown): void { this.options.onEvent({ generation: this.generation, sequence: ++this.sequence, method, params: redact(params) }); }
  private setState(state: EngineState): void { this.phase = state; this.emit("engine/state", { state, profile: this.preset === "fz3b" ? "restricted-fz3b" : "restricted-hardware" }); }
}
