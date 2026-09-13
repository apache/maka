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

import {
  canonicalProjectDirectoryRootSpec,
  PROJECT_DIRECTORY_MAX_ROOTS,
  projectDirectoryPosixRootSpecValid,
  type ProjectDirectoryRootSpec,
} from '@maka/runtime-host/protocol';

export type RuntimeHostProjectDirectoryRootInput = ProjectDirectoryRootSpec;

export function canonicalProjectDirectoryRoots(
  roots: readonly RuntimeHostProjectDirectoryRootInput[],
): readonly RuntimeHostProjectDirectoryRootInput[] {
  return roots.map(canonicalProjectDirectoryRootSpec);
}

export function projectDirectoryRootsValid(
  roots: readonly RuntimeHostProjectDirectoryRootInput[],
): boolean {
  if (roots.length > PROJECT_DIRECTORY_MAX_ROOTS) return false;
  const canonical = canonicalProjectDirectoryRoots(roots);
  return (
    canonical.every(projectDirectoryPosixRootSpecValid) &&
    new Set(canonical.map(({ label }) => label)).size === canonical.length
  );
}

export function requireProjectDirectoryRoots(
  value: unknown,
): readonly RuntimeHostProjectDirectoryRootInput[] {
  if (!Array.isArray(value) || value.length > PROJECT_DIRECTORY_MAX_ROOTS) {
    throw new Error('Runtime Host Project directory policy is invalid');
  }
  const roots = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Runtime Host Project directory is invalid');
    }
    const root = candidate as Record<string, unknown>;
    if (
      Object.keys(root).length !== 2 ||
      typeof root.label !== 'string' ||
      typeof root.path !== 'string'
    ) {
      throw new Error('Runtime Host Project directory is invalid');
    }
    const canonical = canonicalProjectDirectoryRootSpec({ label: root.label, path: root.path });
    if (!projectDirectoryPosixRootSpecValid(canonical)) {
      throw new Error('Runtime Host Project directory is invalid');
    }
    return canonical;
  });
  if (new Set(roots.map(({ label }) => label)).size !== roots.length) {
    throw new Error('Runtime Host Project directory labels must be unique');
  }
  return roots;
}
