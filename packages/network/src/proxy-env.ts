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

import { buildProxyUrl, bracketIfIpv6 } from './proxy-parser.js';
import type { ProxySettings } from '@maka/core/settings/network-settings';

export function getEnvWithProxy(base: NodeJS.ProcessEnv, proxy: ProxySettings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  if (!proxy.enabled || !proxy.host || !proxy.port) return out;

  const url = proxy.type === 'socks5' ? buildSocks5Url(proxy) : buildProxyUrl(proxy);
  setIfAbsent(out, 'HTTP_PROXY', url);
  setIfAbsent(out, 'HTTPS_PROXY', url);
  setIfAbsent(out, 'http_proxy', url);
  setIfAbsent(out, 'https_proxy', url);

  const noProxy = buildNoProxy(proxy.bypassList);
  if (noProxy) {
    setIfAbsent(out, 'NO_PROXY', noProxy);
    setIfAbsent(out, 'no_proxy', noProxy);
  }
  return out;
}

export function buildNoProxy(bypassList: readonly string[]): string {
  return bypassList
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}

function buildSocks5Url(proxy: ProxySettings): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${
        proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''
      }@`
    : '';
  return `socks5://${auth}${bracketIfIpv6(proxy.host)}:${proxy.port}`;
}

function setIfAbsent(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env[key] === undefined || env[key] === '') env[key] = value;
}
