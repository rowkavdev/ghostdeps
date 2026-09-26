/**
 * Single-writer queue for maintained comments (reviewer-1 #425 round 2,
 * lead ruling issuecomment-5847830199). GitHub's comment API has no atomic
 * conditional update, so the scan writer and the edited handler serialize
 * their ENTIRE read-modify-write critical sections through one keyed lock:
 * no scan render can interleave between the handler's live reads and its
 * write, and two scan renders cannot double-create.
 *
 * Residuals (activation-gate notes on the PR):
 * - In-process only. Horizontal scaling to 2+ app replicas reopens the
 *   race until a durable shared lock exists (#258 territory).
 * - A human editing in the instant between the final read and the write
 *   is narrowed, not eliminated; the live re-reads plus canonical-revert
 *   and the next scan's reconciliation keep that window safe.
 */
const tails = new Map<string, Promise<void>>();

/** The shared lock key for every writer of one PR's maintained comment. */
export function commentLockKey(repositoryId: number, pullNumber: number): string {
  return `${repositoryId}:${pullNumber}`;
}

/** Run `fn` after every prior holder of `key` has settled. */
export async function withCommentLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Evict only when nobody queued behind us, so the map cannot grow
    // unboundedly across quiet PRs.
    if (tails.get(key) === tail) tails.delete(key);
  }
}
