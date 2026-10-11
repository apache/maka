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

import { parseProxyConfig } from './proxy-parser.js';
import { buildProxyDispatcher } from './proxy-dispatcher.js';
import type {
  ProxySettings,
  TestProxyInput,
  TestProxyResult,
} from '@maka/core/settings/network-settings';
import { fetch, type Dispatcher } from 'undici';

const DEFAULT_PROBE_URL = 'https://icanhazip.com';
const DEFAULT_TIMEOUT_MS = 8_000;
// Bounded wait for dispatcher teardown: a graceful close that never settles
// (observed behind real proxies after an abort) must not keep this call —
// and the serialized settings lane it runs on — pending forever.
const DISPATCHER_CLOSE_GRACE_MS = 1_000;

export async function testProxyConnection(
  input: TestProxyInput = {},
  storedProxy?: ProxySettings,
): Promise<TestProxyResult> {
  const proxy = parseProxyConfig(input.proxy ?? storedProxy);
  const probeUrl = input.url ?? DEFAULT_PROBE_URL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!proxy.enabled) return { ok: false, latencyMs: 0, error: 'Proxy disabled' };
  if (!proxy.host || !proxy.port)
    return { ok: false, latencyMs: 0, error: 'Proxy host/port required' };

  const controller = new AbortController();
  const dispatcher = buildProxyDispatcher(proxy, controller.signal);
  let timedOut = false;
  const disposeDispatcher = async (force = false) => {
    const disposable = dispatcher as {
      close?: () => Promise<void>;
      destroy?: (error?: Error) => void | Promise<void>;
    };
    if (force && typeof disposable.destroy === 'function') {
      await Promise.resolve(
        disposable.destroy.call(dispatcher, new Error('Proxy test timeout')),
      ).catch(() => {});
      return;
    }
    if (typeof disposable.close === 'function')
      await disposable.close.call(dispatcher).catch(() => {});
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Proxy test timeout'));
      void disposeDispatcher(true);
      reject(new Error('Proxy test timeout'));
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
  const startedAt = Date.now();

  try {
    const request = fetch(probeUrl, { dispatcher, signal: controller.signal }).catch((error) => {
      if (timedOut) return new Promise<never>(() => {});
      throw error;
    });
    const response = await Promise.race([request, timeout]);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok)
      return { ok: false, status: response.status, latencyMs, error: `HTTP ${response.status}` };

    const ip = (await response.text()).trim() || undefined;
    const countryCode = ip
      ? await lookupCountry(ip, dispatcher as Dispatcher, controller.signal)
      : undefined;
    const countryFlag =
      countryCode && countryCode.length === 2
        ? String.fromCodePoint(
            ...countryCode
              .toUpperCase()
              .split('')
              .map((char) => 127_397 + char.charCodeAt(0)),
          )
        : undefined;

    return { ok: true, status: response.status, latencyMs, ip, countryCode, countryFlag };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Mirror the shared transport teardown ordering: begin dispatcher
    // teardown before aborting, so the graceful close can retire live
    // CONNECT tunnels before the signal kills their sockets; abort still
    // cancels any pending connect or handshake. Keep the wait bounded so a
    // stalled close cannot hold this call past its result.
    const teardown = disposeDispatcher(timedOut);
    controller.abort();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = await Promise.race([
      teardown.then(() => false),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(true), DISPATCHER_CLOSE_GRACE_MS);
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (graceExpired) {
      // The graceful close never settled within the grace, so destroy the
      // dispatcher instead of leaking it. Fire-and-forget with the error
      // swallowed: teardown must never replace the result this call owes.
      const disposable = dispatcher as {
        destroy?: (error?: Error) => void | Promise<void>;
      };
      if (typeof disposable.destroy === 'function') {
        void Promise.resolve(
          disposable.destroy.call(dispatcher, new Error('Dispatcher close grace expired')),
        ).catch(() => {});
      }
    }
  }
}

async function lookupCountry(
  ip: string,
  dispatcher: Dispatcher,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, {
      dispatcher,
      signal,
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { country?: string };
    return json.country;
  } catch {
    return undefined;
  }
}
