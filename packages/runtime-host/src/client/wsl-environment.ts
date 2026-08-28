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

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  requireHostRootId,
} from '../protocol/index.js';
import {
  FramedByteStreamTransport,
  type RuntimeHostByteStream,
} from '../transport/framed-byte-stream-transport.js';
import {
  connectRuntimeHostMessageTransport,
  type ConnectRemoteRuntimeHostResult,
  type RuntimeHostConnection,
  type RuntimeHostConnectionResource,
} from './connection.js';
import { RuntimeHostRemoteCompatibilityError } from './remote-compatibility-error.js';
import { waitForRuntimeHostReady } from './wait-for-ready.js';
import {
  collectRuntimeHostWslOutput,
  formatRuntimeHostWslStderr,
  listRuntimeHostWslDistributions,
  normalizeRuntimeHostWslDistribution,
  normalizeRuntimeHostWslOperatorPath,
  resolveSystemRuntimeHostWslExecutable,
  RUNTIME_HOST_WSL_STDERR_MAX_BYTES,
  spawnRuntimeHostWslProcess,
  waitForRuntimeHostWslProcess,
  type RuntimeHostWslOutput,
  type RuntimeHostWslProcessFactory,
} from './wsl-control.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

const DEFAULT_RUNTIME_HOST_WSL_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_RUNTIME_HOST_WSL_READY_TIMEOUT_MS = 45_000;

export {
  listRuntimeHostWslDistributions,
  normalizeRuntimeHostWslDistribution,
  normalizeRuntimeHostWslOperatorPath,
  resolveSystemRuntimeHostWslExecutable,
  type RuntimeHostWslProcessFactory,
} from './wsl-control.js';

export interface RuntimeHostWslEnvironmentInput {
  readonly distribution: string;
  readonly operatorPath: string;
  readonly rootId: string;
  readonly clientInstanceId: string;
  readonly signal?: AbortSignal;
  readonly handshakeTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}

export async function connectRuntimeHostWslEnvironment(
  input: RuntimeHostWslEnvironmentInput,
  overrides: {
    readonly processFactory?: RuntimeHostWslProcessFactory;
    readonly wslExecutable?: string;
    readonly waitForReady?: typeof waitForRuntimeHostReady;
  } = {},
): Promise<RuntimeHostConnection> {
  input.signal?.throwIfAborted();
  const distribution = normalizeRuntimeHostWslDistribution(input.distribution);
  const operatorPath = normalizeRuntimeHostWslOperatorPath(input.operatorPath);
  const rootId = requireHostRootId(input.rootId);
  const processFactory = overrides.processFactory ?? spawnRuntimeHostWslProcess;
  const child = processFactory(overrides.wslExecutable ?? resolveSystemRuntimeHostWslExecutable(), [
    '--distribution',
    distribution,
    '--exec',
    operatorPath,
    'connect',
    '--framed',
    '--root-id',
    rootId,
    '--repair-root-after-remount',
  ]);
  const resource = new WslProcessByteStream(child);
  const transport = new FramedByteStreamTransport(resource);
  const abort = () => transport.abort(abortReason(input.signal));
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    const connected = await connectRuntimeHostMessageTransport({
      transport,
      connectionResource: resource,
      expectedRootId: rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      clientInstanceId: input.clientInstanceId,
      handshakeTimeoutMs: input.handshakeTimeoutMs ?? DEFAULT_RUNTIME_HOST_WSL_STARTUP_TIMEOUT_MS,
    });
    if (connected.kind === 'incompatible') {
      throw new RuntimeHostRemoteCompatibilityError(distribution, connected.handshake);
    }
    if (connected.kind === 'draining') {
      throw new Error(`Runtime Host in WSL environment ${distribution} is draining`);
    }
    if (connected.kind === 'unavailable') {
      throw wslRuntimeHostUnavailableError(
        `Runtime Host in WSL environment ${distribution}`,
        connected.reason,
      );
    }
    try {
      input.signal?.throwIfAborted();
      await (overrides.waitForReady ?? waitForRuntimeHostReady)(
        connected.connection,
        input.readyTimeoutMs ?? DEFAULT_RUNTIME_HOST_WSL_READY_TIMEOUT_MS,
        input.signal,
      );
      return connected.connection;
    } catch (error) {
      await connected.connection.close().catch(() => undefined);
      throw error;
    }
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

class WslProcessByteStream implements RuntimeHostByteStream, RuntimeHostConnectionResource {
  readonly closed: Promise<void>;
  readonly #stderr: Promise<RuntimeHostWslOutput>;
  #closing = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.#stderr = collectRuntimeHostWslOutput(child.stderr, RUNTIME_HOST_WSL_STDERR_MAX_BYTES);
    this.closed = waitForRuntimeHostWslProcess(child).then(async ({ code, signal }) => {
      if (this.#closing || code === 0) return;
      const suffix = formatRuntimeHostWslStderr(await this.#stderr);
      throw new Error(
        `wsl.exe Runtime Host bridge exited (${code ?? signal ?? 'unknown'})${suffix}`,
      );
    });
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.child.stdout.on('data', (chunk: Buffer) => listener(chunk));
  }

  onEnd(listener: () => void): void {
    this.child.stdout.once('end', listener);
  }

  onError(listener: (error: Error) => void): void {
    this.child.once('error', listener);
  }

  write(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }

  closeAfterFlush(): void {
    this.child.stdin.end();
  }

  abort(_error?: Error): void {
    if (this.#closing) return;
    this.#closing = true;
    this.child.stdin.destroy();
    this.child.kill();
  }

  pause(): void {
    this.child.stdout.pause();
  }

  resume(): void {
    this.child.stdout.resume();
  }

  async close(): Promise<void> {
    this.abort();
    await this.closed.catch(() => undefined);
  }
}

function wslRuntimeHostUnavailableError(
  subject: string,
  reason: Extract<ConnectRemoteRuntimeHostResult, { kind: 'unavailable' }>['reason'],
): Error {
  if (reason === 'root_mismatch') {
    return new RuntimeHostPermanentReconnectError(
      `${subject} connected to an unexpected State Root`,
    );
  }
  if (reason === 'composition_mismatch') {
    return new RuntimeHostPermanentReconnectError(
      `${subject} has an incompatible Host composition`,
    );
  }
  return new Error(`${subject} is unavailable (${reason})`);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('WSL Runtime Host connection was aborted');
}
