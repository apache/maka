export function throwDeduplicatedFailures(message: string, failures: readonly unknown[]): void {
  const unique = [...new Set(failures)];
  if (unique.length === 0) return;
  if (unique.length === 1) throw unique[0];
  throw new AggregateError(unique, message);
}
