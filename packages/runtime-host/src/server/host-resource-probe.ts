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

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminateChildProcessTree } from '@maka/runtime/process-tree-terminator';
import type * as systemInformation from 'systeminformation';

const PROBE_ENTRYPOINT = fileURLToPath(new URL('./host-resource-probe-main.js', import.meta.url));
const PROBE_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export interface HostResourceSystemInformation {
  graphics(): Promise<systemInformation.Systeminformation.GraphicsData>;
  networkStats(): Promise<{
    readonly interfaceName: string;
    readonly stats: systemInformation.Systeminformation.NetworkStatsData[];
  }>;
  fsSize(): Promise<systemInformation.Systeminformation.FsSizeData[]>;
}

export function createIsolatedHostResourceSystemInformation(
  timeoutMilliseconds: number,
): HostResourceSystemInformation {
  return {
    graphics: () => invokeProbe('graphics', timeoutMilliseconds),
    networkStats: () => invokeProbe('network', timeoutMilliseconds),
    fsSize: () => invokeProbe('storage', timeoutMilliseconds),
  };
}

function invokeProbe<T>(
  kind: 'graphics' | 'network' | 'storage',
  timeoutMilliseconds: number,
): Promise<T> {
  const child = spawn(process.execPath, [PROBE_ENTRYPOINT, kind], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(
      () => terminate(new Error('Runtime Host resource probe timed out')),
      timeoutMilliseconds,
    );
    const finish = (outcome: { readonly value: T } | { readonly error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('value' in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    const terminate = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminateChildProcessTree(child, 'SIGKILL').finally(() => reject(error));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > PROBE_OUTPUT_MAX_BYTES) {
        terminate(new Error('Runtime Host resource probe output is too large'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => finish({ error }));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ error: new Error('Runtime Host resource probe failed') });
        return;
      }
      try {
        finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T });
      } catch {
        finish({ error: new Error('Runtime Host resource probe returned invalid output') });
      }
    });
  });
}
