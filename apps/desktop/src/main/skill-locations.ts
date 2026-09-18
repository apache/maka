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

import { lstat, mkdir, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isPathInside, realpathAllowMissing } from '@maka/runtime/path-containment';
import {
  resolveSkillDiscoveryPaths,
  scanSkillsWithDiagnostics,
  type SkillDiscoveryEntry,
} from '@maka/runtime/skills';
import type { SkillLocation, SkillLocationRef } from '@maka/ui';
import { withSkillLocationCounts } from '../shared/skill-location-counts.js';

export type ResolveSkillLocationResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown_location' | 'missing' | 'blocked_path' | 'read_failed' | 'create_failed';
    };

export interface SkillLocationContext {
  readonly projectRoot: string | null;
  readonly workspaceRoot: string;
  readonly homeDirectory?: string;
}

export function skillLocationScope(ref: string): SkillLocation['scope'] | undefined {
  switch (ref) {
    case 'project:maka':
    case 'project:agents':
      return 'project';
    case 'workspace:legacy':
      return 'workspace';
    case 'user:maka':
    case 'user:agents':
      return 'user';
    default:
      return undefined;
  }
}

export async function listSkillLocations(
  context: SkillLocationContext,
): Promise<SkillLocation[]> {
  const discovery = resolveSkillDiscoveryPaths(
    context.projectRoot,
    context.workspaceRoot,
    context.homeDirectory ?? homedir(),
  );
  const scan = await scanSkillsWithDiagnostics(discovery);
  const locations = await Promise.all(discovery.entries.map(async (entry) => {
    const ref = skillLocationRef(entry);
    const inspected = await inspectDirectory(entry.containmentRoot, entry.dir);
    const diagnostic = scan.discoveryDiagnostics.find(({ path }) => path === entry.dir);
    return {
      ref,
      scope: entry.scope as SkillLocation['scope'],
      source: entry.source as SkillLocation['source'],
      path: entry.dir,
      status: diagnostic?.reason ?? inspected.status,
    };
  }));
  return withSkillLocationCounts(locations, [...scan.inventory, ...scan.rejected]);
}

export async function resolveSkillLocation(
  context: SkillLocationContext,
  ref: string,
  createIfMissing: boolean,
): Promise<ResolveSkillLocationResult> {
  const scope = skillLocationScope(ref);
  if (!scope) return { ok: false, reason: 'unknown_location' };
  if (scope === 'project' && context.projectRoot === null) {
    return { ok: false, reason: 'read_failed' };
  }
  const discovery = resolveSkillDiscoveryPaths(
    context.projectRoot,
    context.workspaceRoot,
    context.homeDirectory ?? homedir(),
  );
  const entry = discovery.entries.find((candidate) => skillLocationRef(candidate) === ref);
  if (!entry) return { ok: false, reason: 'unknown_location' };

  const inspected = await inspectDirectory(entry.containmentRoot, entry.dir);
  if (inspected.status === 'available') return { ok: true, path: inspected.path };
  if (inspected.status === 'blocked_path') return { ok: false, reason: 'blocked_path' };
  if (inspected.status === 'read_failed') return { ok: false, reason: 'read_failed' };
  if (!createIfMissing) return { ok: false, reason: 'missing' };

  try {
    return { ok: true, path: await ensureContainedDirectory(entry.containmentRoot, entry.dir) };
  } catch {
    return { ok: false, reason: 'create_failed' };
  }
}

function skillLocationRef(
  entry: Pick<SkillDiscoveryEntry, 'scope' | 'source'>,
): SkillLocationRef {
  return `${entry.scope}:${entry.source}` as SkillLocationRef;
}

async function inspectDirectory(
  containmentRoot: string,
  target: string,
): Promise<
  | { readonly status: 'available'; readonly path: string }
  | { readonly status: 'missing' | 'blocked_path' | 'read_failed' }
> {
  if (!isPathInside(resolve(containmentRoot), resolve(target))) {
    return { status: 'blocked_path' };
  }

  let rootReal: string;
  try {
    rootReal = await realpath(containmentRoot);
  } catch {
    return { status: 'read_failed' };
  }

  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'read_failed' };
    }
    try {
      const targetReal = await realpathAllowMissing(target);
      return isPathInside(rootReal, targetReal)
        ? { status: 'missing' }
        : { status: 'blocked_path' };
    } catch {
      return { status: 'read_failed' };
    }
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return { status: 'blocked_path' };
  }
  try {
    const targetReal = await realpath(target);
    if (!isPathInside(rootReal, targetReal)) return { status: 'blocked_path' };
    const directory = await opendir(targetReal);
    await directory.close();
    return { status: 'available', path: targetReal };
  } catch {
    return { status: 'read_failed' };
  }
}

async function ensureContainedDirectory(
  containmentRoot: string,
  target: string,
): Promise<string> {
  if (!isPathInside(resolve(containmentRoot), resolve(target))) {
    throw new Error('Skill location escaped its root');
  }
  const rootReal = await realpath(containmentRoot);
  const targetReal = await realpathAllowMissing(target);
  if (!isPathInside(rootReal, targetReal)) {
    throw new Error('Skill location escaped its root');
  }
  await mkdir(targetReal, { recursive: true, mode: 0o700 });
  const [metadata, createdReal] = await Promise.all([lstat(target), realpath(target)]);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !isPathInside(rootReal, createdReal)
  ) {
    throw new Error('Skill location path must resolve to a contained directory');
  }
  return createdReal;
}
