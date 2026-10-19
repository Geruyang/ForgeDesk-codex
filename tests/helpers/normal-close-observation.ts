export type NormalCloseObservation =
  | { state: 'acknowledged' }
  | { state: 'rejected'; error: unknown }
  | { state: 'timed-out'; timeoutMs: number };

export function observeNormalCloseRequest(request: PromiseLike<unknown>, timeoutMs: number): Promise<NormalCloseObservation> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Normal close observation requires a positive finite timeout');
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: NormalCloseObservation) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => finish({ state: 'timed-out', timeoutMs }), timeoutMs);
    Promise.resolve(request).then(() => finish({ state: 'acknowledged' }), error => finish({ state: 'rejected', error }));
  });
}
