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

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { realpathAllowMissing } from './path-containment.js';
import {
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryAccess,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryScope,
} from '@maka/core/sandbox-boundary';

export interface NormalizedSandboxBoundaryPath {
  readonly displayPath: string;
  readonly enforcementPath: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
  readonly targetType: 'file' | 'directory' | 'other' | 'missing';
}

export async function normalizeSandboxBoundaryPath(input: {
  path: string;
  access: SandboxBoundaryAccess;
  scope: SandboxBoundaryScope | 'auto';
  cwd: string;
}): Promise<NormalizedSandboxBoundaryPath> {
  if (
    !input.path ||
    input.path.includes('\0') ||
    input.path.length > MAX_SANDBOX_BOUNDARY_PATH_CHARS
  ) {
    throw new Error('Sandbox boundary path is invalid or exceeds the length limit.');
  }
  const canonicalCwd = await fs.realpath(input.cwd);
  const displayPath = resolve(canonicalCwd, input.path);
  const enforcementPath = await realpathAllowMissing(displayPath);
  const targetType = await targetTypeFor(enforcementPath);
  const scope =
    input.scope === 'auto' ? (targetType === 'directory' ? 'subtree' : 'exact') : input.scope;
  if (scope === 'subtree' && targetType !== 'directory') {
    throw new Error('A subtree sandbox boundary must target an existing directory.');
  }
  return { displayPath, enforcementPath, access: input.access, scope, targetType };
}

export async function normalizeSandboxBoundaryExpansion(
  expansion: SandboxBoundaryExpansion,
  cwd: string,
): Promise<SandboxBoundaryExpansion> {
  const validated = validateSandboxBoundaryExpansion(expansion);
  if (!validated.ok) throw new Error(validated.message);
  const entries = await Promise.all(
    (validated.expansion.filesystem?.entries ?? []).map(async (entry) => {
      const normalized = await normalizeSandboxBoundaryPath({
        ...entry,
        cwd,
      });
      if (normalized.scope === 'exact' && normalized.targetType === 'directory') {
        throw new Error(
          'An exact sandbox boundary cannot target a directory; use subtree for directory access.',
        );
      }
      return {
        path: normalized.enforcementPath,
        access: normalized.access,
        scope: normalized.scope,
      };
    }),
  );
  const normalized = validateSandboxBoundaryExpansion({
    ...(entries.length > 0 ? { filesystem: { entries } } : {}),
    ...(validated.expansion.network ? { network: validated.expansion.network } : {}),
  });
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.expansion;
}

async function targetTypeFor(path: string): Promise<NormalizedSandboxBoundaryPath['targetType']> {
  try {
    const stat = await fs.stat(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
