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

import { requireEntityId, requireExactRecord, requireRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export const WORKSPACE_HOST_PATH_MAX_BYTES = 4 * 1024;

export type WorkspaceTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'host_path'; readonly path: string };

export interface WorkspaceProjection {
  readonly target: WorkspaceTarget;
  readonly hostCwd: string;
}

export function decodeHostPath(
  value: unknown,
  label: string,
  maxBytes = WORKSPACE_HOST_PATH_MAX_BYTES,
): string {
  const path = requireUtf8String(value, label, maxBytes);
  if (!isLexicallyAbsoluteHostPath(path)) {
    throw invalidProtocolFrame(`${label} must be absolute`);
  }
  return path;
}

export function decodeWorkspaceTarget(value: unknown): WorkspaceTarget {
  const target = requireRecord(value, 'Workspace target');
  if (target.kind === 'project') {
    const exact = requireExactRecord(target, 'Project workspace target', ['kind', 'projectId']);
    return {
      kind: 'project',
      projectId: requireEntityId(exact.projectId, 'Workspace project id'),
    };
  }
  if (target.kind === 'host_path') {
    const exact = requireExactRecord(target, 'Host path workspace target', ['kind', 'path']);
    return {
      kind: 'host_path',
      path: decodeHostPath(exact.path, 'Workspace Host path'),
    };
  }
  throw invalidProtocolFrame('Invalid Workspace target kind');
}

function isLexicallyAbsoluteHostPath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)
  );
}

export function decodeWorkspaceProjection(value: unknown): WorkspaceProjection {
  const projection = requireExactRecord(value, 'Workspace projection', ['target', 'hostCwd']);
  const target = decodeWorkspaceTarget(projection.target);
  const hostCwd = decodeHostPath(projection.hostCwd, 'Workspace Host cwd');
  if (target.kind === 'host_path' && target.path !== hostCwd) {
    throw invalidProtocolFrame('Workspace Host path does not match its cwd');
  }
  return { target, hostCwd };
}
