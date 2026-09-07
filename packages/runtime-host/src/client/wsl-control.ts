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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { win32 } from 'node:path';
import type { Readable } from 'node:stream';

const WSL_CONTROL_OUTPUT_MAX_BYTES = 64 * 1024;
export const RUNTIME_HOST_WSL_STDERR_MAX_BYTES = 8 * 1024;

export interface RuntimeHostWslOutput {
  readonly bytes: Buffer;
  readonly complete: boolean;
}

export type RuntimeHostWslProcessFactory = (
  executable: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export async function listRuntimeHostWslDistributions(
  overrides: {
    readonly processFactory?: RuntimeHostWslProcessFactory;
    readonly wslExecutable?: string;
  } = {},
): Promise<readonly string[]> {
  const child = (overrides.processFactory ?? spawnRuntimeHostWslProcess)(
    overrides.wslExecutable ?? resolveSystemRuntimeHostWslExecutable(),
    ['--list', '--quiet'],
  );
  child.stdin.end();
  const stdout = collectRuntimeHostWslOutput(child.stdout, WSL_CONTROL_OUTPUT_MAX_BYTES);
  const stderr = collectRuntimeHostWslOutput(child.stderr, RUNTIME_HOST_WSL_STDERR_MAX_BYTES);
  const [exit, capturedStdout, capturedStderr] = await Promise.all([
    waitForRuntimeHostWslProcess(child),
    stdout,
    stderr,
  ]);
  if (exit.code !== 0) {
    throw new Error(
      `wsl.exe could not enumerate distributions${formatRuntimeHostWslStderr(capturedStderr)}`,
    );
  }
  const decoded = new TextDecoder('utf-16le', { fatal: true }).decode(
    requireRuntimeHostWslOutput(capturedStdout),
  );
  return Object.freeze(
    decoded
      .replace(/^\uFEFF/u, '')
      .split(/\r?\n/u)
      .map((line) => line.replace(/\0+$/u, '').trim())
      .filter((line) => line.length > 0)
      .map(normalizeRuntimeHostWslDistribution),
  );
}

export function resolveSystemRuntimeHostWslExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error('WSL environments are available only from Windows');
  }
  return win32.join(systemRoot, 'System32', 'wsl.exe');
}

export function normalizeRuntimeHostWslDistribution(value: string): string {
  const distribution = value.trim();
  if (
    distribution.length === 0 ||
    Buffer.byteLength(distribution, 'utf8') > 256 ||
    /[\u0000-\u001f\u007f]/u.test(distribution)
  ) {
    throw new Error('WSL distribution name is invalid');
  }
  return distribution;
}

export function spawnRuntimeHostWslProcess(executable: string, args: readonly string[]) {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function waitForRuntimeHostWslProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function collectRuntimeHostWslOutput(
  stream: Readable,
  maxBytes: number,
): Promise<RuntimeHostWslOutput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = true;
  try {
    for await (const value of stream) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.byteLength, remaining);
      }
      if (chunk.byteLength > remaining) complete = false;
    }
  } catch {
    complete = false;
  }
  return { bytes: Buffer.concat(chunks), complete };
}

export function requireRuntimeHostWslOutput(output: RuntimeHostWslOutput): Buffer {
  if (!output.complete) {
    throw new Error('wsl.exe output exceeded its byte limit or could not be read');
  }
  return output.bytes;
}

export function formatRuntimeHostWslStderr(stderr: RuntimeHostWslOutput): string {
  const message = stderr.bytes.toString('utf8').trim();
  const details = [
    ...(message ? [message] : []),
    ...(!stderr.complete ? ['<stderr truncated or unavailable>'] : []),
  ].join('\n');
  return details ? `: ${details}` : '';
}
