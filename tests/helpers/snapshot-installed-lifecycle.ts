import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication } from 'playwright';
import { redact } from '../../packages/engineering-runner/redaction';
import { primarySid, readDesktopIdentity, type DesktopIdentity } from './snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, nativeMainProcessQuery,
  type ElectronMainIdentity, type InstalledMainProcess } from './second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './playwright-no-kill';
import { observeNormalCloseRequest, type NormalCloseObservation } from './normal-close-observation';

type ExitEmitter = Pick<EventEmitter, 'listeners' | 'removeListener'>;
type PublicObservation = Exclude<NormalCloseObservation, { state: 'rejected' }> | { state: 'rejected'; message: string };
export type SnapshotInstalledProtection = {
  status: 'not-required' | 'protected' | 'failed'; safeHarnessExit: boolean; needsHumanClose: boolean;
  removedCount: number; sourceVerified: boolean; noNewExitHandlerObserved?: boolean; message?: string;
};
export type SnapshotInstalledClose = {
  requestedAt: string; normalClose: boolean; forcedKill: false; needsHumanClose: boolean;
  nativeWindowClose: boolean; launcherPid?: number; launcherExitCode?: number | null; launcherSignal?: string | null;
  exitCodeScope: 'playwright-launcher'; nativeMainBefore?: InstalledMainProcess; nativeMainAfter?: InstalledMainProcess | null;
  nativeElectronIdentityAbsent?: boolean; nativeInstalledProcessesAbsent?: boolean;
  closeRequest?: PublicObservation; playwrightCloseObservation?: PublicObservation; playwrightCloseAfterNativeExit?: boolean; message?: string;
};
export type SnapshotInstalledLaunch = {
  index: number; startedAt: string; desktopIdentity: DesktopIdentity; launcherPid?: number;
  launcherPidScope: 'Playwright launcher; not the Electron main identity'; electronMain?: ElectronMainIdentity;
  nativeMain?: InstalledMainProcess | null; identityVerifiedAt?: string; close?: SnapshotInstalledClose; protection?: SnapshotInstalledProtection;
};
export type SnapshotInstalledLifecycleEvidence = {
  schemaVersion: 1; scope: 'primary-installed-snapshot'; installed: string; observerKind: 'native' | 'injected-fixture';
  initialDesktopIdentity?: DesktopIdentity; launches: SnapshotInstalledLaunch[];
  nativeAbsenceScope: string;
};

export interface SnapshotInstalledLifecycleObservers {
  readIdentity(): Promise<DesktopIdentity>;
  readNativeMain(pid: number): Promise<InstalledMainProcess | null>;
  inspectInstalled(installed: string): Promise<void>;
  exitEmitter: ExitEmitter;
}

const execute = promisify(execFile);
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
const publicObservation = (value: NormalCloseObservation): PublicObservation => value.state === 'rejected'
  ? { state: 'rejected', message: errorText(value.error) } : value;

async function inspectInstalled(installed: string): Promise<void> {
  const absolute = path.resolve(installed); let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    assert.equal((await lstat(current)).isSymbolicLink(), false, 'Installed lifecycle paths cannot contain links or junctions');
  }
  const value = await lstat(absolute);
  assert.ok(value.isFile() && value.nlink === 1, 'Installed executable must be a regular, unlinked file');
  assert.ok(samePath(await realpath(absolute), absolute), 'Installed executable resolution changed');
}

const nativeObservers: SnapshotInstalledLifecycleObservers = {
  readIdentity: readDesktopIdentity, inspectInstalled, exitEmitter: process,
  readNativeMain: async pid => {
    const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)],
      { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as InstalledMainProcess | null;
  },
};

function assertPrimaryDesktop(identity: DesktopIdentity, previous?: DesktopIdentity): void {
  assert.equal(identity.sid, primarySid, 'Installed snapshot lifecycle is restricted to the actual primary Windows SID');
  assert.equal(identity.interactive, true, 'An interactive primary desktop is required');
  assert.equal(identity.elevated, false, 'Use the unelevated primary desktop');
  assert.ok(Number.isInteger(identity.sessionId) && identity.sessionId > 0, 'An interactive session is required');
  assert.ok(Array.isArray(identity.platformSids) && !identity.platformSids.includes(identity.sid), 'Platform sandbox identities are not eligible');
  assert.ok(identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId), 'Explorer must match the actual SID and session');
  assert.ok(Array.isArray(identity.applications), 'Native application census is required');
  if (previous) { assert.equal(identity.sid, previous.sid); assert.equal(identity.sessionId, previous.sessionId, 'Desktop session changed during installed lifecycle'); }
}

async function bounded<T>(request: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class SnapshotInstalledLifecycle {
  readonly evidence: SnapshotInstalledLifecycleEvidence;
  private state: 'new' | 'ready' | 'launching' | 'attaching' | 'attached' | 'closing' | 'closed' | 'protected' = 'new';
  private baseline?: readonly Function[];
  private app?: ElectronApplication;
  private launcher?: ChildProcess;
  private current?: SnapshotInstalledLaunch;

  constructor(root: string, installed: string, private readonly observers: SnapshotInstalledLifecycleObservers = nativeObservers) {
    assert.ok(path.isAbsolute(root) && path.isAbsolute(installed), 'Installed lifecycle requires absolute project and executable paths');
    assert.ok(samePath(installed, path.join(root, 'install', 'ForgeDesk.exe')), 'Only the project root/install/ForgeDesk.exe is allowed');
    this.evidence = { schemaVersion: 1, scope: 'primary-installed-snapshot', installed: path.resolve(installed),
      observerKind: observers === nativeObservers ? 'native' : 'injected-fixture', launches: [],
      nativeAbsenceScope: 'Current-account CIM census of ForgeDesk.exe with visible executable paths; actual main PID/creation checked separately. Not an independent Codex/process-host tree proof.' };
  }

  async prepare(): Promise<void> {
    assert.equal(this.state, 'new');
    const identity = await this.observers.readIdentity(); assertPrimaryDesktop(identity);
    assert.equal(identity.applications.length, 0, 'Close all existing ForgeDesk instances normally before installed snapshot acceptance');
    await this.observers.inspectInstalled(this.evidence.installed);
    this.evidence.initialDesktopIdentity = identity; this.state = 'ready';
  }

  async beforeLaunch(): Promise<SnapshotInstalledLaunch> {
    assert.ok(this.state === 'ready' || this.state === 'closed', 'An earlier installed launch is still held or unconfirmed');
    const identity = await this.observers.readIdentity(); assertPrimaryDesktop(identity, this.evidence.initialDesktopIdentity);
    assert.equal(identity.applications.length, 0, 'An existing ForgeDesk instance prevents a new installed launch');
    await this.observers.inspectInstalled(this.evidence.installed);
    const baseline = capturePlaywrightExitListeners(this.observers.exitEmitter);
    assert.ok(!baseline.some(listener => listener.name === 'exitHandler'), 'An existing launcher exitHandler prevents isolated no-kill ownership');
    this.baseline = baseline; this.app = undefined; this.launcher = undefined;
    this.current = { index: this.evidence.launches.length + 1, startedAt: new Date().toISOString(), desktopIdentity: identity,
      launcherPidScope: 'Playwright launcher; not the Electron main identity' };
    this.evidence.launches.push(this.current); this.state = 'launching'; return this.current;
  }

  async attach(application: ElectronApplication): Promise<SnapshotInstalledLaunch> {
    assert.ok(this.state === 'launching' && this.current && this.baseline, 'Call beforeLaunch immediately before launching the installed application');
    this.state = 'attaching'; this.app = application;
    try {
      // Cache this before any dispatcher can be disposed. It can be cmd.exe on Windows.
      this.launcher = application.process(); this.current.launcherPid = this.launcher.pid;
      assert.ok(Number.isInteger(this.launcher.pid) && this.launcher.pid! > 0, 'A saved launcher identity is required');
      const main = await bounded(application.evaluate(() => ({ pid: process.pid, execPath: process.execPath,
        type: process.type, platform: process.platform })), 15000, 'Electron main identity query exceeded 15 seconds');
      this.current.electronMain = main; assertElectronMainIdentity(main, this.evidence.installed);
      const native = await this.observers.readNativeMain(main.pid); this.current.nativeMain = native;
      assertInstalledMainProcess(native, main, this.evidence.installed, this.current.desktopIdentity.sid, this.current.desktopIdentity.sessionId);
      this.current.identityVerifiedAt = new Date().toISOString(); this.state = 'attached'; return this.current;
    } catch (error) { this.protectOnFailure(); throw error; }
  }

  async closeNormally(): Promise<SnapshotInstalledClose> {
    assert.ok(this.state === 'attached' && this.app && this.launcher && this.current?.electronMain && this.current.nativeMain,
      'Normal close requires the cached launcher and independently verified installed main identity');
    this.state = 'closing';
    const app = this.app; const child = this.launcher; const launch = this.current;
    const main = launch.electronMain!; const native = launch.nativeMain!;
    const record: SnapshotInstalledClose = { requestedAt: new Date().toISOString(), normalClose: false, forcedKill: false,
      needsHumanClose: true, nativeWindowClose: false, launcherPid: child.pid, exitCodeScope: 'playwright-launcher', nativeMainBefore: native };
    launch.close = record;
    let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    try {
      assert.equal(child.exitCode, null, 'A launcher exited before this request is not normal-close evidence');
      assert.equal(child.signalCode, null, 'A previously signalled launcher is not normal-close evidence');
      const identity = await this.observers.readIdentity(); assertPrimaryDesktop(identity, launch.desktopIdentity);
      const before = await this.observers.readNativeMain(main.pid);
      assertInstalledMainProcess(before, main, this.evidence.installed, identity.sid, identity.sessionId);
      assert.equal(Date.parse(before.created), Date.parse(native.created), 'Installed main creation identity changed before close');
      assert.equal(child.exitCode, null, 'Launcher exited during pre-close observations'); assert.equal(child.signalCode, null);
      const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        onClose = (code, signal) => resolve({ code, signal }); child.once('close', onClose);
      });
      const result = await bounded((async () => {
        record.nativeWindowClose = true;
        const request = observeNormalCloseRequest(app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
          if (!window) throw new Error('No live application window is available for normal close');
          window.close();
        }), 5000).then(observation => { record.closeRequest = publicObservation(observation); return observation; });
        const exit = await closed;
        return { exit, request };
      })(), 30000, 'Native window close did not produce launcher close within 30 seconds; no force-close was attempted');
      record.launcherExitCode = result.exit.code; record.launcherSignal = result.exit.signal;
      assert.equal(result.exit.code, 0, 'Normal close requires launcher exit code 0');
      assert.equal(result.exit.signal, null, 'A signalled launcher is not normal close');
      const after = await this.observers.readNativeMain(main.pid); record.nativeMainAfter = after;
      assertElectronMainExited(native, after); record.nativeElectronIdentityAbsent = true;
      const absent = await this.observers.readIdentity(); assertPrimaryDesktop(absent, launch.desktopIdentity);
      assert.equal(absent.applications.length, 0, 'Native ForgeDesk processes remain after launcher exit');
      record.nativeInstalledProcessesAbsent = true;
      const requested = await result.request;
      assert.notEqual(requested.state, 'timed-out', 'Native close request acknowledgement is unconfirmed; no force-close was attempted');
      const disposed = await observeNormalCloseRequest(app.close(), 5000); record.playwrightCloseObservation = publicObservation(disposed);
      assert.notEqual(disposed.state, 'timed-out', 'Playwright cleanup acknowledgement is unconfirmed');
      if (disposed.state === 'rejected') throw disposed.error;
      record.playwrightCloseAfterNativeExit = true; record.normalClose = true; record.needsHumanClose = false;
      this.app = undefined; this.launcher = undefined; this.state = 'closed'; return record;
    } catch (error) { record.message = errorText(error); this.protectOnFailure(); throw error; }
    finally { if (onClose) child.removeListener('close', onClose); }
  }

  protectOnFailure(): SnapshotInstalledProtection {
    if (this.current?.protection) return this.current.protection;
    if (this.state === 'closed' || !this.current || !this.baseline) {
      return { status: 'not-required', safeHarnessExit: true, needsHumanClose: false, removedCount: 0, sourceVerified: false };
    }
    const record: SnapshotInstalledProtection = { status: 'failed', safeHarnessExit: false, needsHumanClose: true, removedCount: 0, sourceVerified: false };
    try {
      const introduced = capturePlaywrightExitListeners(this.observers.exitEmitter).filter(listener => !this.baseline!.includes(listener));
      if (introduced.length === 0) {
        record.noNewExitHandlerObserved = true; record.safeHarnessExit = true;
      } else {
        const detached = detachNewPlaywrightExitHandler(this.baseline, this.observers.exitEmitter);
        record.removedCount = detached.removedCount; record.sourceVerified = detached.sourceVerified; record.safeHarnessExit = true;
      }
      record.status = 'protected';
    } catch (error) { record.message = errorText(error); }
    this.current.protection = record; this.state = 'protected'; return record;
  }
}

export async function prepareSnapshotInstalledLifecycle(root: string, installed: string,
  observers?: SnapshotInstalledLifecycleObservers): Promise<SnapshotInstalledLifecycle> {
  const lifecycle = new SnapshotInstalledLifecycle(root, installed, observers); await lifecycle.prepare(); return lifecycle;
}
