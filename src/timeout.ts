/**
 * Races `fn` against a ref'd setTimeout, guaranteeing the returned promise
 * settles within `ms` even if `fn`'s promise never resolves or rejects
 * (e.g. a fetch stuck on DNS resolution that AbortSignal.timeout can't
 * cancel). A ref'd timer also keeps the event loop alive for the full `ms`,
 * preventing a premature process exit while `fn` is still pending.
 */
export function withTimeout<T>(fn: () => Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
