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

import { createServer, type Server } from 'node:net';
import { prepareRuntimeHostEndpoint, type RuntimeHostEndpoint } from '../control/endpoint.js';
import { FramedTransport } from '../transport/framed-transport.js';
import { LOCAL_OWNER_CONNECTION_AUTHORITY } from './connection-authority.js';
import type { RuntimeHostListener, RuntimeHostListenerConnection } from './listener-set.js';

export interface StartLocalIpcRuntimeHostListenerOptions {
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
}

export async function startLocalIpcRuntimeHostListener(
  options: StartLocalIpcRuntimeHostListenerOptions,
): Promise<RuntimeHostListener & { readonly kind: 'local_ipc' }> {
  const endpoint = await prepareRuntimeHostEndpoint({
    rootId: options.rootId,
    hostEpoch: options.hostEpoch,
  });
  const startupTransports = new Set<FramedTransport>();
  let starting = true;
  const acceptTransport = (transport: FramedTransport) => {
    try {
      options.accept({ transport, authority: LOCAL_OWNER_CONNECTION_AUTHORITY });
    } catch (error) {
      transport.abort(asError(error));
    }
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const transport = new FramedTransport(socket);
    if (starting) {
      startupTransports.add(transport);
      void transport.closed.then(() => startupTransports.delete(transport));
      return;
    }
    acceptTransport(transport);
  });
  try {
    await listen(server, endpoint.path);
    await endpoint.prepareAfterListen();
    starting = false;
    // A connection opened before the endpoint trust boundary was verified
    // must not inherit Local Owner authority after verification completes.
    for (const transport of startupTransports) transport.abort();
    startupTransports.clear();
    return new LocalIpcRuntimeHostListener(server, endpoint);
  } catch (error) {
    for (const transport of startupTransports) transport.abort();
    await closeServer(server).catch(() => undefined);
    await endpoint.cleanup().catch(() => undefined);
    throw error;
  }
}

class LocalIpcRuntimeHostListener implements RuntimeHostListener {
  readonly kind = 'local_ipc' as const;
  readonly endpoint: string;
  readonly #server: Server;
  readonly #runtimeEndpoint: RuntimeHostEndpoint;
  #closeTask: Promise<void> | undefined;

  constructor(server: Server, endpoint: RuntimeHostEndpoint) {
    this.#server = server;
    this.#runtimeEndpoint = endpoint;
    this.endpoint = endpoint.path;
  }

  closeAdmission(): Promise<void> {
    this.#closeTask ??= closeServer(this.#server);
    return this.#closeTask;
  }

  cleanup(): Promise<void> {
    return this.#runtimeEndpoint.cleanup();
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
