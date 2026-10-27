// Split chunks are named relative to the bundle entry. Their dependency
// list is a preload hint for QuickJS; native ESM follows the same imports,
// preserving cycles, evaluation order, module identity and top-level await.
export function createChunkLoader(entry, live, load = url => import(url), prepare = () => {}) {
  return async (specifier, dependencies = []) => {
    if (!live()) throw new Error("the app was disposed");
    await Promise.all([specifier, ...dependencies].map(prepare));
    if (!live()) throw new Error("the app was disposed");
    const module = await load(new URL(specifier, entry).href);
    if (!live()) throw new Error("the app was disposed");
    return module;
  };
}
