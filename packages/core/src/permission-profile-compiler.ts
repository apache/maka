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

import type { PermissionMode } from './permission.js';
import type {
  NetworkSandboxPolicy,
  PermissionProfile,
  PermissionProfileManaged,
  PermissionProfileName,
} from './permission-profile.js';
import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from './permission-profile.js';

export interface CompilePermissionProfileInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
}

export interface CompiledPermissionProfile {
  mode: PermissionMode;
  profileName: PermissionProfileName;
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  network: NetworkSandboxPolicy;
}

export function compilePermissionProfile(
  input: CompilePermissionProfileInput,
): CompiledPermissionProfile {
  const workspaceRoots = input.workspaceRoots ?? [input.cwd];

  switch (input.mode) {
    case 'explore':
      return compileManaged(input.mode, createReadOnlyPermissionProfile(), workspaceRoots);
    case 'ask':
    case 'execute':
      return compileManaged(input.mode, createWorkspaceWritePermissionProfile(), workspaceRoots);
    case 'bypass':
      return compileManaged(input.mode, createDangerFullAccessPermissionProfile(), workspaceRoots);
  }
}

function compileManaged(
  mode: PermissionMode,
  profile: PermissionProfileManaged,
  workspaceRoots: readonly string[],
): CompiledPermissionProfile {
  return {
    mode,
    profileName: standardProfileName(profile.name),
    profile,
    workspaceRoots,
    network: profile.network,
  };
}

function standardProfileName(name: PermissionProfileManaged['name']): PermissionProfileName {
  switch (name) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    case 'danger-full-access':
      return 'danger-full-access';
    case 'custom':
      return 'custom';
    default:
      return 'custom';
  }
}
