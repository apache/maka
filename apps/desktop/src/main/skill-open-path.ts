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
import { join } from 'node:path';
import { isPathInside, isSafeSkillId } from '@maka/runtime/path-containment';

import { resolveSkillDiscoveryPaths, scanSkillsWithDiagnostics } from '@maka/runtime/skills';

export type SkillOpenTarget = 'file' | 'directory';

export type ResolveSkillOpenPathResult =
  | { readonly ok: true; readonly path: string; readonly target: SkillOpenTarget }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_id'
        | 'missing'
        | 'blocked_path'
        | 'not_file'
        | 'not_directory';
    };

export async function resolveSkillOpenPath(
  workspaceRoot: string,
  idOrRef: string,
  target: SkillOpenTarget,
  projectRoot: string,
): Promise<ResolveSkillOpenPathResult> {
  if (target !== 'file' && target !== 'directory') return { ok: false, reason: 'missing' };

  if (!isSafeSkillId(idOrRef)) {
    if (!idOrRef.includes(':') || idOrRef.length > 512) {
      return { ok: false, reason: 'invalid_id' };
    }
    const scan = await scanSkillsWithDiagnostics(
      resolveSkillDiscoveryPaths(projectRoot, workspaceRoot),
    );
    const skill = [...scan.inventory, ...scan.rejected].find(({ ref }) => ref === idOrRef);
    if (!skill) return { ok: false, reason: 'missing' };
    return resolveContainedTarget(skill.discoveryRoot, skill.path, target);
  }

  const skillsDir = join(workspaceRoot, 'skills');
  let workspaceReal: string;
  let skillsReal: string;
  try {
    [workspaceReal, skillsReal] = await Promise.all([
      realpath(workspaceRoot),
      realpath(skillsDir),
    ]);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isPathInside(workspaceReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  return resolveContainedTarget(skillsReal, join(skillsDir, idOrRef), target);
}

async function resolveContainedTarget(
  containmentRoot: string,
  skillPath: string,
  target: SkillOpenTarget,
): Promise<ResolveSkillOpenPathResult> {
  const candidate = target === 'file' ? join(skillPath, 'SKILL.md') : skillPath;
  try {
    const [containmentReal, openedPath] = await Promise.all([
      realpath(containmentRoot),
      realpath(candidate),
    ]);
    if (!isPathInside(containmentReal, openedPath)) return { ok: false, reason: 'blocked_path' };
    const opened = await stat(openedPath);
    if (target === 'file' && !opened.isFile()) return { ok: false, reason: 'not_file' };
    if (target === 'directory' && !opened.isDirectory()) {
      return { ok: false, reason: 'not_directory' };
    }
    return { ok: true, path: openedPath, target };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}
