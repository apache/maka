// packages/runtime/src/file-write-lock.ts
// Serialize file-mutating tools (Write/Edit) per file. The AI SDK runs a single
// step's tool calls concurrently, so two edits to one file would race on the
// read-modify-write (read -> replace -> write back) and silently lose an update.
// withFileWriteLock(key, fn) runs work sharing a key strictly one-at-a-time, in
// submission order; distinct keys run concurrently. Callers pass a key that
// uniquely identifies the target file within their tool surface. Runtime tools
// key on the resolved absolute path. A failed task never wedges its key, and keys are reclaimed
// once their chain drains, so the map stays bounded.
//
// Keying is lexical, so one file reached under two names — via a symlinked parent
// dir, a hard link, or a case-insensitive filesystem ("a.txt" vs "A.txt") — takes
// two keys and is not merged. This matches opencode's lexical (path.resolve)
// per-file Semaphore. (Bash is not serialized either — a per-file lock cannot key
// arbitrary shell.)

const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` exclusively for `key`: it waits until any prior work for `key`
 * settles, then runs, then releases the key for the next waiter. Distinct keys
 * never block each other.
 *
 * @internal File tools own the keying, so an external caller would only share
 * this process-global queue by accident.
 */
export function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run fn after prev settles either way: a prior failed task must not wedge the
  // key. `prev.then(fn, fn)` ignores prev's outcome and just sequences.
  const run = prev.then(fn, fn);
  // The next waiter chains off `tail`, which tracks completion only (swallowing
  // result and error) so one task's rejection never propagates down the chain.
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Drop the key once nobody chained after us, so the map stays bounded.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
