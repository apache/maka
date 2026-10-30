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
let blockedReason: string | null = null;

/**
 * Raised instead of sending when the network policy asks for a proxy this
 * process cannot use. Going direct would route traffic past that policy.
 */
export class ActiveProxyBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`Outbound request blocked: ${reason}`);
    this.name = 'ActiveProxyBlockedError';
  }
}

export function setActiveProxy(proxy: ProxySettings | null): void {
  activeProxy = proxy?.enabled ? proxy : null;
  blockedReason = null;
}

/** Refuses outbound requests until the next `setActiveProxy`. */
export function blockActiveProxy(reason: string): void {
  activeProxy = null;
  blockedReason = reason;
}

export function resolveActiveProxy(): ProxySettings | null {
  return activeProxy;
}

export function assertActiveProxyUsable(): void {
  if (blockedReason !== null) throw new ActiveProxyBlockedError(blockedReason);
}
