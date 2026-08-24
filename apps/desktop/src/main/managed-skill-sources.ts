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
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { isPathInside, isSafeSkillId } from '@maka/runtime/path-containment';

import {
  normalizeManagedSkillCategory,
  resolveManagedSkillSourcesRoot,
  validateSkillMetadata,
  type ManagedSkillSourceRecord,
  type SkillValidationIssue,
} from '@maka/runtime/skills';

export { listManagedSkillSources, readManagedSkillSource, resolveManagedSkillSourcesRoot, toManagedSkillSourceEntry } from '@maka/runtime/skills';
export type { ManagedSkillSourceRecord } from '@maka/runtime/skills';

export type ImportManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord }
  | {
      ok: false;
      reason: 'cancelled' | 'invalid_skill' | 'already_exists' | 'blocked_path' | 'write_failed';
      diagnostics?: SkillValidationIssue[];
    };

export async function importManagedSkillSource(input: {
  root?: string;
  sourceFile: string;
}): Promise<ImportManagedSkillSourceResult> {
  const root = input.root ?? resolveManagedSkillSourcesRoot();
  let sourceStat: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceStat = await lstat(input.sourceFile);
  } catch {
    return { ok: false, reason: 'invalid_skill' };
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };

  let bytes: Buffer;
  try {
    bytes = await readFile(input.sourceFile);
  } catch {
    return { ok: false, reason: 'invalid_skill' };
  }

  const content = bytes.toString('utf8');
  const validation = validateSkillMetadata(content);
  if (!validation.valid) {
    return { ok: false, reason: 'invalid_skill', diagnostics: validation.issues };
  }
  const { name, description, category } = validation.manifest;
  if (!name || !description) {
    return { ok: false, reason: 'invalid_skill', diagnostics: validation.issues };
  }

  const id = sourceIdFromPath(input.sourceFile);
  if (!id) return { ok: false, reason: 'invalid_skill' };

  const sourceDir = join(root, id);
  const managedSkillPath = join(sourceDir, 'SKILL.md');
  const now = new Date().toISOString();
  const contentSha256 = `sha256:${sha256(bytes)}`;

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sourceRoot = await resolveExistingSourceRoot(root);
    if (!sourceRoot.ok) return { ok: false, reason: 'blocked_path' };

    await mkdir(sourceDir, { mode: 0o700 });
    const sourceDirReal = await resolveContainedDirectory(sourceRoot.rootReal, sourceDir);
    if (!sourceDirReal.ok) return { ok: false, reason: 'blocked_path' };
    if (!(await writeContainedBufferFile(sourceDirReal.path, managedSkillPath, bytes, { failIfExists: true }))) {
      return { ok: false, reason: 'write_failed' };
    }

    const source: ManagedSkillSourceRecord = {
      id,
      name,
      description,
      category: normalizeManagedSkillCategory(category),
      sourceType: 'local',
      sourcePath: managedSkillPath,
      contentSha256,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'already_exists' };
    return { ok: false, reason: 'write_failed' };
  }
}

async function resolveExistingSourceRoot(root: string): Promise<
  | { ok: true; rootReal: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' }
> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    return { ok: true, rootReal: await realpath(root) };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function resolveContainedDirectory(rootReal: string, directory: string): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' }
> {
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return { ok: false, reason: 'blocked_path' };
    const directoryReal = await realpath(directory);
    if (!isPathInside(rootReal, directoryReal)) return { ok: false, reason: 'blocked_path' };
    return { ok: true, path: directoryReal };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

async function writeContainedBufferFile(
  rootDir: string,
  filePath: string,
  bytes: Buffer,
  options: { failIfExists?: boolean } = {},
): Promise<boolean> {
  const tempPath = join(rootDir, `.maka-source-write.${process.pid}.${Date.now()}.tmp`);
  try {
    const rootReal = await realpath(rootDir);
    const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null) {
      if (options.failIfExists) return false;
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
      const fileReal = await realpath(filePath);
      if (!isPathInside(rootReal, fileReal)) return false;
    }
    await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
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

function sourceIdFromPath(filePath: string): string | undefined {
  const fileName = basename(filePath).toLowerCase() === 'skill.md'
    ? basename(dirname(filePath))
    : basename(filePath, extname(filePath));
  const normalized = fileName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return isSafeSkillId(normalized) ? normalized : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
