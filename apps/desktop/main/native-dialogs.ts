export type NativeDialogKind = 'approval' | 'notice' | 'picker';
export interface NativeDialogRequest { kind: NativeDialogKind; signal?: AbortSignal; deadline?: number }
export interface NativeDialogClock { now(): number; schedule(callback: () => void, delay: number): () => void }
export class NativeDialogCancelledError extends Error {
  constructor(readonly reason: 'aborted' | 'expired' | 'closed') { super(`NATIVE_DIALOG_${reason.toUpperCase()}`); this.name = 'NativeDialogCancelledError'; }
}
interface Entry {
  request: NativeDialogRequest; body(): Promise<unknown>;
  resolve(value: unknown): void; reject(error: unknown): void;
  cleanup(): void; started: boolean;
}
const systemClock: NativeDialogClock = { now: Date.now, schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };

/** Only owns native presentation. It never manufactures a response or changes task ownership. */
export class NativeDialogArbiter {
  private readonly queue: Entry[] = [];
  private active?: Entry;
  private closed = false;
  constructor(private readonly clock: NativeDialogClock = systemClock) {}
  get busy(): boolean { return !!this.active || this.queue.length > 0; }
  get approvalPending(): boolean { return this.active?.request.kind === 'approval' || this.queue.some(entry => entry.request.kind === 'approval'); }
  run<T>(request: NativeDialogRequest, body: () => Promise<T>): Promise<T> {
    request = { ...request };
    if (!['approval', 'notice', 'picker'].includes(request.kind) || request.deadline !== undefined && !Number.isFinite(request.deadline)) return Promise.reject(new Error('NATIVE_DIALOG_INVALID_REQUEST'));
    if (this.closed) return Promise.reject(new NativeDialogCancelledError('closed'));
    if (request.signal?.aborted) return Promise.reject(new NativeDialogCancelledError('aborted'));
    if (request.deadline !== undefined && this.clock.now() >= request.deadline) return Promise.reject(new NativeDialogCancelledError('expired'));
    if (this.queue.length >= 32) return Promise.reject(new Error('NATIVE_DIALOG_QUEUE_FULL'));
    return new Promise<T>((resolve, reject) => {
      let cancelTimer: (() => void) | undefined;
      const entry: Entry = { request: { ...request }, body, resolve: value => resolve(value as T), reject, started: false,
        cleanup: () => { cancelTimer?.(); request.signal?.removeEventListener('abort', abort); } };
      const cancel = (reason: 'aborted' | 'expired') => {
        if (entry.started) return; // An active native promise must actually settle before another dialog can enter.
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); entry.cleanup(); reject(new NativeDialogCancelledError(reason));
      };
      const abort = () => cancel('aborted');
      this.queue.push(entry);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.deadline !== undefined) cancelTimer = this.clock.schedule(() => cancel('expired'), Math.max(0, request.deadline - this.clock.now()));
      if (request.signal?.aborted) cancel('aborted');
      this.pump();
    });
  }
  close(): void {
    this.closed = true;
    for (const entry of this.queue.splice(0)) { entry.cleanup(); entry.reject(new NativeDialogCancelledError('closed')); }
  }
  private pump(): void {
    if (this.active || this.closed) return;
    const entry = this.queue.shift(); if (!entry) return;
    this.active = entry; entry.started = true; entry.cleanup();
    const cancelled = () => this.closed ? new NativeDialogCancelledError('closed') : entry.request.signal?.aborted ? new NativeDialogCancelledError('aborted') : entry.request.deadline !== undefined && this.clock.now() >= entry.request.deadline ? new NativeDialogCancelledError('expired') : undefined;
    const finish = (ok: boolean, value: unknown) => {
      this.active = undefined;
      if (ok) { const error = cancelled(); if (error) entry.reject(error); else entry.resolve(value); }
      else entry.reject(value);
      this.pump();
    };
    void Promise.resolve().then(() => { const error = cancelled(); if (error) throw error; return entry.body(); }).then(value => finish(true, value), error => finish(false, error));
  }
}
