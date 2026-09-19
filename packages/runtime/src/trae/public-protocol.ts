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

import { createHmac, randomUUID } from 'node:crypto';
import { traeAccountFields, type TraeAccount } from '@maka/core/llm-connections';
import { TRAE, record } from './protocol.js';

export type TraePublicAccount = Exclude<TraeAccount, 'employee'>;
export interface TraePublicIdentity {
  account: TraePublicAccount;
  machineId: string;
  deviceId: string;
  /** Issuer that exchanged the login; refresh must return to it. Absent on legacy credentials. */
  authOrigin?: TraePublicAuthOrigin;
}
export const TRAE_PUBLIC_AUTH_ORIGINS = [
  'https://api.trae.cn',
  'https://growsg-normal.trae.ai',
  'https://grow-normal.trae.ai',
] as const;
export type TraePublicAuthOrigin = (typeof TRAE_PUBLIC_AUTH_ORIGINS)[number];

/**
 * Token issuers to try in order. International accounts exchange on the
 * global hosts; a token from the wrong issuer is rejected by the core API
 * with 401, so the issuer that succeeded is recorded for refresh.
 */
export function traePublicAuthOrigins(account: TraePublicAccount): readonly TraePublicAuthOrigin[] {
  if (account.split('-')[0] === 'cn') return ['https://api.trae.cn'];
  return ['https://growsg-normal.trae.ai', 'https://grow-normal.trae.ai'];
}
/**
 * The device Trae sees for one Host root. Trae counts every distinct
 * machine/device pair against the account's device limit, so a login that
 * invented a fresh pair each time spent one device slot per sign-in and hit
 * `20401 Device limit reached` after a few. Deriving the pair from the root
 * keeps every Trae Connection and re-login of one install on a single device,
 * the way one IDE install is. The derivation is keyed, so the root id itself
 * never leaves the machine.
 */
export function traePublicDeviceIdentity(
  seed: string,
): Pick<TraePublicIdentity, 'machineId' | 'deviceId'> {
  if (seed.length === 0) throw new Error('Trae device identity seed must not be empty');
  const derive = (label: string) =>
    createHmac('sha256', `maka-trae-${label}`).update(seed).digest('hex');
  return { machineId: derive('machine'), deviceId: derive('device').slice(0, 32) };
}
export const TRAE_PUBLIC_VERSION = '3.5.66';
export const TRAE_PUBLIC_CHAT_PATH = '/api/agent/v3/llm_utils_chat';

export function traePublicProfile(account: TraePublicAccount) {
  const region = account.split('-')[0];
  const solo = account.endsWith('-solo');
  return {
    region,
    solo,
    clientId: solo ? 'en1oxy7wnw8j9n' : 'ono9krqynydwx5',
    baseUrl: region === 'cn' ? 'https://trae-api-cn.mchost.guru' : 'https://coresg-normal.trae.ai',
    loginOrigin: region === 'cn' ? 'https://www.trae.cn' : 'https://www.trae.ai',
    // Default issuer for credentials that predate `identity.authOrigin`.
    authOrigin: traePublicAuthOrigins(account)[0]!,
    // Keep the function that advertised each model: these are not interchangeable.
    functions: solo
      ? region === 'cn'
        ? ['solo_work_remote', 'solo_work_lite']
        : ['solo_agent', 'solo_work_remote', 'solo_work_lite']
      : ['chat_v3'],
  };
}

export function parseTraePublicIdentity(value: unknown): TraePublicIdentity {
  const data = record(value);
  const account = traeAccountFields(data?.account, 'trae').traeAccount;
  if (
    !account ||
    account === 'employee' ||
    typeof data?.machineId !== 'string' ||
    !/^[a-f0-9-]{32,64}$/i.test(data.machineId) ||
    typeof data.deviceId !== 'string' ||
    !/^[a-f0-9-]{16,64}$/i.test(data.deviceId) ||
    (data.authOrigin !== undefined &&
      !TRAE_PUBLIC_AUTH_ORIGINS.includes(data.authOrigin as TraePublicAuthOrigin))
  ) {
    throw new Error('Invalid Trae account identity');
  }
  return {
    account,
    machineId: data.machineId,
    deviceId: data.deviceId,
    ...(data.authOrigin === undefined
      ? {}
      : { authOrigin: data.authOrigin as TraePublicAuthOrigin }),
  };
}

export function traePublicHeaders(
  token: string,
  identity: TraePublicIdentity,
): Record<string, string> {
  return {
    authorization: `Cloud-IDE-JWT ${token}`,
    'x-ide-token': token,
    'x-cloudide-token': token,
    'x-app-id': TRAE.appId,
    'x-app-version': TRAE_PUBLIC_VERSION,
    'x-ide-version': TRAE_PUBLIC_VERSION,
    'x-app-version-code': '20260811',
    'x-ide-version-code': '20260811',
    'x-ide-version-type': 'stable',
    'x-app-version-type': 'stable',
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-device-brand': 'PC',
    'x-device-type':
      process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    'x-os-version': process.platform,
    'x-plugin-channel': 'icube-ai',
    'x-request-id': randomUUID(),
    'request-traffic-type': 'prod',
    'content-type': 'application/json',
    'user-agent': `Trae/${TRAE_PUBLIC_VERSION}`,
  };
}

/** Credentials may only go to this account's inference origin. No caller-selected hosts. */
export function createTraePublicFetch(
  fetchFn: typeof fetch,
  token: string,
  identity: TraePublicIdentity,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== traePublicProfile(identity.account).baseUrl) {
      throw new Error('Trae account does not match the request region');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete('x-jwt-token');
    for (const [name, value] of Object.entries(traePublicHeaders(token, identity)))
      headers.set(name, value);
    return fetchFn(input, { ...init, headers, redirect: 'error' });
  };
}
