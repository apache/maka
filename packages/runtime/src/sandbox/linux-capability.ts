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

import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { SandboxPlatform } from './types.js';

export type LinuxSandboxCapability =
  | { available: true; bwrapPath: string }
  | {
      available: false;
      reason: 'non-linux' | 'missing-bwrap' | 'probe-failed';
      bwrapPath?: string;
      detail?: string;
    };

export interface DetectLinuxSandboxCapabilityInput {
  platform?: SandboxPlatform;
  bwrapPath?: string;
}

export const LINUX_BWRAP_REQUIRED_OPTIONS = ['--seccomp'] as const;

export const LINUX_BWRAP_REQUIRED_NAMESPACE_ARGS = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-cgroup',
] as const;

export const LINUX_BWRAP_PROBE_ARGS = [
  '--die-with-parent',
  '--new-session',
  ...LINUX_BWRAP_REQUIRED_NAMESPACE_ARGS,
  '--unshare-net',
  '--ro-bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--',
  '/bin/true',
] as const;

export function detectLinuxSandboxCapability(
  input: DetectLinuxSandboxCapabilityInput = {},
): LinuxSandboxCapability {
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return { available: false, reason: 'non-linux' };

  const bwrapPath = input.bwrapPath ?? '/usr/bin/bwrap';
  try {
    accessSync(bwrapPath, constants.X_OK);
  } catch {
    return { available: false, reason: 'missing-bwrap', bwrapPath };
  }

  const help = spawnSync(bwrapPath, ['--help'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  if (
    help.status !== 0 ||
    LINUX_BWRAP_REQUIRED_OPTIONS.some((option) => !helpText.includes(option))
  ) {
    return {
      available: false,
      reason: 'probe-failed',
      bwrapPath,
      detail: 'bubblewrap does not advertise required seccomp support',
    };
  }

  const probe = spawnSync(bwrapPath, [...LINUX_BWRAP_PROBE_ARGS], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (probe.status !== 0) {
    const detail =
      probe.error?.message || probe.stderr.trim() || `exit ${probe.status ?? 'unknown'}`;
    return { available: false, reason: 'probe-failed', bwrapPath, detail };
  }
  return { available: true, bwrapPath };
}
