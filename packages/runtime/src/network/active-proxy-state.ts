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

let activeProxy: ProxySettings | null = null;
let activeProxyBlocked = false;

export function setActiveProxy(proxy: ProxySettings | null): void {
  activeProxy = proxy?.enabled ? proxy : null;
  activeProxyBlocked = false;
}

/**
 * Keeps client-owned requests fail-closed when policy requires a proxy but
 * the Host cannot provide its credentials. This must not be represented by
 * `null`, because `null` deliberately means that direct routing is allowed.
 */
export function setActiveProxyBlocked(): void {
  activeProxy = null;
  activeProxyBlocked = true;
}

export function resolveActiveProxy(): ProxySettings | null {
  return activeProxy;
}

export function isActiveProxyBlocked(): boolean {
  return activeProxyBlocked;
}
