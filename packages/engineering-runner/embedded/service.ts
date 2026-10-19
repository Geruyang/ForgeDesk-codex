import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execute, type ProcessControl } from '../processes.js';
import { contained, copyManifest, digest, durableJson, fileHash, filesDigest, noLinks, safePart, sourceFiles } from './files.js';
import { GESTURESCREEN_PROFILE as PROFILE, GESTURESCREEN_PROFILE_SHA256 as PROFILE_HASH } from './profile.js';
import { keilBuildCommand } from './keil-command.js';
import type { EmbeddedArtifact, EmbeddedBuild, EmbeddedFile, EmbeddedGrantPreview, EmbeddedHardwareContext, EmbeddedOperation, EmbeddedOptions, EmbeddedStatus, EmbeddedTaskState, EmbeddedToolPaths } from './types.js';

export class EmbeddedService {
  private readonly root: string;
  private key?: Buffer;
  private initialization?: Promise<void>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controls = new Set<ProcessControl>();
  private persist = durableJson;
  private closed = false;

  constructor(private readonly options: EmbeddedOptions) { this.root = path.resolve(options.dataDir, 'embedded'); }
  private now() { return this.options.now?.() ?? Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }
  private taskDir(taskId: string) { return path.join(this.root, safePart(taskId)); }
  private statePath(taskId: string) { return path.join(this.taskDir(taskId), 'state.json'); }
  private exitCheckpointPath(taskId: string, operation: EmbeddedOperation) {
    return path.join(this.taskDir(taskId), operation.kind === 'build' ? 'builds' : 'operations', safePart(operation.id), 'exit-checkpoint.json');
  }
  private async init() {
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true });
      await noLinks(this.root);
      const keyPath = path.join(this.root, 'binding.key');
      try {
        const handle = await open(keyPath, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await noLinks(keyPath);
      this.key = await readFile(keyPath);
      if (this.key.length !== 32) throw new Error('Embedded binding key is invalid');
    })();
    await this.initialization;
  }
  private mac(value: unknown) { return createHmac('sha256', this.key!).update(JSON.stringify(value)).digest('hex'); }
  private async read(taskId: string): Promise<EmbeddedTaskState | undefined> {
    await this.init();
    try {
      await noLinks(this.statePath(taskId));
      const envelope = JSON.parse(await readFile(this.statePath(taskId), 'utf8')) as { payload: EmbeddedTaskState; mac: string };
      const expected = Buffer.from(this.mac(envelope.payload), 'hex');
      const actual = Buffer.from(envelope.mac, 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Embedded state binding failed');
      if (envelope.payload.taskId !== taskId || envelope.payload.profileSha256 !== PROFILE_HASH) throw new Error('Embedded state profile/task mismatch');
      return envelope.payload;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async save(state: EmbeddedTaskState) {
    await mkdir(this.taskDir(state.taskId), { recursive: true });
    await noLinks(this.taskDir(state.taskId));
    await this.persist(this.statePath(state.taskId), { payload: state, mac: this.mac(state) });
    this.options.onChange?.();
  }
  private async required(taskId: string) {
    const state = await this.read(taskId);
    if (!state) throw new Error('Configure the fixed GestureScreen target first');
    for (const operation of state.operations) {
      if (await this.readExitCheckpoint(taskId, operation)) throw new Error('An unrecovered exit checkpoint requires recovery before actions or export');
    }
    return state;
  }
  private async checkpointExit(taskId: string, operation: EmbeddedOperation, failure: unknown) {
    const payload = { schemaVersion: 1, taskId, profileSha256: PROFILE_HASH, operationId: operation.id,
      kind: operation.kind, nonce: operation.nonce, argsDigest: operation.argsDigest,
      processExited: operation.processExited === true,
      detail: `Terminal persistence failed; operation outcome remains unknown. ${operation.detail ?? ''} ${String(failure)}`.slice(0, 4000) };
    await this.persist(this.exitCheckpointPath(taskId, operation), { payload, mac: this.mac(payload) });
  }
  private async readExitCheckpoint(taskId: string, operation: EmbeddedOperation): Promise<{ processExited: boolean; detail: string } | undefined> {
    if (operation.recoveredAt) return undefined;
    const file = this.exitCheckpointPath(taskId, operation);
    try {
      await noLinks(file);
      if ((await lstat(file)).size > 16384) throw new Error('Exit checkpoint exceeds bounds');
      const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: Record<string, unknown>; mac: string };
      const expected = Buffer.from(this.mac(envelope.payload), 'hex');
      const actual = typeof envelope.mac === 'string' && /^[a-f0-9]{64}$/.test(envelope.mac) ? Buffer.from(envelope.mac, 'hex') : Buffer.alloc(0);
      const p = envelope.payload;
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || p.schemaVersion !== 1 || p.taskId !== taskId ||
          p.profileSha256 !== PROFILE_HASH || p.operationId !== operation.id || p.kind !== operation.kind ||
          p.nonce !== operation.nonce || p.argsDigest !== operation.argsDigest || typeof p.processExited !== 'boolean' || typeof p.detail !== 'string') {
        throw new Error('Exit checkpoint task/intent binding failed');
      }
      return { processExited: p.processExited, detail: p.detail };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private exclusive<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Embedded service is closed'));
    safePart(taskId);
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(taskId, next);
    return next.finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); });
  }
  async status(taskId: string): Promise<EmbeddedStatus> {
    const state = await this.read(taskId);
    const operations = state ? await Promise.all(state.operations.map(async operation => {
      const view = { ...operation };
      const checkpoint = await this.readExitCheckpoint(taskId, operation);
      if (checkpoint) {
        view.status = 'unknown'; view.detail = checkpoint.detail;
        view.processExited = checkpoint.processExited || (!['prepared', 'running'].includes(operation.status) && operation.processExited === true);
      }
      if (operation.kind !== 'build' && this.options.hardware?.readProgress) {
        const progress = await this.options.hardware.readProgress(operation.kind, operation.id,
          path.join(this.taskDir(taskId), 'operations', safePart(operation.id))).catch(() => undefined);
        if (progress) view.progress = progress;
      }
      return view;
    })) : [];
    return { configured: !!state, taskId, profileId: PROFILE.id, profileSha256: PROFILE_HASH,
      limitation: PROFILE.limitation, hardwareAvailable: !!this.options.hardware,
      operations, ...(state ? { projectRoot: state.projectRoot, artifact: state.builds.at(-1), grant: state.grant } : {}) };
  }
  async configure(taskId: string, projectRoot: string, tools: EmbeddedToolPaths): Promise<EmbeddedStatus> {
    return this.exclusive(taskId, async () => {
      await this.init();
      const project = await noLinks(projectRoot);
      if (!(await lstat(project)).isDirectory()) throw new Error('Project root must be a directory');
      const relativeState = path.relative(project, this.root);
      if (!relativeState.startsWith('..') && !path.isAbsolute(relativeState)) throw new Error('Embedded state must remain outside the project');
      await this.tools(tools);
      await this.validateProject(project);
      const old = await this.read(taskId);
      if (old && old.projectRoot !== project) throw new Error('Task is already bound to another project');
      if (old) old.grant = undefined;
      await this.save(old ?? { schemaVersion: 1, taskId, projectRoot: project, configuredAt: this.iso(), tools: { ...tools }, profileSha256: PROFILE_HASH, builds: [], operations: [] });
      return this.status(taskId);
    });
  }
  private async tools(tools: EmbeddedToolPaths): Promise<Record<string, string>> {
    if (path.resolve(tools.keilExecutable).toLowerCase() !== path.resolve(PROFILE.keilExecutable).toLowerCase()) throw new Error('Only the pinned Keil executable is allowed');
    if (process.platform === 'win32' && !this.options.processHost) throw new Error('Native process-host is required for embedded builds');
    const hashes: Record<string, string> = {};
    await noLinks(tools.keilExecutable);
    hashes[tools.keilExecutable] = await fileHash(tools.keilExecutable);
    if (hashes[tools.keilExecutable] !== PROFILE.keilSha256) throw new Error('Pinned Keil executable hash mismatch');
    const keilRoot = path.resolve(path.dirname(tools.keilExecutable), '..');
    for (const [relative, expected] of Object.entries(PROFILE.toolHashes)) {
      const absolute = path.join(keilRoot, relative);
      await noLinks(absolute);
      hashes[absolute] = await fileHash(absolute);
      if (hashes[absolute] !== expected) throw new Error(`Pinned compiler tool changed: ${relative}`);
    }
    if (this.options.processHost) { await noLinks(this.options.processHost); hashes[this.options.processHost] = await fileHash(this.options.processHost); }
    return hashes;
  }
  private async validateProject(root: string) {
    const project = path.join(root, PROFILE.uvprojx);
    await noLinks(project);
    if (await fileHash(project) !== PROFILE.uvprojxSha256) throw new Error('GestureScreen project configuration differs from reviewed target');
    const text = await readFile(project, 'utf8');
    if ((text.match(/<TargetName>/g) ?? []).length !== 1 || !text.includes('<TargetName>GestureScreen</TargetName>')) throw new Error('Unexpected Keil target');
    // The exact reviewed project hash is the primary parser boundary; hooks are independently checked.
    for (const match of text.matchAll(/<UserProg[12]Name>([\s\S]*?)<\/UserProg[12]Name>/g)) {
      if (match[1].trim()) throw new Error('Custom Keil build commands are forbidden');
    }
    if (/<CustomArgument>|<CustomArguments>|<CustomCommand>/.test(text)) throw new Error('Custom project commands are forbidden');
  }
  private async template(): Promise<EmbeddedFile[]> {
    const manifestPath = path.join(this.options.templateRoot, 'overlay-manifest.json');
    await noLinks(manifestPath);
    if (await fileHash(manifestPath) !== PROFILE.templateManifestSha256) throw new Error('Packaged overlay manifest differs from the trusted profile');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { schema_version: number; files: EmbeddedFile[] };
    const expected = ['App/Inc/forgedesk_build_id.h', 'BSP/Src/gs_usb_capture.c', 'Modules/UsbCapture/Inc/gs_usb_protocol.h', 'Modules/UsbCapture/Src/gs_usb_protocol.c'];
    if (manifest.schema_version !== 1 || JSON.stringify(manifest.files.map(file => file.path).sort()) !== JSON.stringify(expected.sort())) throw new Error('Unexpected trusted overlay file list');
    const actual = await sourceFiles(this.options.templateRoot);
    if (actual.length !== 5) throw new Error('Unexpected extra packaged overlay files');
    for (const file of manifest.files) {
      const found = actual.find(item => item.path === file.path);
      if (!found || found.bytes !== file.bytes || found.sha256 !== file.sha256) throw new Error('Packaged overlay file integrity failed');
    }
    return actual;
  }
  private operation(state: EmbeddedTaskState, kind: EmbeddedOperation['kind'], requestKey: string, binding: unknown) {
    safePart(requestKey);
    const argsDigest = digest(JSON.stringify({ kind, binding }));
    const old = state.operations.find(item => item.requestKey === requestKey);
    if (old) {
      if (old.kind !== kind || old.argsDigest !== argsDigest) throw new Error('Request key reused with different arguments');
      return { operation: old, existing: true };
    }
    const operation: EmbeddedOperation = { id: randomUUID(), requestKey, kind, argsDigest, nonce: randomBytes(32).toString('hex'), status: 'prepared', dispatchPhase: 'not-started', processExited: true, createdAt: this.iso(), updatedAt: this.iso() };
    state.operations.push(operation);
    return { operation, existing: false };
  }
  async build(taskId: string, requestKey: string): Promise<EmbeddedStatus> {
    return this.exclusive(taskId, async () => {
      const state = await this.required(taskId);
      const claim = this.operation(state, 'build', requestKey, { projectRoot: state.projectRoot, profile: PROFILE_HASH });
      if (claim.existing) return this.status(taskId);
      const op = claim.operation;
      state.grant = undefined;
      await this.save(state);
      const directory = path.join(this.taskDir(taskId), 'builds', op.id);
      const snapshot = path.join(directory, 'source');
      let locked = false;
      let processExited = true;
      let dispatched = false;
      try {
        await this.acquireProbe(state.taskId, op.id); locked = true;
        const toolHashes = await this.tools(state.tools);
        await this.validateProject(state.projectRoot);
        const original = await sourceFiles(state.projectRoot);
        const sourceBefore = filesDigest(original);
        await copyManifest(state.projectRoot, snapshot, original);
        const template = await this.template();
        await copyManifest(this.options.templateRoot, snapshot, template);
        await this.validateProject(snapshot);
        const buildId = randomBytes(32).toString('hex');
        const buildHeader = path.join(snapshot, 'App', 'Inc', 'forgedesk_build_id.h');
        await mkdir(path.dirname(buildHeader), { recursive: true });
        await writeFile(buildHeader, `#ifndef FORGEDESK_BUILD_ID_H\n#define FORGEDESK_BUILD_ID_H\n#define FORGEDESK_BUILD_ID_BYTES {${buildId.match(/../g)!.map(byte => `0x${byte}`).join(',')}}\n#endif\n`, { flag: 'w' });
        const snapshotBefore = await sourceFiles(snapshot);
        const snapshotDigest = filesDigest(snapshotBefore);
        const logPath = path.join(directory, 'keil-build.log');
        op.status = 'running'; op.dispatchPhase = 'may-have-started'; op.processExited = false; op.updatedAt = this.iso();
        await this.save(state);
        const control: ProcessControl = { cancelled: false };
        this.controls.add(control);
        let result;
        try {
          processExited = false;
          dispatched = true;
          result = await (this.options.execute ?? execute)(keilBuildCommand(state.tools.keilExecutable, snapshot, logPath), control, this.options.processHost);
          processExited = result.cleanup !== 'unconfirmed';
        } finally { this.controls.delete(control); }
        const log = await readFile(logPath, 'utf8').catch(() => '');
        await writeFile(path.join(directory, 'process-output.log'), result.output);
        if (result.timedOut || result.cancelled || result.cleanup === 'unconfirmed' || result.error || ![0, 1].includes(result.exitCode ?? -1) || !/\b0 Error\(s\)/.test(log) || /\b[1-9][0-9]* Error\(s\)/.test(log)) throw new Error(`Keil build did not pass: ${result.error ?? result.exitCode}`);
        const snapshotAfter = await sourceFiles(snapshot);
        const sourceAfter = filesDigest(await sourceFiles(state.projectRoot));
        if (sourceBefore !== sourceAfter) throw new Error('Project source changed while building');
        if (snapshotDigest !== filesDigest(snapshotAfter)) throw new Error('Snapshot source changed while building');
        if (JSON.stringify(toolHashes) !== JSON.stringify(await this.tools(state.tools))) throw new Error('Build tools changed while building');
        const hexPath = path.join(snapshot, 'MDK-ARM', 'Objects', 'GestureScreen.hex');
        const axfPath = path.join(snapshot, 'MDK-ARM', 'Objects', 'GestureScreen.axf');
        await noLinks(hexPath); await noLinks(axfPath);
        if (!(await lstat(hexPath)).size || !(await lstat(axfPath)).size) throw new Error('Keil produced empty artifacts');
        const build: EmbeddedBuild = { id: op.id, buildId, createdAt: this.iso(), sourceRoot: snapshot,
          hexPath, axfPath, hexSha256: await fileHash(hexPath), axfSha256: await fileHash(axfPath),
          sourceSha256: snapshotDigest, profileSha256: PROFILE_HASH, projectSourceBefore: sourceBefore, projectSourceAfter: sourceAfter,
          snapshotSourceBefore: snapshotDigest, snapshotSourceAfter: filesDigest(snapshotAfter), files: snapshotBefore,
          templateSha256: filesDigest(template), toolHashes, logPath, logSha256: await fileHash(logPath), processExit: result.exitCode };
        // The random build identifier must actually survive into the linked binary.
        if (!(await readFile(axfPath)).includes(Buffer.from(buildId, 'hex'))) throw new Error('Linked firmware does not contain the unique build ID');
        state.builds.push(build); op.artifactId = build.id; op.status = 'succeeded'; op.processExited = true;
        await this.persist(path.join(directory, 'build-evidence.json'), { payload: build, mac: this.mac(build) });
      } catch (error) {
        op.status = processExited ? 'failed' : 'unknown'; op.detail = String(error); op.processExited = processExited;
        if (!dispatched) op.dispatchPhase = 'not-started';
      }
      op.updatedAt = this.iso();
      await this.finalize(state, op, locked && processExited && op.status !== 'unknown');
      return this.status(taskId);
    });
  }
  private async current(state: EmbeddedTaskState): Promise<EmbeddedBuild> {
    const build = state.builds.at(-1);
    if (!build || build.profileSha256 !== PROFILE_HASH) throw new Error('No current trusted embedded build');
    const latestBuild = [...state.operations].reverse().find(op => op.kind === 'build');
    if (latestBuild?.status !== 'succeeded' || latestBuild.artifactId !== build.id) throw new Error('The latest build attempt did not produce a trusted artifact');
    await this.validateProject(state.projectRoot);
    if (filesDigest(await sourceFiles(state.projectRoot)) !== build.projectSourceAfter) throw new Error('Source changed since the build');
    if (filesDigest(await sourceFiles(build.sourceRoot)) !== build.sourceSha256) throw new Error('Build snapshot changed');
    await noLinks(build.hexPath); await noLinks(build.axfPath);
    if (await fileHash(build.hexPath) !== build.hexSha256 || await fileHash(build.axfPath) !== build.axfSha256) throw new Error('Build artifact hash mismatch');
    if (filesDigest(await this.template()) !== build.templateSha256) throw new Error('Trusted template changed since build');
    if (JSON.stringify(await this.tools(state.tools)) !== JSON.stringify(build.toolHashes)) throw new Error('Build tool identity changed');
    return build;
  }
  private backup(state: EmbeddedTaskState): { path: string; sha256: string } {
    const inspect = [...state.operations].reverse().find(op => op.kind === 'inspect' && op.status === 'succeeded');
    if (!inspect?.receipt) throw new Error('A successful device inspection and backup are required');
    const receipt = JSON.parse(inspect.receipt) as { backup?: { path: string; sha256: string } };
    const backup = receipt.backup;
    if (!backup || !/^[a-f0-9]{64}$/i.test(backup.sha256)) throw new Error('Inspection did not provide a bound backup');
    contained(path.join(this.taskDir(state.taskId), 'operations', inspect.id), backup.path);
    return backup;
  }
  private requireFreshInspection(state: EmbeddedTaskState) {
    let inspection = -1; let flash = -1;
    state.operations.forEach((op, index) => {
      if (op.kind === 'inspect' && op.status === 'succeeded') inspection = index;
      if (op.kind === 'flash' && op.status !== 'prepared') flash = index;
    });
    if (inspection < 0 || inspection < flash) throw new Error('A new successful inspection is required after the previous flash operation');
  }
  private async checkBackup(state: EmbeddedTaskState) {
    const backup = this.backup(state); await noLinks(backup.path);
    if ((await lstat(backup.path)).size !== 1024 * 1024 || await fileHash(backup.path) !== backup.sha256) throw new Error('Bound flash backup changed');
    return backup;
  }
  private async acquireProbe(taskId: string, operationId: string) {
    const lock = path.join(this.root, 'probe.lock');
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('The fixed probe is held by another build or device operation');
    }
    try { await this.persist(path.join(lock, 'owner.json'), { taskId, operationId }); }
    catch (error) {
      // This call created the directory and has not dispatched a process; no prior owner is removed.
      await noLinks(lock);
      try { await rm(lock, { recursive: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Probe owner persistence and own-lock rollback failed'); }
      throw error;
    }
  }
  private async releaseProbe(taskId: string, operationId: string) {
    const lock = path.join(this.root, 'probe.lock');
    await noLinks(path.join(lock, 'owner.json'));
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as { taskId: string; operationId: string };
    if (owner.taskId !== taskId || owner.operationId !== operationId) throw new Error('Fixed-probe lock owner mismatch');
    await rm(lock, { recursive: true });
  }
  private async finalize(state: EmbeddedTaskState, operation: EmbeddedOperation, releaseLock: boolean): Promise<void> {
    const errors: unknown[] = [];
    let saved = false;
    // Preserve process-exit facts even if lock cleanup subsequently fails.
    try { await this.save(state); saved = true; }
    catch (error) {
      errors.push(error);
      if (operation.dispatchPhase !== 'not-started') {
        try { await this.checkpointExit(state.taskId, operation, error); } catch (checkpointError) { errors.push(checkpointError); }
      }
    }
    if (releaseLock && (saved || operation.dispatchPhase === 'not-started')) {
      try { await this.releaseProbe(state.taskId, operation.id); }
      catch (error) {
        errors.push(error);
        operation.status = 'unknown';
        operation.detail = `Process exit is confirmed but probe lock cleanup failed: ${String(error)}`;
        operation.updatedAt = this.iso();
        try { await this.save(state); }
        catch (saveError) {
          errors.push(saveError);
          try { await this.checkpointExit(state.taskId, operation, saveError); } catch (checkpointError) { errors.push(checkpointError); }
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Embedded terminal persistence and lock cleanup failed');
  }
  async prepareGrant(taskId: string): Promise<EmbeddedGrantPreview> {
    return this.exclusive(taskId, async () => {
      const state = await this.required(taskId); const build = await this.current(state);
      this.requireFreshInspection(state);
      const backup = await this.checkBackup(state);
      if (state.operations.some(op => (op.status === 'unknown' && !op.recoveredAt) || op.status === 'running')) throw new Error('Unresolved device operation blocks authorization');
      const preview: EmbeddedGrantPreview = { id: randomUUID(), taskId, artifactId: build.id, hexSha256: build.hexSha256, axfSha256: build.axfSha256,
        buildId: build.buildId, sourceSha256: build.sourceSha256, profileId: PROFILE.id, profileSha256: PROFILE_HASH, backupSha256: backup.sha256,
        identity: { probeSerial: PROFILE.probeSerial, uid: PROFILE.uid, chipId: PROFILE.chipId, flashKiB: PROFILE.flashKiB, cdcSerial: PROFILE.cdcSerial },
        scope: 'flash-and-verify-once', expiresAt: new Date(this.now() + 5 * 60 * 1000).toISOString() };
      state.grant = preview; await this.save(state); return preview;
    });
  }
  /** Main process calls this only after its native confirmation dialog approves the exact preview. */
  async approveGrant(taskId: string, challengeId: string): Promise<EmbeddedStatus> {
    return this.exclusive(taskId, async () => {
      const state = await this.required(taskId); const build = await this.current(state);
      const grant = state.grant;
      if (!grant || grant.id !== challengeId || grant.artifactId !== build.id || Date.parse(grant.expiresAt) <= this.now() || grant.consumedBy) throw new Error('Grant challenge is stale');
      if ((await this.checkBackup(state)).sha256 !== grant.backupSha256) throw new Error('Grant backup binding changed');
      grant.approvedAt = this.iso(); await this.save(state); return this.status(taskId);
    });
  }
  inspect(taskId: string, requestKey: string = randomUUID()) { return this.hardware(taskId, 'inspect', requestKey); }
  flash(taskId: string, requestKey: string) { return this.hardware(taskId, 'flash', requestKey); }
  verify(taskId: string, requestKey: string) { return this.hardware(taskId, 'verify', requestKey); }
  private async hardware(taskId: string, kind: 'inspect' | 'flash' | 'verify', requestKey: string): Promise<EmbeddedStatus> {
    return this.exclusive(taskId, async () => {
      const state = await this.required(taskId);
      const binding = { artifactId: kind === 'inspect' ? undefined : state.builds.at(-1)?.id, profile: PROFILE_HASH };
      const claim = this.operation(state, kind, requestKey, binding);
      if (claim.existing) return this.status(taskId);
      const op = claim.operation;
      if (!this.options.hardware) throw new Error('Fixed-target hardware worker is unavailable');
      if (state.operations.some(other => other !== op && (other.status === 'running' || (other.status === 'unknown' && !other.recoveredAt)))) throw new Error('An unresolved device operation requires recovery');
      let artifact: EmbeddedArtifact | undefined;
      let backup: { path: string; sha256: string } | undefined;
      if (kind === 'inspect') state.grant = undefined;
      if (kind !== 'inspect') artifact = await this.current(state);
      if (kind === 'flash') {
        this.requireFreshInspection(state);
        const grant = state.grant;
        if (!grant?.approvedAt || grant.consumedBy || grant.artifactId !== artifact!.id || grant.hexSha256 !== artifact!.hexSha256 || Date.parse(grant.expiresAt) <= this.now()) throw new Error('A current native user approval is required');
        backup = await this.checkBackup(state);
        if (backup.sha256 !== grant.backupSha256) throw new Error('Grant backup binding changed');
        grant.consumedBy = op.id;
      }
      if (kind === 'verify' && !state.operations.some(other => other.kind === 'flash' && other.status === 'succeeded' && other.artifactId === artifact!.id)) throw new Error('Verification requires this artifact to have a successful flash receipt');
      op.artifactId = artifact?.id;
      await this.save(state);
      const directory = path.join(this.taskDir(taskId), 'operations', op.id);
      let locked = false;
      let dispatched = false;
      try {
        await mkdir(directory, { recursive: true }); await noLinks(directory);
        await this.acquireProbe(taskId, op.id); locked = true;
        op.status = 'running'; op.dispatchPhase = 'may-have-started'; op.processExited = false; op.updatedAt = this.iso();
        await this.save(state);
        const context: EmbeddedHardwareContext = { taskId, operationId: op.id, operationDir: directory, nonce: op.nonce, profile: PROFILE, artifact, backup };
        dispatched = true;
        const outcome = await this.options.hardware[kind](context);
        op.processExited = outcome.processExited; op.status = outcome.processExited ? outcome.status : 'unknown';
        op.detail = outcome.detail; op.receipt = outcome.receipt;
        if (op.status === 'succeeded' && kind === 'inspect') await this.checkBackup(state);
      } catch (error) {
        op.status = dispatched ? 'unknown' : 'failed';
        if (!dispatched) { op.processExited = true; op.dispatchPhase = 'not-started'; }
        op.detail = dispatched ? String(error) : `Hardware worker was not dispatched: ${String(error)}`;
      }
      op.updatedAt = this.iso();
      await this.finalize(state, op, locked && (!dispatched || (op.processExited === true && op.status !== 'unknown')));
      return this.status(taskId);
    });
  }
  async export(taskId: string, destination: string): Promise<{ path: string; sha256: string }> {
    return this.exclusive(taskId, async () => {
      const state = await this.required(taskId);
      const build = await this.current(state);
      if (await fileHash(build.logPath) !== build.logSha256) throw new Error('Build log changed since evidence capture');
      for (const protectedRoot of [state.projectRoot, build.sourceRoot, this.root]) {
        const relative = path.relative(protectedRoot, path.resolve(destination));
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Export must be outside the project and build source');
      }
      await mkdir(destination, { recursive: true }); await noLinks(destination);
      const directory = path.join(destination, `forgedesk-embedded-${safePart(taskId)}-${randomUUID()}`);
      await mkdir(directory); await noLinks(directory);
      const files: { path: string; sha256: string; bytes: number }[] = [];
      const record = async (relative: string) => { const file = path.join(directory, relative); files.push({ path: relative, sha256: await fileHash(file), bytes: (await lstat(file)).size }); };
      const copy = async (source: string, relative: string, expected: string) => {
        await noLinks(source);
        if (await fileHash(source) !== expected) throw new Error('Export evidence changed while copying');
        const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        if (await fileHash(target) !== expected) throw new Error('Export evidence copy failed integrity check');
        await record(relative);
      };
      await copy(build.hexPath, 'firmware/GestureScreen.hex', build.hexSha256);
      await copy(build.axfPath, 'firmware/GestureScreen.axf', build.axfSha256);
      await copy(build.logPath, 'build/keil-build.log', build.logSha256);
      await this.persist(path.join(directory, 'build/source-manifest.json'), { sourceSha256: build.sourceSha256, projectSourceSha256: build.projectSourceAfter, buildId: build.buildId, profileSha256: PROFILE_HASH, files: build.files });
      await record('build/source-manifest.json');
      const overlay = path.join(this.options.templateRoot, 'overlay-manifest.json');
      try { await copy(overlay, 'build/overlay-manifest.json', await fileHash(overlay)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const op of state.operations) {
        if (!op.receipt) continue;
        const relative = `receipts/${safePart(op.id)}.json`;
        await mkdir(path.join(directory, 'receipts'), { recursive: true });
        await writeFile(path.join(directory, relative), op.receipt, { flag: 'wx' }); await record(relative);
      }
      const output = path.join(directory, 'evidence.json');
      await this.persist(output, { schemaVersion: 1, exportedAt: this.iso(), limitation: `${PROFILE.limitation} Export hashes prove content integrity, not independent authenticity.`, profile: PROFILE, state, binding: this.mac(state), files });
      return { path: output, sha256: await fileHash(output) };
    });
  }
  async recover(): Promise<void> {
    await this.init();
    if (this.queues.size || this.controls.size) throw new Error('Cannot recover while an embedded operation is active');
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'probe.lock') continue;
      const state = await this.read(entry.name); if (!state) continue;
      let changed = false;
      for (const op of state.operations) {
        const checkpoint = await this.readExitCheckpoint(state.taskId, op);
        if (checkpoint) {
          const pending = op.status === 'prepared' || op.status === 'running';
          op.status = 'unknown'; op.detail = checkpoint.detail;
          op.processExited = checkpoint.processExited || (!pending && op.processExited === true); changed = true;
        } else if (op.status === 'prepared' && op.dispatchPhase === 'not-started') {
          op.status = 'failed'; op.processExited = true;
          op.detail = 'Service restarted before worker dispatch; no hardware action started or replayed'; op.updatedAt = this.iso(); changed = true;
        } else if (op.status === 'prepared' || op.status === 'running') {
          op.status = 'unknown'; op.processExited = false;
          op.detail = 'Service restarted before a durable final result; no action replayed'; op.updatedAt = this.iso(); changed = true;
        }
        if (op.status === 'unknown' && !op.processExited && this.options.hardware?.confirmProcessExited && await this.options.hardware.confirmProcessExited(op.id, path.join(this.taskDir(state.taskId), 'operations', safePart(op.id)))) {
          op.processExited = true; changed = true;
        }
      }
      if (changed) { state.grant = undefined; await this.save(state); }
      for (const op of state.operations) {
        if (!op.processExited || !['succeeded', 'failed', 'unknown'].includes(op.status)) continue;
        const lock = path.join(this.root, 'probe.lock');
        let exists = true;
        try { await lstat(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
        if (exists) {
          await noLinks(path.join(lock, 'owner.json'));
          const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as { taskId: string; operationId: string };
          if (owner.taskId === state.taskId && owner.operationId === op.id) await this.releaseProbe(state.taskId, op.id);
        }
        if (op.status === 'unknown' && !op.recoveredAt) { op.recoveredAt = this.iso(); state.grant = undefined; await this.save(state); }
      }
    }
  }
  async assertIdle(): Promise<void> {
    await this.init();
    if (this.queues.size || this.controls.size) throw new Error('An embedded operation is still active');
    try { await lstat(path.join(this.root, 'probe.lock')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('A probe/build lock remains held; process-exit recovery is required');
  }
  async revokeGrants(): Promise<void> {
    await this.assertIdle();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'probe.lock') continue;
      const state = await this.read(entry.name);
      if (state?.grant) { state.grant = undefined; await this.save(state); }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const control of this.controls) { control.cancelled = true; await control.terminate?.(); }
    await Promise.allSettled(this.queues.values());
  }
}
