export interface PoolResult<R> {
  index: number;
  item: any;
  status: "fulfilled" | "rejected";
  value: R;
  reason: string;
}

export async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      const item = items[i];
      try {
        const value = await fn(item, i);
        results[i] = { index: i, item, status: "fulfilled", value, reason: "" };
      } catch (err) {
        results[i] = {
          index: i,
          item,
          status: "rejected",
          value: undefined as any,
          reason: (err as Error).message || String(err),
        };
      }
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results;
}
