import { join } from 'node:path';

/**
 * Root that `apps/desktop/assets` hangs off at runtime.
 *
 * Dev resolves the repo layout: two levels up from the built main bundle in
 * `dist/main/` lands on `apps/desktop`. A packaged app has no such tree —
 * `files` in the builder config carries `dist/`, `dist-renderer/` and
 * `package.json`, and nothing else — so the assets ride along as an extra
 * resource and the same segments hang off `process.resourcesPath` instead.
 *
 * Resolving the dev path in a packaged build fails silently: Electron reports
 * an unreadable file as an EMPTY NativeImage rather than as an error, and the
 * BrowserWindow `icon` option simply draws nothing.
 */
export function desktopAssetRoot(runtime: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): string {
  return runtime.isPackaged ? runtime.resourcesPath : join(import.meta.dirname, '..', '..');
}

export function desktopAssetPath(
  runtime: { readonly isPackaged: boolean; readonly resourcesPath: string },
  ...segments: readonly string[]
): string {
  return join(desktopAssetRoot(runtime), ...segments);
}
