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

export type ProxyType = 'http' | 'https' | 'socks5';

export const SENSITIVE_PLACEHOLDER = '••••••••' as const;
export type Sensitive = string | typeof SENSITIVE_PLACEHOLDER;

export function applySensitivePatch(
  prev: string | undefined,
  next: Sensitive | undefined,
): string | undefined {
  if (next === undefined || next === SENSITIVE_PLACEHOLDER) return prev;
  if (next === '') return undefined;
  return next;
}

export function maskSensitive(value: string | undefined): typeof SENSITIVE_PLACEHOLDER | undefined {
  return value && value.length > 0 ? SENSITIVE_PLACEHOLDER : undefined;
}

export interface ProxySettings {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: Sensitive;
  bypassList: string[];
}

export interface RuntimeNetworkSettings {
  proxy: ProxySettings;
  timeout: number;
  retryAttempts: number;
  userAgent?: string;
  preferIpv4: boolean;
}

export const PROXY_DEFAULTS: ProxySettings = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
  bypassList: ['localhost', '127.0.0.1', '::1', '*.local'],
};

export const NETWORK_DEFAULTS: RuntimeNetworkSettings = {
  proxy: PROXY_DEFAULTS,
  timeout: 30_000,
  retryAttempts: 3,
  preferIpv4: false,
};

export interface TestProxyInput {
  proxy?: ProxySettings;
  url?: string;
  timeoutMs?: number;
}

export interface TestProxyResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  ip?: string;
  countryCode?: string;
  countryFlag?: string;
  error?: string;
}
