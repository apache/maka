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

import type { ProxiedFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';
import { AcpSetupError } from './connection.js';

/** Only the child receives proxy credentials; never persist or project this environment. */
export function createAntigravityEnvironment(
  base: NodeJS.ProcessEnv,
  proxy: ProxiedFetchProxy | null,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!proxy?.enabled) return env;
  // Official 1.1.1 fails session/new with "python-socks is required". Do not
  // reinterpret a SOCKS endpoint as HTTP or silently use a different network route.
  if (proxy.type === 'socks5') throw new AcpSetupError('proxy_unsupported');
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  const credentials = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  const url = `${proxy.type}://${credentials}${host}:${proxy.port}`;
  // Explicit policy takes precedence over inherited variables and macOS proxy
  // discovery. Both the Python server and its helper inherit this same snapshot.
  env.HTTP_PROXY = env.http_proxy = url;
  env.HTTPS_PROXY = env.https_proxy = url;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.NO_PROXY = env.no_proxy = proxy.bypassList.join(',');
  return env;
}
