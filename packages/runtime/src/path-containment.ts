/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Shared filesystem-containment and identifier guards. This is the single
 * authority for path-containment checks across Runtime and the desktop main:
 * both the pure-Node runtime and the desktop main (which
 * already depends on `@maka/runtime`) reach it here without reverse
 * dependencies. {@link isPathInside} itself is a pure `node:path` predicate; the
 * canonicalisation and contained-I/O helpers around it touch the filesystem.
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

/**
 * Canonicalise `target` even when its leaf (or a run of trailing segments) does
 * not exist yet: the deepest existing ancestor is realpath'd and the missing
 * segments are appended. Containment can then be decided against a realpath'd
 * root in a single path space, which is what {@link isPathInside} assumes —
 * comparing a realpath'd root against a merely `resolve`d candidate rejects
 * every legitimate absolute path whenever the root sits under a symlink (macOS
 * `/var` → `/private/var`, symlinked workspace roots).
 *
 * Because symlinks are followed all the way to the leaf, this never legalises
 * an escape: a link inside the root that points out of it resolves to its
 * outside target and fails containment. That includes a dangling link, whose
 * `realpath` fails ENOENT — the link is read and followed by hand, because a
 * write through it lands on its target, not on the link.
 *
 * Throws the underlying error when a path component is unreadable rather than
 * missing, so permission problems are not silently treated as containment, and
 * when a symlink cycle keeps the walk from terminating.
 */
export async function realpathAllowMissing(target: string): Promise<string> {
  let cursor = resolve(target);
  const missing: string[] = [];
  // `realpath` reports a cycle as ELOOP, so each hop consumes one existing link
  // and the walk terminates; the cap is a backstop against a pathological
  // filesystem, not the cycle guard.
  let hops = 0;
  while (true) {
    try {
      const realExisting = await realpath(cursor);
      return resolve(realExisting, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const link = await readlink(cursor).catch(() => null);
      if (link !== null) {
        if (++hops > MAX_DANGLING_SYMLINK_HOPS)
          throw new Error(`Path ${JSON.stringify(target)} traverses too many dangling symlinks.`);
        cursor = resolve(dirname(cursor), link);
        continue;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export interface CanonicalDirectoryEntryTarget {
  root: string;
  path: string;
  existingAncestor: string;
}

/**
 * Resolve a directory entry without following its final component. This is the
 * shared identity for create/delete locking, permission checks, sandbox grants,
 * and execution; content updates continue to use the followed target instead.
 */
export async function resolveCanonicalDirectoryEntryTarget(
  cwd: string,
  inputPath: string,
): Promise<CanonicalDirectoryEntryTarget> {
  const root = await realpath(cwd);
  const requested = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const parent = await realpathAllowMissing(dirname(requested));
  let existingAncestor = parent;
  while (true) {
    try {
      if ((await lstat(existingAncestor)).isDirectory()) break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const next = dirname(existingAncestor);
    if (next === existingAncestor)
      throw new Error(`No directory contains ${JSON.stringify(inputPath)}`);
    existingAncestor = next;
  }
  return {
    root,
    path: resolve(parent, basename(requested)),
    existingAncestor,
  };
}

/** Dangling links followed by {@link realpathAllowMissing} before it gives up. */
const MAX_DANGLING_SYMLINK_HOPS = 32;

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
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
