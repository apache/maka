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
// OS-effect half of the dev-profile holder lookup (#3539): reads Chromium's
// SingletonLock symlink and probes PID liveness, then classifies the record
// with the pure resolver in @maka/core. Desktop owns these effects — core
// stays pure contracts.

import {
  describeDevProfileOwner,
  type DevProfileOwner,
  resolveLiveDevProfileOwnerFromTarget,
} from '@maka/core/dev-single-instance-owner';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import process from 'node:process';

function liveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still a holder.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Resolve the live holder of a dev profile from its SingletonLock record, or
 * undefined when nothing trustworthy resolves (no readable symlink, malformed
 * or stale record) so callers keep the generic conflict wording.
 */
export function resolveLiveDevProfileOwner(userDataDir: string): DevProfileOwner | undefined {
  let target: string;
  try {
    target = readlinkSync(`${userDataDir}/SingletonLock`, 'utf8');
  } catch {
    return undefined;
  }
  return resolveLiveDevProfileOwnerFromTarget(target, {
    liveness,
    localHostname: hostname(),
  });
}

export { describeDevProfileOwner };
