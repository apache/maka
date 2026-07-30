import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Shared filesystem-containment and identifier guards. This is the single
 * authority for path-containment checks across the runtime, the desktop main
 * process, and headless: both the pure-Node runtime and the desktop main (which
 * already depends on `@maka/runtime`) reach it here without reverse
 * dependencies. The leaf imports only `node:path`.
 *
 * {@link isPathInside} is separator-aware: it rejects only a real
 * parent-reference segment (`..` exactly, or `..${sep}`-prefixed), so a child
 * entry whose own name begins with `..` (e.g. `root/..foo`) is correctly
 * treated as inside. Its `pathApi` parameter makes the Windows cross-drive case
 * and POSIX sandbox paths testable. The bare-`startsWith('..')` variant that
 * preceded it was retired in #1145 because it misclassified such names as
 * escapes; identifier safety is handled separately by {@link isSafeSkillId}.
 */

/**
 * True when `target` is inside (or equal to) `root`. Used by the skill reader,
 * the managed skill-source store, the filesystem worker, and the workspace
 * executor to keep resolved paths inside their approved root.
 */
export function isPathInside(
  root: string,
  target: string,
  pathApi: PathInsideApi = { relative, isAbsolute, sep },
): boolean {
  const rel = pathApi.relative(root, target);
  // path.relative returns the target path unchanged (absolute) when root and
  // target are on different drives on Windows. An absolute result means the
  // target is not reachable from root via a relative path, so reject it before
  // the `..` escape check.
  if (pathApi.isAbsolute(rel)) return false;
  // Reject only a real parent-reference segment: the exact ".." or a path
  // starting with `..${sep}`. A leading ".." followed by anything else (e.g.
  // "..rules") is a legitimate directory name, not an escape.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`));
}

/** Path primitives {@link isPathInside} uses, injectable for cross-platform tests. */
export interface PathInsideApi {
  relative: typeof relative;
  isAbsolute: typeof isAbsolute;
  sep: string;
}

/** True when `value` is a safe skill/source identifier (no path or control chars). */
export function isSafeSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value);
}

/** Relative POSIX path from `root` to `target`, or `.` when they are equal. */
export function toRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

// ── Contained file I/O ────────────────────────────────────────────────────

/**
 * Read a regular file, verifying its realpath stays inside `rootDir`.
 * Rejects symlinks and paths that escape the containment root.
 */
export async function readContainedRegularFile(
  rootDir: string,
  filePath: string,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  try {
    const [rootReal, fileStat] = await Promise.all([realpath(rootDir), lstat(filePath)]);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { ok: false };
    const fileReal = await realpath(filePath);
    if (!isPathInside(rootReal, fileReal)) return { ok: false };
    return { ok: true, bytes: await readFile(filePath) };
  } catch {
    return { ok: false };
  }
}

/**
 * Read a regular text file, verifying its realpath stays inside `rootDir`.
 * Returns the content and its sha256 hash.
 */
export async function readContainedRegularTextFile(
  rootDir: string,
  filePath: string,
): Promise<
  | { ok: true; content: string; sha256: string }
  | { ok: false; reason: 'blocked_path' | 'read_failed' }
> {
  try {
    const [rootReal, fileStat] = await Promise.all([realpath(rootDir), lstat(filePath)]);
    if (!fileStat.isFile() || fileStat.isSymbolicLink())
      return { ok: false, reason: 'blocked_path' };
    const fileReal = await realpath(filePath);
    if (!isPathInside(rootReal, fileReal)) return { ok: false, reason: 'blocked_path' };
    const content = await readFile(filePath, 'utf8');
    return { ok: true, content, sha256: `sha256:${sha256(content)}` };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}

/**
 * Atomically write a text file inside `rootDir` via a temp file + rename.
 * Rejects symlinks and paths that escape the containment root.
 */
export async function writeContainedRegularTextFile(
  rootDir: string,
  filePath: string,
  content: string,
): Promise<boolean> {
  const tempPath = join(rootDir, `.maka-write.${process.pid}.${Date.now()}.tmp`);
  try {
    const rootReal = await realpath(rootDir);
    const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) return false;
    if (existing !== null) {
      const fileReal = await realpath(filePath);
      if (!isPathInside(rootReal, fileReal)) return false;
    }
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const tempStat = await lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    const tempReal = await realpath(tempPath);
    if (!isPathInside(rootReal, tempReal)) {
      await unlink(tempPath).catch(() => {});
      return false;
    }
    await rename(tempPath, filePath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => {});
    return false;
  }
}

// ── Generic type guard ────────────────────────────────────────────────────

/** True when `value` is a plain record (object, not array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Crypto helper ─────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
