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

import { readFile } from 'node:fs/promises';
import { readRuntimeHostNativeProcessStartIdentity } from '../transport/peer-native.js';

const PROCESS_QUERY_TIMEOUT_MS = 5_000;

export interface RuntimeHostProcessIdentity {
  readonly startIdentity: string;
}

/**
 * Reads an OS-owned identifier for one process lifetime. Absence and every
 * query failure deliberately fail closed.
 */
export async function readRuntimeHostProcessIdentity(
  pid: number,
): Promise<RuntimeHostProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const nativePath = process.env.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH?.trim();
  if (nativePath) {
    try {
      const startIdentity = readRuntimeHostNativeProcessStartIdentity(nativePath, pid);
      if (startIdentity) return { startIdentity };
    } catch {
      // Linux can still use procfs; every other platform fails closed below.
    }
  }
  if (process.platform === 'linux') {
    try {
      const [stat, bootIdText] = await Promise.all([
        readFile(`/proc/${pid}/stat`, {
          encoding: 'utf8',
          signal: AbortSignal.timeout(PROCESS_QUERY_TIMEOUT_MS),
        }),
        readFile('/proc/sys/kernel/random/boot_id', {
          encoding: 'utf8',
          signal: AbortSignal.timeout(PROCESS_QUERY_TIMEOUT_MS),
        }),
      ]);
      const startTicks = linuxProcessStartTicks(stat);
      const bootId = bootIdText.trim();
      if (startTicks && bootId.length > 0 && /^[0-9a-f-]+$/iu.test(bootId)) {
        return { startIdentity: `linux:${bootId}:${startTicks}` };
      }
    } catch {
      // Query failure deliberately leaves destructive recovery unavailable.
    }
  }
  return undefined;
}

export function linuxProcessStartTicks(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const startTicks = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u)[19];
  return startTicks && /^\d+$/u.test(startTicks) ? startTicks : undefined;
}
