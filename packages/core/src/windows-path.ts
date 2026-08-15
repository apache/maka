import { isNormalizedAbsolutePath } from './absolute-path.js';

/**
 * Canonical Windows path helpers shared by core permission contracts and the
 * Windows sandbox compiler/backend. A canonical Windows path is drive-absolute
 * (`C:\...`), backslash-separated, free of `.`/`..`/empty segments and free of
 * trailing separators (except the volume root itself). UNC and device paths
 * are rejected: sandbox roots and broker artifacts are always local files.
 */
export function isCanonicalWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) && isNormalizedAbsolutePath(path);
}

/**
 * Returns `path` unchanged when it is canonical, otherwise throws. Callers
 * that must additionally reject volume roots (e.g. sandbox grant targets)
 * layer that check on top.
 */
export function canonicalWindowsPath(path: string): string {
  if (!isCanonicalWindowsPath(path)) {
    throw new Error(
      `Windows sandbox path must be absolute, use backslashes and be lexically canonical: ${path}`,
    );
  }
  return path;
}
