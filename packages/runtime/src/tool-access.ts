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

import { posix, win32 } from 'node:path';

export type ToolFileOperation = 'read' | 'search' | 'write' | 'readwrite';
export type ToolKeyOperation = 'read' | 'write';

export type ToolResourceAccess =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly operation: ToolFileOperation;
      readonly recursive?: boolean;
    }
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly operation: ToolKeyOperation;
    }
  | { readonly kind: 'all' };

export type ToolAccesses = readonly ToolResourceAccess[];

export interface NormalizeToolAccessOptions {
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
}

const FILE_OPERATIONS = new Set<ToolFileOperation>(['read', 'search', 'write', 'readwrite']);
const KEY_OPERATIONS = new Set<ToolKeyOperation>(['read', 'write']);
const NO_ACCESSES: ToolAccesses = Object.freeze([]);
const ALL_ACCESSES: ToolAccesses = Object.freeze([Object.freeze({ kind: 'all' as const })]);

/** Constructors for the complete resource set a single tool call may access. */
export const ToolAccesses = {
  none(): ToolAccesses {
    return NO_ACCESSES;
  },

  all(): ToolAccesses {
    return ALL_ACCESSES;
  },

  file(
    operation: ToolFileOperation,
    path: string,
    options: NormalizeToolAccessOptions & { readonly recursive?: boolean } = {},
  ): ToolAccesses {
    return [
      {
        kind: 'file',
        operation,
        path: normalizeToolFilePath(path, options),
        ...(options.recursive === true ? { recursive: true } : {}),
      },
    ];
  },

  readFile(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('read', path, options);
  },

  readTree(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('read', path, { ...options, recursive: true });
  },

  writeFile(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('write', path, options);
  },

  writeTree(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('write', path, { ...options, recursive: true });
  },

  readWriteFile(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('readwrite', path, options);
  },

  readWriteTree(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('readwrite', path, { ...options, recursive: true });
  },

  searchTree(path: string, options?: NormalizeToolAccessOptions): ToolAccesses {
    return ToolAccesses.file('search', path, { ...options, recursive: true });
  },

  readKey(key: string): ToolAccesses {
    return [{ kind: 'key', key: normalizeToolKey(key), operation: 'read' }];
  },

  writeKey(key: string): ToolAccesses {
    return [{ kind: 'key', key: normalizeToolKey(key), operation: 'write' }];
  },
} as const;

/**
 * Normalize and validate declarations before they enter a Scheduler. This is
 * lexical only: resolving symlinks or junctions belongs to tool preparation,
 * never the Scheduler's hot conflict path.
 */
export function normalizeToolAccesses(
  accesses: ToolAccesses,
  options: NormalizeToolAccessOptions = {},
): ToolAccesses {
  if (!Array.isArray(accesses)) throw new TypeError('Tool accesses must be an array');
  if (accesses.length === 0) return ToolAccesses.none();

  return accesses.map((access): ToolResourceAccess => {
    if (!access || typeof access !== 'object') {
      throw new TypeError('Tool access entries must be objects');
    }
    if (access.kind === 'all') return { kind: 'all' };
    if (access.kind === 'file') {
      if (!FILE_OPERATIONS.has(access.operation)) {
        throw new TypeError(`Unsupported file access operation: ${String(access.operation)}`);
      }
      return {
        kind: 'file',
        operation: access.operation,
        path: normalizeToolFilePath(access.path, options),
        ...(access.recursive === true ? { recursive: true } : {}),
      };
    }
    if (access.kind === 'key') {
      if (!KEY_OPERATIONS.has(access.operation)) {
        throw new TypeError(`Unsupported key access operation: ${String(access.operation)}`);
      }
      return {
        kind: 'key',
        key: normalizeToolKey(access.key),
        operation: access.operation,
      };
    }
    throw new TypeError(
      `Unsupported tool access kind: ${String((access as { kind?: unknown }).kind)}`,
    );
  });
}

export function normalizeToolFilePath(
  path: string,
  options: NormalizeToolAccessOptions = {},
): string {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new TypeError('File access path must be a non-empty string');
  }
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  let normalized = pathApi.resolve(cwd, path).replaceAll('\\', '/');
  const root = pathApi.parse(pathApi.resolve(cwd, path)).root.replaceAll('\\', '/');
  while (normalized.length > root.length && normalized.endsWith('/'))
    normalized = normalized.slice(0, -1);
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

export function toolAccessesConflict(left: ToolAccesses, right: ToolAccesses): boolean {
  return left.some((leftAccess) =>
    right.some((rightAccess) => toolResourceAccessesConflict(leftAccess, rightAccess)),
  );
}

export function toolResourceAccessesConflict(
  left: ToolResourceAccess,
  right: ToolResourceAccess,
): boolean {
  if (left.kind === 'all' || right.kind === 'all') return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'key' && right.kind === 'key') {
    return left.key === right.key && (left.operation === 'write' || right.operation === 'write');
  }
  if (left.kind === 'file' && right.kind === 'file') {
    if (!fileOperationWrites(left.operation) && !fileOperationWrites(right.operation)) return false;
    return fileRangesOverlap(left, right);
  }
  return false;
}

function fileOperationWrites(operation: ToolFileOperation): boolean {
  return operation === 'write' || operation === 'readwrite';
}

function fileRangesOverlap(
  left: Extract<ToolResourceAccess, { kind: 'file' }>,
  right: Extract<ToolResourceAccess, { kind: 'file' }>,
): boolean {
  if (left.path === right.path) return true;
  return (
    (left.recursive === true && isPathWithin(left.path, right.path)) ||
    (right.recursive === true && isPathWithin(right.path, left.path))
  );
}

function isPathWithin(parent: string, candidate: string): boolean {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return candidate.startsWith(prefix);
}

function normalizeToolKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('Logical resource key must be a non-empty string');
  }
  return key.trim();
}
