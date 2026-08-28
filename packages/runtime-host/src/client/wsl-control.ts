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

const WSL_CONTROL_OUTPUT_MAX_BYTES = 64 * 1024;
export const RUNTIME_HOST_WSL_STDERR_MAX_BYTES = 8 * 1024;

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
  const exit = await waitForRuntimeHostWslProcess(child);
  if (exit.code !== 0) {
    throw new Error(
      `wsl.exe could not enumerate distributions${formatRuntimeHostWslStderr(await stderr)}`,
    );
  }
  const decoded = new TextDecoder('utf-16le', { fatal: true }).decode(await stdout);
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

export function normalizeRuntimeHostWslOperatorPath(value: string): string {
  if (
    !value.startsWith('/') ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error('WSL operator path must be an absolute Linux path');
  }
  return value;
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

export function collectRuntimeHostWslOutput(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new Error('wsl.exe output exceeded its byte limit'));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

export function formatRuntimeHostWslStderr(stderr: Buffer): string {
  const message = stderr.toString('utf8').trim();
  return message ? `: ${message}` : '';
}
