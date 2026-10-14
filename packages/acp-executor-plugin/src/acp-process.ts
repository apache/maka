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
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
} from '@agentclientprotocol/sdk';
import { terminateProcessTree } from '@maka/runtime/process-tree-terminator';
import { AcpRuntimeError } from './acp-errors.js';

const PROCESS_EXIT_TIMEOUT_MS = 2_000;

export interface AcpConnectionInput {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clientName: string;
  readonly configureClient: (app: ClientApp) => void;
}

export interface AcpConnectionOwner {
  readonly connection: ClientConnection;
  readonly failed: Promise<never>;
  dispose(): Promise<void>;
}

export function createAcpConnection(input: AcpConnectionInput): AcpConnectionOwner {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.executable, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
      detached: true,
      shell: false,
    });
  } catch {
    throw new AcpRuntimeError('ACP executable is unavailable', 'acp_executable_unavailable');
  }
  let disposing = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => undefined);
  const fail = () => {
    if (!disposing) rejectFailure(new Error('ACP connection failed'));
  };
  child.once('error', fail);
  child.stdin.once('error', fail);
  child.stderr.once('error', fail);
  child.stderr.on('data', () => undefined);
  child.once('close', fail);
  const app = client({ name: input.clientName });
  input.configureClient(app);
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  void connection.closed.then(fail, fail);
  return {
    connection,
    failed,
    dispose() {
      if (disposed) return Promise.resolve();
      if (disposal) return disposal;
      disposing = true;
      disposal = terminate(child, connection).then(
        () => {
          disposed = true;
        },
        (error) => {
          disposal = undefined;
          throw error;
        },
      );
      return disposal;
    },
  };
}

async function terminate(
  child: ChildProcessWithoutNullStreams,
  connection: ClientConnection,
): Promise<void> {
  const pid = child.pid;
  const alive = () => {
    if (!pid) return false;
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  try {
    if (pid) {
      await terminateProcessTree({ pid, signal: 'SIGTERM', fallback: () => child.kill('SIGTERM') });
      for (let elapsed = 0; elapsed < PROCESS_EXIT_TIMEOUT_MS && alive(); elapsed += 50)
        await delay(50);
      if (alive()) {
        await terminateProcessTree({
          pid,
          signal: 'SIGKILL',
          fallback: () => child.kill('SIGKILL'),
        });
        for (let elapsed = 0; elapsed < PROCESS_EXIT_TIMEOUT_MS && alive(); elapsed += 50)
          await delay(50);
      }
      if (alive()) throw new Error('ACP process cleanup failed');
    }
  } finally {
    connection.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
