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

import type { RuntimePolicy } from '@maka/core/runtime-policy';
import type { ProxyType, TestProxyResult } from '@maka/core/settings/network-settings';
import {
  requireEncodedByteLimit,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const RESULT_MAX_BYTES = 8 * 1024;
const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export interface NetworkProxyTestInput {
  readonly networkProxy?: RuntimePolicy['networkProxy'];
  readonly url?: string;
  readonly timeoutMs?: number;
}

export type NetworkProxyTestResult = TestProxyResult;

export type NetworkProxyResolveInput = Record<string, never>;

/**
 * The effective proxy a Client must apply to the network it owns, already
 * resolved against Runtime Policy. `bypassList` is the merged configured and
 * automatic list, so the Client never re-derives policy. Carries the secret:
 * only the Host can read it, and a Client that runs its own outbound traffic
 * (bot bridges) cannot dial an authenticated proxy without it.
 */
export interface ResolvedNetworkProxy {
  readonly enabled: true;
  readonly type: ProxyType;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly bypassList: string[];
}

/**
 * `proxy` is absent when the policy disables the proxy — a positive "send
 * everything direct", distinct from `credential_not_configured`, which means
 * the policy wants an authenticated proxy whose secret is missing and so
 * cannot be honoured.
 */
export interface NetworkProxyResolveResult {
  readonly kind: 'ready' | 'credential_not_configured';
  readonly proxy?: ResolvedNetworkProxy;
}

export const NETWORK_PROXY_OPERATION_SPECS = {
  'network-proxy.test': defineOperation<
    NetworkProxyTestInput,
    NetworkProxyTestResult,
    (typeof ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeNetworkProxyTestInput,
    decodeOutput: decodeNetworkProxyTestResult,
  }),
  'network-proxy.resolve': defineOperation<
    NetworkProxyResolveInput,
    NetworkProxyResolveResult,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: (value) => {
      requireExactRecord(value, 'network proxy resolve input', []);
      return {};
    },
    decodeOutput: decodeNetworkProxyResolveResult,
  }),
} as const;

function decodeNetworkProxyTestInput(value: unknown): NetworkProxyTestInput {
  const input = requireShapedRecord(
    value,
    'network proxy test input',
    [],
    ['networkProxy', 'url', 'timeoutMs'],
  );
  return {
    ...(input.networkProxy === undefined
      ? {}
      : { networkProxy: decodeNetworkProxy(input.networkProxy) }),
    ...(input.url === undefined ? {} : { url: decodeProbeUrl(input.url) }),
    ...(input.timeoutMs === undefined
      ? {}
      : { timeoutMs: boundedInteger(input.timeoutMs, 1, 30_000, 'network proxy timeout') }),
  };
}

function decodeNetworkProxy(value: unknown): RuntimePolicy['networkProxy'] {
  const proxy = requireExactRecord(value, 'network proxy configuration', [
    'enabled',
    'protocol',
    'host',
    'port',
    'authEnabled',
    'username',
    'bypassList',
    'autoBypassDomains',
  ]);
  if (
    typeof proxy.enabled !== 'boolean' ||
    (proxy.protocol !== 'http' && proxy.protocol !== 'https' && proxy.protocol !== 'socks5') ||
    typeof proxy.host !== 'string' ||
    proxy.host.length > 255 ||
    typeof proxy.authEnabled !== 'boolean' ||
    typeof proxy.username !== 'string' ||
    proxy.username.length > 256
  ) {
    throw invalidProtocolFrame('Invalid network proxy configuration');
  }
  return {
    enabled: proxy.enabled,
    protocol: proxy.protocol,
    host: proxy.host,
    port: boundedInteger(proxy.port, 1, 65_535, 'network proxy port'),
    authEnabled: proxy.authEnabled,
    username: proxy.username,
    bypassList: stringList(proxy.bypassList, 'network proxy bypass list'),
    autoBypassDomains: stringList(proxy.autoBypassDomains, 'network proxy automatic bypass list'),
  };
}

function decodeNetworkProxyTestResult(value: unknown): NetworkProxyTestResult {
  const result = requireShapedRecord(
    value,
    'network proxy test result',
    ['ok', 'latencyMs'],
    ['status', 'ip', 'countryCode', 'countryFlag', 'error'],
  );
  if (typeof result.ok !== 'boolean') {
    throw invalidProtocolFrame('Invalid network proxy test result');
  }
  const decoded: NetworkProxyTestResult = {
    ok: result.ok,
    latencyMs: boundedInteger(result.latencyMs, 0, 300_000, 'network proxy latency'),
    ...(result.status === undefined
      ? {}
      : { status: boundedInteger(result.status, 100, 599, 'network proxy HTTP status') }),
    ...optionalText(result, 'ip', 256),
    ...optionalText(result, 'countryCode', 16),
    ...optionalText(result, 'countryFlag', 32),
    ...optionalText(result, 'error', 2_048),
  };
  requireEncodedByteLimit(decoded, 'network proxy test result', RESULT_MAX_BYTES);
  return decoded;
}

function decodeNetworkProxyResolveResult(value: unknown): NetworkProxyResolveResult {
  const result = requireShapedRecord(value, 'network proxy resolve result', ['kind'], ['proxy']);
  if (result.kind !== 'ready' && result.kind !== 'credential_not_configured') {
    throw invalidProtocolFrame('Invalid network proxy resolve kind');
  }
  if (result.kind === 'credential_not_configured' && result.proxy !== undefined) {
    throw invalidProtocolFrame('Unresolved network proxy must not carry a configuration');
  }
  const decoded: NetworkProxyResolveResult = {
    kind: result.kind,
    ...(result.proxy === undefined ? {} : { proxy: decodeResolvedNetworkProxy(result.proxy) }),
  };
  requireEncodedByteLimit(decoded, 'network proxy resolve result', RESULT_MAX_BYTES);
  return decoded;
}

function decodeResolvedNetworkProxy(value: unknown): ResolvedNetworkProxy {
  const proxy = requireShapedRecord(
    value,
    'resolved network proxy',
    ['enabled', 'type', 'host', 'port', 'bypassList'],
    ['username', 'password'],
  );
  if (
    proxy.enabled !== true ||
    (proxy.type !== 'http' && proxy.type !== 'https' && proxy.type !== 'socks5') ||
    typeof proxy.host !== 'string' ||
    proxy.host.length === 0 ||
    proxy.host.length > 255
  ) {
    throw invalidProtocolFrame('Invalid resolved network proxy');
  }
  return {
    enabled: true,
    type: proxy.type,
    host: proxy.host,
    port: boundedInteger(proxy.port, 1, 65_535, 'resolved network proxy port'),
    ...(proxy.username === undefined
      ? {}
      : { username: requireUtf8String(proxy.username, 'resolved network proxy username', 256) }),
    ...(proxy.password === undefined
      ? {}
      : { password: requireUtf8String(proxy.password, 'resolved network proxy password', 1_024) }),
    bypassList: stringList(proxy.bypassList, 'resolved network proxy bypass list'),
  };
}

function decodeProbeUrl(value: unknown): string {
  const raw = requireUtf8String(value, 'network proxy probe URL', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidProtocolFrame('Invalid network proxy probe URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidProtocolFrame('Invalid network proxy probe URL');
  }
  return parsed.toString();
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function stringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((item) => typeof item !== 'string' || item.length > 512)
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return [...value];
}

function optionalText(
  record: Record<string, unknown>,
  key: 'ip' | 'countryCode' | 'countryFlag' | 'error',
  maxBytes: number,
): Partial<Record<typeof key, string>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: requireUtf8String(value, `network proxy ${key}`, maxBytes) };
}
