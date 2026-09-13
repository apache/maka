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

import { fetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { matchesBypassList } from '../network/bypass-matcher.js';
import { buildProxyDispatcher } from '../network/proxy-dispatcher.js';
import { resolveActiveProxy } from '../network/active-proxy-state.js';
import { FETCH_PROXY_SNAPSHOT } from '../network/scoped-fetch-transport.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ProxiedFetchInit = Omit<
  NonNullable<Parameters<typeof globalThis.fetch>[1]>,
  'signal'
> & {
  signal?: AbortSignal | null;
  timeoutMs?: number;
};

export async function proxiedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init: ProxiedFetchInit = {},
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const proxy = resolveActiveProxy();
  let dispatcher: Dispatcher | undefined;
  if (proxy && !matchesBypassList(new URL(url).hostname, proxy.bypassList)) {
    dispatcher = buildProxyDispatcher(proxy) as Dispatcher;
  }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...fetchInit } = init;
  const timeoutEnabled = timeoutMs > 0;
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timedOut = false;

  const disposeDispatcher = async (force = false) => {
    const disposable = dispatcher as
      | {
          close?: () => Promise<void>;
          destroy?: (error?: Error) => void | Promise<void>;
        }
      | undefined;
    if (!disposable) return;
    if (force && typeof disposable.destroy === 'function') {
      await Promise.resolve(disposable.destroy.call(dispatcher, new Error('Fetch timeout'))).catch(
        () => {},
      );
      return;
    }
    if (typeof disposable.close === 'function')
      await disposable.close.call(dispatcher).catch(() => {});
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutEnabled
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('Fetch timeout'));
          void disposeDispatcher(true);
          reject(new Error('Fetch timeout'));
        }, timeoutMs);
      })
    : undefined;

  const request = fetch(
    input as Parameters<typeof fetch>[0],
    { ...fetchInit, dispatcher, signal: requestSignal } as UndiciRequestInit,
  ).catch((error) => {
    if (timedOut) return new Promise<never>(() => {});
    throw error;
  });

  let response: Response;
  try {
    response = timeout
      ? ((await Promise.race([request, timeout])) as unknown as Response)
      : ((await request) as unknown as Response);
  } catch (error) {
    if (timer) clearTimeout(timer);
    await disposeDispatcher(timedOut);
    throw error;
  }

  // Headers are in: return the original Fetch Response now. close() is
  // graceful and stays pending until the active body reaches EOF, errors, or
  // is cancelled, so it already owns the exact lifecycle this request needs;
  // awaiting it here was the streaming bug. AbortSignal.any keeps caller
  // cancellation wired to the original body without adding a listener that
  // this function must later detach.
  if (timer) clearTimeout(timer);
  void disposeDispatcher(false);
  return response;
}

Object.defineProperty(proxiedFetch, FETCH_PROXY_SNAPSHOT, {
  get: resolveActiveProxy,
  enumerable: false,
});
