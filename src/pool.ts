/**
 * Runs `worker` over `items` with up to `concurrency` in flight at once. Once
 * `clock() >= deadline`, workers stop picking up NEW items (in-flight work
 * still finishes) -- the remaining slots in the returned array stay
 * `undefined`. Callers must treat `undefined` as "not attempted this run".
 */
export async function pool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
  deadline: number = Infinity,
  clock: () => number = Date.now,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length).fill(undefined);
  let idx = 0;
  async function run(): Promise<void> {
    while (idx < items.length) {
      if (clock() >= deadline) return;
      const i = idx++;
      results[i] = await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
