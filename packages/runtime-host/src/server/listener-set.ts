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

import { startLocalIpcRuntimeHostListener } from './local-ipc-listener.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import {
  startRuntimeHostPeerListener,
  type RuntimeHostPeerListenerEndpointOptions,
} from './peer-listener.js';
import {
  startRuntimeHostWebSocketListener,
  type StartRuntimeHostWebSocketListenerOptions,
} from './websocket-listener.js';

export interface RuntimeHostListenerConnection {
  readonly transport: RuntimeHostMessageTransport;
  readonly authority: RuntimeHostConnectionAuthority;
}

export interface RuntimeHostListener {
  readonly kind: RuntimeHostListenerKind;
  readonly endpoint: string;
  closeAdmission(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface RuntimeHostPeerListener extends RuntimeHostListener {
  readonly kind: 'libp2p_direct';
  readonly peerId: string;
  readonly listenAddresses: readonly string[];
}

export interface RuntimeHostPeerListenerDescriptor {
  readonly peerId: string;
  readonly listenAddresses: readonly string[];
}

export type RuntimeHostListenerKind = 'local_ipc' | 'websocket' | 'libp2p_direct';

export interface RuntimeHostListenerSet {
  readonly listeners: readonly RuntimeHostListener[];
  readonly localEndpoint: string;
  readonly websocketEndpoints: readonly string[];
  readonly peerListeners: readonly RuntimeHostPeerListenerDescriptor[];
  closeAdmission(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface RuntimeHostListenerSetFactoryInput {
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
  readonly isReady: () => boolean;
}

export type RuntimeHostListenerSetFactory = (
  input: RuntimeHostListenerSetFactoryInput,
) => Promise<RuntimeHostListenerSet>;

export async function startLocalRuntimeHostListenerSet(
  input: RuntimeHostListenerSetFactoryInput,
): Promise<RuntimeHostListenerSet> {
  const local = await startLocalIpcRuntimeHostListener(input);
  return createRuntimeHostListenerSet(local);
}

export async function startRuntimeHostAuthenticatedListenerSet(
  input: RuntimeHostListenerSetFactoryInput,
  options: {
    readonly websocket?: Omit<StartRuntimeHostWebSocketListenerOptions, 'accept' | 'isReady'>;
    readonly peer?: RuntimeHostPeerListenerEndpointOptions & {
      readonly accessAuthority: RuntimeHostAccessAuthority;
    };
  },
): Promise<RuntimeHostListenerSet> {
  const local = await startLocalIpcRuntimeHostListener(input);
  const additional: RuntimeHostListener[] = [];
  try {
    if (options.websocket) {
      additional.push(
        await startRuntimeHostWebSocketListener({
          ...options.websocket,
          accept: input.accept,
          isReady: input.isReady,
        }),
      );
    }
    if (options.peer) {
      additional.push(
        startRuntimeHostPeerListener({
          ...options.peer,
          accept: input.accept,
        }),
      );
    }
    return createRuntimeHostListenerSet(local, additional);
  } catch (error) {
    await settleListeners([...additional].reverse(), (listener) => listener.cleanup()).catch(
      () => undefined,
    );
    await local.closeAdmission().catch(() => undefined);
    await local.cleanup().catch(() => undefined);
    throw error;
  }
}

export function createRuntimeHostListenerSet(
  local: RuntimeHostListener & { readonly kind: 'local_ipc' },
  additional: readonly RuntimeHostListener[] = [],
): RuntimeHostListenerSet {
  const listeners = Object.freeze([local, ...additional]);
  return {
    listeners,
    localEndpoint: local.endpoint,
    websocketEndpoints: Object.freeze(
      additional
        .filter((listener) => listener.kind === 'websocket')
        .map((listener) => listener.endpoint),
    ),
    peerListeners: Object.freeze(
      additional.filter(isRuntimeHostPeerListener).map((listener) =>
        Object.freeze({
          peerId: listener.peerId,
          listenAddresses: Object.freeze([...listener.listenAddresses]),
        }),
      ),
    ),
    closeAdmission: () => settleListeners(listeners, (listener) => listener.closeAdmission()),
    cleanup: () => settleListeners([...listeners].reverse(), (listener) => listener.cleanup()),
  };
}

function isRuntimeHostPeerListener(
  listener: RuntimeHostListener,
): listener is RuntimeHostPeerListener {
  return listener.kind === 'libp2p_direct';
}

async function settleListeners(
  listeners: readonly RuntimeHostListener[],
  operation: (listener: RuntimeHostListener) => Promise<void>,
): Promise<void> {
  const outcomes = await Promise.allSettled(listeners.map(operation));
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Runtime Host listener set operation failed');
  }
}
