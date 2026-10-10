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

import type { ProxySettings } from '@maka/core/settings/network-settings';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ConnectionEffectFetch } from '../connection-effect-fetch.js';
import { matchesBypassList } from './bypass-matcher.js';
import { buildProxyDispatcher } from './proxy-dispatcher.js';
import { buildAbortableConnector } from './abortable-connector.js';
import { preparePublicNetworkTarget } from './public-network-policy.js';
export { PublicNetworkPolicyError } from './public-network-policy.js';

export const FETCH_PROXY_SNAPSHOT = Symbol.for('maka.fetch.proxy-snapshot');

export interface ConnectionEffectProxySnapshot {
  readonly enabled: boolean;
  readonly type: ProxySettings['type'];
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly bypassList: readonly string[];
}

export interface ConnectionEffectFetchTransport {
  readonly fetch: ConnectionEffectFetch;
  close(): Promise<void>;
}

export type ProxiedFetchProxy = ConnectionEffectProxySnapshot;

export interface ScopedFetchInit extends RequestInit {
  /** Opt-in public destination policy. Direct DNS is checked and pinned;
   * configured proxies own final resolution/egress. Redirects must be manual
   * (each next URL is a new checked request) or error. Defaults stay unchanged. */
  readonly targetPolicy?: 'public';
}

export type ScopedFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: ScopedFetchInit,
) => Promise<Response>;

export interface ProxiedFetchTransport {
  readonly fetch: ScopedFetch;
  close(): Promise<void>;
}

export function inheritFetchProxySnapshot(
  fetch: typeof globalThis.fetch,
  source: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const descriptor = Object.getOwnPropertyDescriptor(source, FETCH_PROXY_SNAPSHOT);
  if (descriptor) Object.defineProperty(fetch, FETCH_PROXY_SNAPSHOT, descriptor);
  return fetch;
}

export function createConnectionEffectFetchTransport(
  proxy: ConnectionEffectProxySnapshot | null,
): ConnectionEffectFetchTransport {
  return createProxiedFetchTransport(proxy);
}

/** Owns one immutable direct/proxy dispatcher snapshot for a provider client. */
export function createProxiedFetchTransport(
  proxy: ProxiedFetchProxy | null,
): ProxiedFetchTransport {
  const proxySnapshot: ProxySettings | null = proxy?.enabled
    ? { ...proxy, bypassList: [...proxy.bypassList] }
    : null;
  // Dispatchers do not own sockets until their connectors call back. Abort
  // direct and proxy connection establishment too, including TLS handshakes.
  const connections = new AbortController();
  const directDispatcher = new Agent({ connect: buildAbortableConnector(connections.signal) });
  const publicDispatchers = new Set<Agent>();
  let proxyDispatcher: Dispatcher | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const fetch: ScopedFetch = async (input, init) => {
    if (closed) throw new Error('Proxied fetch transport is closed');

    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const useProxy =
      proxySnapshot !== null && !matchesBypassList(new URL(url).hostname, proxySnapshot.bypassList);
    const { targetPolicy, ...requestInit } = init ?? {};
    let publicDispatcher: Agent | undefined;
    if (targetPolicy !== undefined) {
      if (targetPolicy !== 'public') throw new Error('Unknown network target policy');
      const inputRequest = typeof input === 'string' || input instanceof URL ? undefined : input;
      const redirect = requestInit.redirect ?? inputRequest?.redirect ?? 'follow';
      if (redirect !== 'manual' && redirect !== 'error')
        throw new Error('Public network requests require manual redirects or redirect: error');
      const requestSignal =
        requestInit.signal === undefined ? inputRequest?.signal : requestInit.signal;
      const signal = requestSignal
        ? AbortSignal.any([connections.signal, requestSignal])
        : connections.signal;
      const target = await preparePublicNetworkTarget(new URL(url), useProxy, signal);
      signal.throwIfAborted();
      requestInit.signal = signal;
      if (target) {
        // A separate dispatcher prevents reuse of an unchecked connection and
        // binds this request to exactly the DNS answer admitted above.
        publicDispatcher = new Agent({
          connect: buildAbortableConnector(signal, {
            lookup: (_host, options, callback) =>
              options.all
                ? callback(null, [target])
                : callback(null, target.address, target.family),
          }),
        });
        publicDispatchers.add(publicDispatcher);
      }
    }
    if (useProxy)
      proxyDispatcher ??= buildProxyDispatcher(proxySnapshot, connections.signal) as Dispatcher;

    try {
      const response = (await undiciFetch(
        // Keep a mutable URL object bound to the destination checked before DNS awaited.
        (targetPolicy === 'public' && input instanceof URL ? url : input) as Parameters<
          typeof undiciFetch
        >[0],
        {
          ...requestInit,
          dispatcher: publicDispatcher ?? (useProxy ? proxyDispatcher : directDispatcher),
        } as Parameters<typeof undiciFetch>[1],
      )) as unknown as Response;
      if (publicDispatcher) {
        const dispatcher = publicDispatcher;
        // Graceful close waits for the body, without delaying delivery of headers.
        void dispatcher
          .close()
          .catch(() => {})
          .finally(() => publicDispatchers.delete(dispatcher));
      }
      return response;
    } catch (error) {
      if (publicDispatcher) {
        await publicDispatcher.destroy().catch(() => {});
        publicDispatchers.delete(publicDispatcher);
      }
      throw error;
    }
  };
  Object.defineProperty(fetch, FETCH_PROXY_SNAPSHOT, {
    value: proxySnapshot,
    enumerable: false,
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    connections.abort(new Error('Connection effect fetch transport closed'));
    closePromise = Promise.all([
      ...[...publicDispatchers].map((dispatcher) =>
        dispatcher.destroy(new Error('Connection effect fetch transport closed')).catch(() => {}),
      ),
      directDispatcher
        .destroy(new Error('Connection effect fetch transport closed'))
        .catch(() => {}),
      proxyDispatcher
        ?.destroy(new Error('Connection effect fetch transport closed'))
        .catch(() => {}),
    ]).then(() => undefined);
    return closePromise;
  };

  return { fetch, close };
}
