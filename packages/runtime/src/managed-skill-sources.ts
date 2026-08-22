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
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isPathInside, isSafeSkillId } from './path-containment.js';
import { validateSkillMetadata } from './skills-metadata.js';

export const MANAGED_SKILL_CATEGORIES = [
  '内容创作',
  '数据与AI',
  '设计与UI',
  'DevOps与部署',
  '文档与写作',
  '效率工具',
  '研究与分析',
] as const;

export type ManagedSkillCategory = (typeof MANAGED_SKILL_CATEGORIES)[number];

export interface ManagedSkillSourceRecord {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  sourceType: 'local';
  sourcePath: string;
  contentSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedSkillSourceEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  sourceType: 'local';
}

export type ReadManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceRecord; content: string; contentSha256: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' };

export type ReadManagedSkillSourcesResult =
  | { ok: true; sources: ManagedSkillSourceRecord[] }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' };

const MANAGED_SKILL_CATEGORY_DEFAULT: ManagedSkillCategory = '效率工具';

export function normalizeManagedSkillCategory(raw: string | undefined): ManagedSkillCategory {
  if (raw && (MANAGED_SKILL_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ManagedSkillCategory;
  }
  return MANAGED_SKILL_CATEGORY_DEFAULT;
}

export function resolveManagedSkillSourcesRoot(homeDir = homedir()): string {
  const override = process.env.MAKA_SKILL_SOURCES_ROOT;
  if (override && isAbsolute(override) && process.env.MAKA_E2E_FIXTURE) {
    return override;
  }
  return join(homeDir, '.maka', 'skill-sources');
}

export async function listManagedSkillSources(
  root = resolveManagedSkillSourcesRoot(),
): Promise<ManagedSkillSourceRecord[]> {
  const sourceRoot = await resolveExistingSourceRoot(root);
  if (!sourceRoot.ok) return [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources: ManagedSkillSourceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
    const source = await readManagedSkillSource(root, entry.name);
    if (source.ok) sources.push(source.source);
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readManagedSkillSources(
  root = resolveManagedSkillSourcesRoot(),
): Promise<ReadManagedSkillSourcesResult> {
  const sourceRoot = await resolveExistingSourceRoot(root);
  if (!sourceRoot.ok) return sourceRoot;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  }
  const sources: ManagedSkillSourceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillId(entry.name)) continue;
    const source = await readManagedSkillSource(root, entry.name);
    if (source.ok) sources.push(source.source);
    else if (source.reason === 'read_failed') return source;
  }
  return { ok: true, sources: sources.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function readManagedSkillSource(
  root: string,
  sourceId: string,
): Promise<ReadManagedSkillSourceResult> {
  if (!isSafeSkillId(sourceId)) return { ok: false, reason: 'not_found' };

  const sourceRoot = await resolveExistingSourceRoot(root);
  if (!sourceRoot.ok) return { ok: false, reason: sourceRoot.reason };

  const sourceDir = join(root, sourceId);
  const sourcePath = join(sourceDir, 'SKILL.md');
  const sourceDirReal = await resolveContainedDirectory(sourceRoot.rootReal, sourceDir);
  if (!sourceDirReal.ok) return { ok: false, reason: sourceDirReal.reason };

  try {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
    const sourceReal = await realpath(sourcePath);
    if (!isPathInside(sourceDirReal.path, sourceReal)) {
      return { ok: false, reason: 'blocked_path' };
    }
    const bytes = await readFile(sourcePath);
    const contentSha256 = `sha256:${sha256(bytes)}`;
    const content = bytes.toString('utf8');
    const manifest = validateSkillMetadata(content).manifest;
    const source: ManagedSkillSourceRecord = {
      id: sourceId,
      name: manifest.name ?? sourceId,
      description: manifest.description ?? '',
      category: normalizeManagedSkillCategory(manifest.category),
      sourceType: 'local',
      sourcePath,
      contentSha256,
      createdAt: sourceStat.birthtime.toISOString(),
      updatedAt: sourceStat.mtime.toISOString(),
    };
    return { ok: true, source, content, contentSha256 };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  }
}

export function toManagedSkillSourceEntry(
  source: ManagedSkillSourceRecord,
): ManagedSkillSourceEntry {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    category: source.category,
    sourceType: source.sourceType,
  };
}

async function resolveExistingSourceRoot(
  root: string,
): Promise<
  | { ok: true; rootReal: string }
  | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' }
> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
    return { ok: true, rootReal: await realpath(root) };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  }
}

async function resolveContainedDirectory(
  rootReal: string,
  directory: string,
): Promise<
  { ok: true; path: string } | { ok: false; reason: 'not_found' | 'blocked_path' | 'read_failed' }
> {
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
    const directoryReal = await realpath(directory);
    if (!isPathInside(rootReal, directoryReal)) {
      return { ok: false, reason: 'blocked_path' };
    }
    return { ok: true, path: directoryReal };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
