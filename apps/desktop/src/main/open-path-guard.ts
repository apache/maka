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
import { join, resolve, relative, sep } from 'node:path';

export type OpenPathKey = 'workspace' | 'skills' | 'memory' | 'project';

export type OpenPathResult =
  | { ok: true; opened: OpenPathKey }
  | { ok: false; reason: OpenPathFailureReason };

export type OpenPathFailureReason =
  | 'unknown-key'
  | 'not-allowed'
  | 'missing'
  | 'not-a-directory'
  | 'open-failed';

export interface ResolveOpenPathInput {
  key: string;
  workspaceRoot: string;
  projectRoot?: string;
}

const OPEN_PATHS: Record<Exclude<OpenPathKey, 'project'>, (workspaceRoot: string) => string> = {
  workspace: (workspaceRoot) => workspaceRoot,
  skills: (workspaceRoot) => join(workspaceRoot, 'skills'),
  memory: (workspaceRoot) => join(workspaceRoot, 'memory'),
};

export async function resolveOpenPath(input: ResolveOpenPathInput): Promise<
  | { ok: true; key: OpenPathKey; path: string }
  | { ok: false; reason: OpenPathFailureReason }
> {
  if (!isOpenPathKey(input.key)) return { ok: false, reason: 'unknown-key' };

  if (input.key === 'project' && !input.projectRoot) return { ok: false, reason: 'missing' };
  const candidate = input.key === 'project'
    ? resolve(input.projectRoot!)
    : OPEN_PATHS[input.key](input.workspaceRoot);
  let root: string | undefined;
  let target: string;
  try {
    if (input.key === 'project') {
      target = await realpath(candidate);
    } else {
      [root, target] = await Promise.all([
        realpath(input.workspaceRoot),
        realpath(candidate),
      ]);
    }
  } catch {
    return { ok: false, reason: 'missing' };
  }

  if (root && !isInsideOrSamePath(root, target)) return { ok: false, reason: 'not-allowed' };

  const targetStat = await stat(target).catch(() => null);
  if (!targetStat) return { ok: false, reason: 'missing' };
  if (!targetStat.isDirectory()) return { ok: false, reason: 'not-a-directory' };

  return { ok: true, key: input.key, path: target };
}

function isOpenPathKey(value: string): value is OpenPathKey {
  return value === 'workspace' || value === 'skills' || value === 'memory' || value === 'project';
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}
