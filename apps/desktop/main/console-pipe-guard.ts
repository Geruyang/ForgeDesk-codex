interface ErrorStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  removeListener(event: 'error', listener: (error: unknown) => void): unknown;
}
type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
interface StandardConsole { log(...args: unknown[]): unknown; info(...args: unknown[]): unknown; debug(...args: unknown[]): unknown; warn(...args: unknown[]): unknown; error(...args: unknown[]): unknown }
export function isBrokenStandardPipe(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; syscall?: unknown };
  return value.code === 'EPIPE' && value.syscall === 'write';
}

/** A detached launcher may close stdio while the application must retain device ownership. */
export function installConsolePipeGuard(options: { console: StandardConsole; stdout: ErrorStream; stderr: ErrorStream; onPipeClosed(stream: 'stdout' | 'stderr'): void }): () => void {
  const reported = new Set<'stdout' | 'stderr'>();
  const report = (stream: 'stdout' | 'stderr') => {
    if (reported.has(stream)) return;
    reported.add(stream); options.onPipeClosed(stream);
  };
  const listeners = (['stdout', 'stderr'] as const).map(stream => {
    const listener = (error: unknown) => {
      if (!isBrokenStandardPipe(error)) throw error;
      report(stream);
    };
    options[stream].on('error', listener);
    return { stream, listener };
  });
  const methods = (['log', 'info', 'debug', 'warn', 'error'] as const).map((name: ConsoleMethod) => {
    const original = options.console[name];
    const wrapped = function (this: unknown, ...args: unknown[]) {
      try { return Reflect.apply(original, this, args); }
      catch (error) {
        if (!isBrokenStandardPipe(error)) throw error;
        report(name === 'warn' || name === 'error' ? 'stderr' : 'stdout');
      }
    };
    options.console[name] = wrapped;
    return { name, original, wrapped };
  });
  return () => {
    for (const { stream, listener } of listeners) options[stream].removeListener('error', listener);
    for (const { name, original, wrapped } of methods) if (options.console[name] === wrapped) options.console[name] = original;
  };
}
