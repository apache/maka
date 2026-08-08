// Loader hook used by renderer-core-barrel-node-boundary.test.ts. It enforces
// the structural invariant under test: a `node:*` import cannot resolve in the
// renderer's browser-like environment, so the moment the @maka/core barrel
// graph reaches Node-only code this hook throws and the child process fails.

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => Promise<{ url: string }>,
): Promise<{ url: string }> {
  if (specifier.startsWith('node:')) {
    throw new Error(`renderer core barrel evaluated Node-only module: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
