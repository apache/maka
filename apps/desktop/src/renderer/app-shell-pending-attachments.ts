export type PendingByKey<T> = Record<string, T[]>;

export function selectPending<T>(map: PendingByKey<T>, key: string): T[] {
  return map[key] ?? [];
}

export function appendPending<T>(
  map: PendingByKey<T>,
  key: string,
  items: readonly T[],
): PendingByKey<T> {
  return { ...map, [key]: [...(map[key] ?? []), ...items] };
}

export function removePending<T>(map: PendingByKey<T>, key: string, index: number): PendingByKey<T> {
  const current = map[key] ?? [];
  return { ...map, [key]: current.filter((_, i) => i !== index) };
}

export function removePendingItems<T>(
  map: PendingByKey<T>,
  key: string,
  items: readonly T[],
  identityOf: (item: T) => unknown = (item) => item,
): PendingByKey<T> {
  const submitted = new Set(items.map(identityOf));
  const remaining = (map[key] ?? []).filter((item) => !submitted.has(identityOf(item)));
  if (remaining.length === 0) return clearPending(map, key);
  return { ...map, [key]: remaining };
}

/**
 * Move one key's staged items to another, leaving nothing behind under the old
 * one. The destination takes exactly what the source had — including nothing —
 * so a bucket left under a key the composer merely passed through can never
 * resurface later as that key's own staged set.
 */
export function rekeyPending<T>(
  map: PendingByKey<T>,
  from: string,
  to: string,
): PendingByKey<T> {
  if (from === to) return map;
  const hasFrom = Object.hasOwn(map, from);
  const hasTo = Object.hasOwn(map, to);
  if (!hasFrom && !hasTo) return map;
  const moved = hasFrom ? (map[from] ?? []) : [];
  const next = { ...map };
  if (hasFrom) delete next[from];
  if (moved.length > 0) next[to] = moved;
  else if (hasTo) delete next[to];
  return next;
}

export function clearPending<T>(map: PendingByKey<T>, key: string): PendingByKey<T> {
  const next = { ...map };
  delete next[key];
  return next;
}
