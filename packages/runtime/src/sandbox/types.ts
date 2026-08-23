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

import type { PermissionProfile } from '@maka/core/permission-profile';
import type { ChildFdInput } from '../child-fd-input.js';

export type SandboxType = 'none' | 'macos-seatbelt' | 'linux' | 'windows';

export type SandboxablePreference = 'auto' | 'require' | 'forbid';

export type SandboxPlatform = NodeJS.Platform | (string & {});

export type SandboxSelectionReason = 'platform_sandbox_selected' | 'sandbox_not_required';

export type SandboxTransformFailureReason =
  | 'unsupported_platform'
  | 'backend_not_available'
  | 'backend_not_implemented'
  | 'sandbox_required'
  | 'invalid_request';

export interface SandboxPathContext {
  workspaceRoots: readonly string[];
  tmpdir?: string;
  slashTmp?: string;
  minimalRoots?: readonly string[];
  /** Runtime files needed only to launch a sandboxed helper process. */
  runtimeReadableRoots?: readonly string[];
  /** Runtime binaries/frameworks that the helper process may map and execute. */
  executableRoots?: readonly string[];
  /** Host directories a trusted helper needs writable to materialize an exact result. */
  runtimeWritableRoots?: readonly string[];
  /** Runtime-writable roots pinned by open host descriptors until sandbox launch. */
  pinnedRuntimeWritableRoots?: readonly {
    path: string;
    fd: number;
    sourceFd: number;
    releaseSource?: () => void;
  }[];
  /** Profile roots observed as unavailable while preparing this invocation. */
  unavailableProfilePaths?: readonly string[];
  /** Profile roots pinned by open host descriptors until sandbox launch. */
  pinnedProfilePaths?: readonly {
    path: string;
    access: 'read' | 'write';
    fd: number;
    sourceFd: number;
    releaseSource?: () => void;
  }[];
}

export interface SandboxCommand {
  program: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  profile: PermissionProfile;
  pathContext: SandboxPathContext;
}

export interface SandboxExecRequest {
  argv: readonly string[];
  fdInputs?: readonly ChildFdInput[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  sandboxType: SandboxType;
  effectiveProfile: PermissionProfile;
}

export interface SandboxSelectionInput {
  profile: PermissionProfile;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
}

export type SandboxSelectionResult =
  | {
      ok: true;
      sandboxType: SandboxType;
      requiresSandbox: boolean;
      reason: SandboxSelectionReason;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
    }
  | {
      ok: false;
      reason: SandboxTransformFailureReason;
      sandboxType?: SandboxType;
      requiresSandbox: boolean;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
      message?: string;
    };

export interface SandboxTransformRequest {
  command: SandboxCommand;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
}

export type SandboxTransformResult =
  | {
      ok: true;
      exec: SandboxExecRequest;
      sandboxType: SandboxType;
      requiresSandbox: boolean;
      preference: SandboxablePreference;
    }
  | {
      ok: false;
      reason: SandboxTransformFailureReason;
      sandboxType?: SandboxType;
      requiresSandbox: boolean;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
      message?: string;
    };

export interface SandboxBackend {
  readonly type: Exclude<SandboxType, 'none'>;
  isAvailable?(platform?: SandboxPlatform): boolean;
  canEnforceProfile?(profile: PermissionProfile): boolean;
  transform(request: SandboxTransformRequest): SandboxTransformResult;
}
