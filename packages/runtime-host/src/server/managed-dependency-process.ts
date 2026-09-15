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
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';

export type ProducerProcessResult =
  | { readonly settled: true; readonly exitCode: number | null; readonly failed: boolean }
  | { readonly settled: false };

export interface ProducerProcessInput {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly projectRoot: string;
  readonly readRoots: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly supervisorPath: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onOutput: (chunk: Buffer) => void;
}

/** Internal launch boundary. No runtime/policy capability is minted here. */
export async function runProducerProcess(
  input: ProducerProcessInput,
): Promise<ProducerProcessResult> {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error('Managed dependency producers support Windows and Linux only');
  }
  if (
    ![input.executable, input.supervisorPath, input.projectRoot, ...input.readRoots].every(
      isAbsolute,
    )
  ) {
    throw new Error('Producer paths must be absolute');
  }
  if (input.signal.aborted) return { settled: true, exitCode: null, failed: true };
  const controlRoot = await mkdtemp(join(tmpdir(), 'maka-producer-control-'));
  let confirmed = false;
  try {
    const reportPath = join(controlRoot, 'result.json');
    let args: string[];
    if (process.platform === 'win32') {
      const manifestPath = join(controlRoot, 'launch.json');
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          requestId: randomUUID(),
          executable: input.executable,
          arguments: input.arguments,
          cwd: input.projectRoot,
          readRoots: [...new Set([dirname(input.executable), ...input.readRoots])],
          writeRoots: [input.projectRoot],
          exactWriteRoots: [],
          network: 'restricted',
          environment: input.environment,
          timeoutMs: Math.max(1000, Math.min(600_000, input.timeoutMs)),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      args = ['--producer-supervise', manifestPath, reportPath];
    } else {
      // This slice provides process containment and offline execution, not the
      // complete future hermetic filesystem capability. Host files are read-only.
      args = [
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        '--as-pid-1',
        '--cap-drop',
        'ALL',
        '--ro-bind',
        '/',
        '/',
        '--bind',
        input.projectRoot,
        input.projectRoot,
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--chdir',
        input.projectRoot,
        '--json-status-fd',
        '3',
        '--',
        input.executable,
        fileURLToPath(new URL('./managed-dependency-linux-init.js', import.meta.url)),
        input.executable,
        ...input.arguments,
      ];
    }
    const environment: Record<string, string> =
      process.platform === 'win32' ? {} : { ...input.environment };
    if (process.platform === 'win32') {
      // AppContainer process creation needs these machine/user substrate paths.
      // Do not give the helper the rest of the Host's ambient environment.
      for (const key of ['SystemRoot', 'SystemDrive', 'LOCALAPPDATA']) {
        if (process.env[key]) environment[key] ??= process.env[key]!;
      }
      // The existing launcher owns recovery ledgers under its temp directory.
      // Never put those ledgers in the child's writable npm scratch domain.
      environment.TEMP = tmpdir();
      environment.TMP = tmpdir();
    }
    if (input.signal.aborted) {
      confirmed = true;
      return { settled: true, exitCode: null, failed: true };
    }
    const child = spawn(input.supervisorPath, args, {
      cwd: input.projectRoot,
      env: environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(process.platform === 'linux' ? ['pipe' as const] : [])],
    });
    child.stdout?.on('data', input.onOutput);
    child.stderr?.on('data', input.onOutput);
    child.stdin?.on('error', () => {});
    let status = Buffer.alloc(0);
    let statusOverflow = false;
    const statusStream = child.stdio[3] as Readable | undefined;
    statusStream?.on('data', (chunk: Buffer) => {
      if (status.length + chunk.length > 1024) statusOverflow = true;
      else status = Buffer.concat([status, chunk]);
    });
    const result = await new Promise<ProducerProcessResult>((resolve) => {
      let done = false;
      let spawned = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const executionDeadline = setTimeout(() => cancel(), input.timeoutMs);
      const finish = (value: ProducerProcessResult) => {
        if (done) return;
        done = true;
        if (deadline) clearTimeout(deadline);
        clearTimeout(executionDeadline);
        input.signal.removeEventListener('abort', cancel);
        child.stdin?.destroy();
        resolve(value);
      };
      const cancel = () => {
        child.stdin?.end('cancel\n');
        deadline ??= setTimeout(() => {
          // Best-effort final backstop is deliberately NOT settlement evidence.
          child.kill();
          child.stdout?.destroy();
          child.stderr?.destroy();
          statusStream?.destroy();
          finish({ settled: false });
        }, 20_000);
      };
      input.signal.addEventListener('abort', cancel, { once: true });
      if (input.signal.aborted) cancel();
      child.once('spawn', () => {
        spawned = true;
      });
      child.once('error', () =>
        finish(spawned ? { settled: false } : { settled: true, exitCode: null, failed: true }),
      );
      child.once('close', (code, signal) => {
        void (async () => {
          if (signal || statusOverflow) return finish({ settled: false });
          try {
            if (process.platform === 'linux') {
              // bubblewrap, not the payload, owns this descriptor. The final
              // status is emitted only after PID 1 / namespace teardown.
              const documents = status.toString('utf8').match(/\{[^{}]*\}/gu) ?? [];
              const last = JSON.parse(documents.at(-1) ?? '{}') as Record<string, unknown>;
              const exitCode = last['exit-code'];
              if (
                !Number.isSafeInteger(exitCode) ||
                exitCode !== code ||
                code === null ||
                code < 0 ||
                code > 255
              ) {
                return finish({ settled: false });
              }
              return finish({ settled: true, exitCode: code, failed: code !== 0 });
            }
            if (code !== 0) return finish({ settled: false });
            const report = await open(reportPath, 'r');
            const buffer = Buffer.alloc(1025);
            let length: number;
            try {
              length = (await report.read(buffer, 0, buffer.length, 0)).bytesRead;
            } finally {
              await report.close();
            }
            if (length > 1024) return finish({ settled: false });
            const bytes = buffer.subarray(0, length);
            finish(decodeProducerProcessResult(JSON.parse(bytes.toString('utf8'))));
          } catch {
            finish({ settled: false });
          }
        })();
      });
    });
    confirmed = result.settled;
    return result;
  } finally {
    if (confirmed) await rm(controlRoot, { recursive: true, force: true });
  }
}

export function decodeProducerProcessResult(value: unknown): ProducerProcessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { settled: false };
  const result = value as Record<string, unknown>;
  if (
    result.settled !== true ||
    typeof result.failed !== 'boolean' ||
    !(
      result.exitCode === null ||
      (Number.isSafeInteger(result.exitCode) &&
        (result.exitCode as number) >= 0 &&
        (result.exitCode as number) <= 0xffff_ffff)
    ) ||
    (!result.failed && result.exitCode !== 0) ||
    Object.keys(result).sort().join(',') !== 'exitCode,failed,settled'
  )
    return { settled: false };
  return { settled: true, failed: result.failed, exitCode: result.exitCode as number | null };
}
