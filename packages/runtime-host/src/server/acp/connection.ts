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
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { client, ndJsonStream, type ClientConnection } from '@agentclientprotocol/sdk';
import { terminateProcessTree } from '@maka/runtime/process-tree-terminator';
import type { ExternalAgentSetupFailure } from '../../protocol/external-agent-setup.js';

/** Only public failure codes leave this boundary; raw agent output may contain credentials. */
export class AcpSetupError extends Error {
  constructor(readonly failure: ExternalAgentSetupFailure) {
    super(`ACP setup: ${failure}`);
  }
}

export async function withAcpConnection<T>(
  input: {
    executable: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    onStderr(chunk: Buffer): void;
  },
  operation: (connection: ClientConnection) => Promise<T>,
): Promise<T> {
  input.signal.throwIfAborted();
  const child = spawn(input.executable, [], {
    cwd: input.cwd,
    env: input.env,
    stdio: 'pipe',
    detached: true,
    shell: false,
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const abort = () => rejectFailure(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => rejectFailure(new AcpSetupError('executable_unavailable')));
  child.stdin.on('error', () => rejectFailure(new AcpSetupError('connection_failed')));
  child.stderr.on('data', (chunk: Buffer) => {
    try {
      input.onStderr(chunk);
    } catch (error) {
      rejectFailure(error);
    }
  });
  const connection = client({ name: 'maka-desktop' }).connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  // Attach before requesting so immediate EOF, malformed output and cancellation all settle.
  void connection.closed.then(
    () => rejectFailure(new AcpSetupError('connection_failed')),
    rejectFailure,
  );
  try {
    if (input.signal.aborted) abort();
    return await Promise.race([operation(connection), failed]);
  } finally {
    input.signal.removeEventListener('abort', abort);
    // Signal while ancestry is still visible. The existing terminator handles escaped children.
    const pid = child.pid;
    try {
      if (pid) {
        await terminateProcessTree({
          pid,
          signal: 'SIGTERM',
          fallback: () => child.kill('SIGTERM'),
        });
        for (let i = 0; i < 40 && groupAlive(pid); i++) await delay(50);
        if (groupAlive(pid)) {
          await terminateProcessTree({
            pid,
            signal: 'SIGKILL',
            fallback: () => child.kill('SIGKILL'),
          });
          for (let i = 0; i < 40 && groupAlive(pid); i++) await delay(50);
        }
      }
      connection.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await Promise.race([closed, delay(2_000)]);
      if (!exited || (pid && groupAlive(pid))) throw new AcpSetupError('cleanup_failed');
    } finally {
      connection.close();
    }
  }
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
