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

import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export class PublicNetworkPolicyError extends Error {
  readonly name = 'PublicNetworkPolicyError';
  constructor() {
    super('Network target is not allowed by the public network policy');
  }
}

/** Validate every URL, then resolve and pin direct destinations. Configured
 * proxies resolve named destinations themselves and are trusted to enforce
 * their egress boundary. Local DNS cannot establish a proxy's final address. */
export async function preparePublicNetworkTarget(
  url: URL,
  useProxy: boolean,
  signal: AbortSignal,
): Promise<LookupAddress | undefined> {
  signal.throwIfAborted();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new PublicNetworkPolicyError();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family) {
    if (!publicAddress(host)) throw new PublicNetworkPolicyError();
    return useProxy ? undefined : { address: host, family };
  }
  if (!publicHostname(host)) throw new PublicNetworkPolicyError();
  if (useProxy) return undefined;
  const addresses = await lookupWithSignal(host, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new PublicNetworkPolicyError();
  return addresses[0];
}

function lookupWithSignal(host: string, signal: AbortSignal): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else
      void lookup(host, { all: true })
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', abort);
        });
  });
}

function publicHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name.includes('.') &&
    !/(^|\.)(localhost|local|lan|internal|home|arpa|test|invalid)$/.test(name) &&
    ![
      'metadata.google.internal',
      'metadata.goog',
      'metadata.tencentyun.com',
      'instance-data.ec2.internal',
    ].includes(name)
  );
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a > 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) !== 6) return false;
  // Only global-unicast IPv6 is eligible, excluding the benchmarking prefix.
  const normalized = new URL(`http://[${address}]`).hostname;
  return /^[23][0-9a-f]{3}:/i.test(address) && !/^\[2001:2:(?::|0:)/i.test(normalized);
}
