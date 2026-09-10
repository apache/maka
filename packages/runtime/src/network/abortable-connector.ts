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

import { buildConnector } from 'undici';
import type { Duplex } from 'node:stream';
import { Socket } from 'node:net';

/** Unlike Node's socket signal option, release the listener on socket close. */
export function abortSocket(signal: AbortSignal, socket: Duplex): () => void {
  const abort = () =>
    socket.destroy(
      Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      }),
    );
  const dispose = () => {
    signal.removeEventListener('abort', abort);
    socket.off('close', dispose);
  };
  socket.once('close', dispose);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return dispose;
}

/** Keep Undici's timeout and TLS session cache; own only the pending socket. */
export function buildAbortableConnector(
  signal: AbortSignal,
  options: buildConnector.BuildOptions = {},
): buildConnector.connector {
  return withSocketCancellation(buildConnector(options), signal);
}

export function withSocketCancellation(
  connect: buildConnector.connector,
  signal: AbortSignal,
): buildConnector.connector {
  return (options, callback) => {
    let dispose = () => {};
    // Undici returns the socket immediately, although its TS signature is void.
    // Regression coverage exercises this boundary with real TCP/TLS sockets.
    const socket = connect(options, (...args) => {
      dispose();
      callback(...args);
    }) as unknown;
    // ProxyAgent's outer CONNECT connector is async; its upgraded tunnel is
    // owned separately by the proxy pool's upgrade handler.
    if (socket instanceof Socket) dispose = abortSocket(signal, socket);
  };
}
