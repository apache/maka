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
import { client, ndJsonStream, type ClientConnection } from '@agentclientprotocol/sdk';
import {
  RetainedProcessTreeDescendants,
  terminateProcessTree,
} from '@maka/runtime/process-tree-terminator';
import { readRuntimeHostProcessIdentity } from '../../client/process-identity.js';
import type { ExternalAgentSetupFailure } from '../../protocol/external-agent-setup.js';

/** Only public failure codes leave this boundary; raw agent output may contain credentials. */
export class AcpSetupError extends Error {
  constructor(readonly failure: ExternalAgentSetupFailure) {
    super(`ACP setup: ${failure}`);
  }
}

export class AcpConnectionError extends Error {
  constructor(readonly code: 'executable_unavailable' | 'connection_failed' | 'cleanup_failed') {
    super(`ACP connection: ${code}`);
  }
}

export interface AcpConnectionOwner {
  readonly connection: ClientConnection;
  /** Unexpected transport/process failure. Observed internally even while the owner is idle. */
  readonly failed: Promise<never>;
  /** Direct-child/stdio closure; does not prove cleanup of helpers or unobserved daemons. */
  readonly closed: Promise<void>;
  /** Concurrent calls share cleanup. Failed cleanup retains ownership and can be retried. */
  dispose(): Promise<void>;
}

/** The setup coordinator must retain this owner until retrying cleanup succeeds. */
export class AcpSetupCleanupError extends AcpSetupError {
  constructor(readonly owner: AcpConnectionOwner) {
    super('cleanup_failed');
  }
}

interface AcpConnectionInput {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr(chunk: Buffer): void;
  /** Narrow OS identity seam; the Host's native process-lifetime query is used by default. */
  readProcessIdentity?(pid: number): Promise<string | undefined>;
}

/** Owns a connection independently of individual operations and their cancellation signals. */
export function createAcpConnection(input: AcpConnectionInput): AcpConnectionOwner {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.executable, [], {
      cwd: input.cwd,
      env: input.env,
      stdio: 'pipe',
      detached: true,
      shell: false,
    });
  } catch {
    throw new AcpConnectionError('executable_unavailable');
  }
  const { stdin, stdout, stderr } = child;
  const descendants = new RetainedProcessTreeDescendants(
    input.readProcessIdentity ??
      (async (pid) => (await readRuntimeHostProcessIdentity(pid))?.startIdentity),
  );
  let rootGroupReleased = false;
  let exited = false;
  let disposing = false;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  let rejectFailure!: (error: AcpConnectionError) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // An idle owner may have no request awaiting failure yet.
  void failed.catch(() => {});
  const fail = (code: 'executable_unavailable' | 'connection_failed') => {
    if (!disposing) rejectFailure(new AcpConnectionError(code));
  };
  child.on('error', () => fail('executable_unavailable'));
  stdin.on('error', () => fail('connection_failed'));
  stderr.on('data', (chunk: Buffer) => {
    if (disposing) return;
    try {
      input.onStderr(chunk);
    } catch {
      fail('connection_failed');
    }
  });
  const connection = client({ name: 'maka-desktop' }).connect(
    ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    ),
  );
  // Attach before requesting so immediate EOF and transport failures cannot pass as success.
  void connection.closed.then(
    () => fail('connection_failed'),
    () => fail('connection_failed'),
  );

  const hasLiveProcesses = async (pid: number) => {
    if (process.platform === 'win32') return !exited;
    if (!rootGroupReleased && !groupAlive(pid)) rootGroupReleased = true;
    return !rootGroupReleased || (await descendants.hasLiveProcesses());
  };
  const release = async () => {
    // Signal while ancestry is still visible. Escaped descendants retain OS identities.
    const pid = child.pid;
    try {
      if (pid) {
        if (process.platform !== 'win32' && !groupAlive(pid)) rootGroupReleased = true;
        await terminateProcessTree({
          pid,
          descendants,
          onlyRetainedDescendants: rootGroupReleased,
          signal: 'SIGTERM',
          fallback: () => child.kill('SIGTERM'),
        });
        for (let i = 0; i < 40 && (await hasLiveProcesses(pid)); i++) await delay(50);
        if (await hasLiveProcesses(pid)) {
          await terminateProcessTree({
            pid,
            descendants,
            onlyRetainedDescendants: rootGroupReleased,
            signal: 'SIGKILL',
            fallback: () => child.kill('SIGKILL'),
          });
          for (let i = 0; i < 40 && (await hasLiveProcesses(pid)); i++) await delay(50);
        }
      }
    } finally {
      connection.close();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
    await Promise.race([closed, delay(2_000)]);
    if (!exited || (pid && (await hasLiveProcesses(pid)))) {
      throw new AcpConnectionError('cleanup_failed');
    }
  };

  return {
    connection,
    failed,
    closed,
    dispose() {
      if (disposed) return Promise.resolve();
      if (disposal) return disposal;
      disposing = true;
      const attempt = release().then(
        () => {
          disposed = true;
        },
        () => {
          const error = new AcpConnectionError('cleanup_failed');
          rejectFailure(error);
          throw error;
        },
      );
      disposal = attempt;
      void attempt.catch(() => {
        if (disposal === attempt) disposal = undefined;
      });
      return attempt;
    },
  };
}

export async function withAcpConnection<T>(
  input: AcpConnectionInput & { signal: AbortSignal },
  operation: (connection: ClientConnection) => Promise<T>,
): Promise<T> {
  input.signal.throwIfAborted();
  let rejectOperation!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  void interrupted.catch(() => {});
  let owner: AcpConnectionOwner;
  try {
    owner = createAcpConnection({
      ...input,
      onStderr(chunk) {
        try {
          input.onStderr(chunk);
        } catch (error) {
          // Setup callback errors retain their existing caller-facing classification.
          rejectOperation(error);
        }
      },
    });
  } catch (error) {
    if (error instanceof AcpConnectionError) throw new AcpSetupError(error.code);
    throw error;
  }
  const abort = () => rejectOperation(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    input.signal.throwIfAborted();
    return await Promise.race([operation(owner.connection), owner.failed, interrupted]);
  } catch (error) {
    if (error instanceof AcpConnectionError) throw new AcpSetupError(error.code);
    throw error;
  } finally {
    input.signal.removeEventListener('abort', abort);
    try {
      await owner.dispose();
    } catch {
      throw new AcpSetupCleanupError(owner);
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
