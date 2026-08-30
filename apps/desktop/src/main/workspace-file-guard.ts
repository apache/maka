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

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const RELATIVE_PATH_MAX_LENGTH = 4096;

export type WorkspaceFileFailureReason = 'invalid' | 'missing' | 'not-a-file' | 'not-allowed';

export async function resolveWorkspaceFile(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}): Promise<
  | { ok: true; path: string; root: string; relativePath: string }
  | { ok: false; reason: WorkspaceFileFailureReason }
> {
  const relativePath = parseWorkspaceRelativePath(input.relativePath);
  if (!relativePath) return { ok: false, reason: 'invalid' };
  if (!/\.(?:md|markdown|mdx)$/i.test(relativePath)) {
    return { ok: false, reason: 'not-a-file' };
  }

  let root: string;
  let target: string;
  try {
    [root, target] = await Promise.all([
      realpath(input.workspaceRoot),
      realpath(resolve(input.workspaceRoot, relativePath)),
    ]);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isInsideOrSamePath(root, target) || target === root) {
    return { ok: false, reason: 'not-allowed' };
  }
  if (!isMarkdownPath(target)) return { ok: false, reason: 'not-a-file' };

  const targetStat = await stat(target).catch(() => null);
  if (!targetStat) return { ok: false, reason: 'missing' };
  if (!targetStat.isFile()) return { ok: false, reason: 'not-a-file' };
  return { ok: true, path: target, root, relativePath };
}

export function isAllowedWorkspaceMarkdownPath(path: string): boolean {
  return isMarkdownPath(path);
}

function parseWorkspaceRelativePath(value: string): string | null {
  if (value.length === 0 || value.length > RELATIVE_PATH_MAX_LENGTH) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return null;
  if (decoded.startsWith('/') || decoded.startsWith('~') || decoded.startsWith('\\')) return null;
  if (decoded.includes('\\') || decoded.includes('?') || decoded.includes('#')) return null;
  const segments = decoded.replace(/^\.\//, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isPathInsideWorkspace(root: string, target: string): boolean {
  return isInsideOrSamePath(root, target) && target !== root;
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path);
}
