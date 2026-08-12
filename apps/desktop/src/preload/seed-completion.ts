export function notifyWhenSeeded(
  seed: Promise<unknown>,
  notify: (() => void) | undefined,
): () => void {
  let disposed = false;
  void seed
    .then(() => {
      if (!disposed) notify?.();
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
  };
}
