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

// packages/mcp/src/transport-security.ts
//
// Transport security is not network authority: cleartext-loopback is a
// TRUST decision, not a scheme rule, and only the user's own configuration
// confers it. A remotely supplied destination — a redirect Location, an
// OAuth metadata URL, an authorization endpoint — must not inherit the
// loopback exception unless the user pointed the server itself at loopback
// (a local trust root).
//
// The same provenance rule extends to `https` aimed BACK INTO the user's
// machine or network: a remote server's metadata can name
// `https://169.254.169.254/…` or `https://192.168.1.1/…` and the client
// would dutifully issue the request — blind SSRF from inside the network.
// Public https destinations pass (that is what OAuth endpoints look like);
// loopback and private-range IP LITERALS require the configured endpoint to
// be a matching local/internal trust root. Names that merely RESOLVE to
// private addresses are accepted risk: checking them would require a
// resolve here and could still re-resolve differently at request time.

import { isLoopbackHost, isNonLoopbackCleartextHttp, isPrivateRangeHost } from '@maka/core/mcp';

export interface UrlProvenance {
  configuredOrigin: string;
  configuredOriginIsLoopback: boolean;
  configuredOriginIsPrivate: boolean;
}

export function urlProvenance(configuredServerUrl: URL): UrlProvenance {
  return {
    configuredOrigin: configuredServerUrl.origin,
    configuredOriginIsLoopback: isLoopbackHost(configuredServerUrl.hostname),
    configuredOriginIsPrivate: isPrivateRangeHost(configuredServerUrl.hostname),
  };
}

export function assertTransportSecurity(url: URL, provenance: UrlProvenance): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refused non-HTTP request to ${url.protocol}//`);
  }
  if (url.protocol === 'https:') {
    if (url.origin === provenance.configuredOrigin) return;
    if (isLoopbackHost(url.hostname)) {
      if (provenance.configuredOriginIsLoopback) return;
      throw new Error(
        `refused remotely supplied loopback https destination ${url.origin}: ` +
          'only a user-configured loopback endpoint may target the local machine',
      );
    }
    if (isPrivateRangeHost(url.hostname)) {
      if (provenance.configuredOriginIsLoopback || provenance.configuredOriginIsPrivate) return;
      throw new Error(
        `refused remotely supplied private-range https destination ${url.origin}: ` +
          'only a local or internal configured endpoint may target the private network',
      );
    }
    return;
  }
  if (isNonLoopbackCleartextHttp(url)) {
    throw new Error(
      `refused cleartext http request to ${url.origin}: non-loopback hosts require https`,
    );
  }
  // http + loopback from here on: allowed for the configured endpoint
  // itself, or when the configured endpoint is a loopback trust root.
  if (url.origin === provenance.configuredOrigin) return;
  if (provenance.configuredOriginIsLoopback) return;
  throw new Error(
    `refused remotely supplied loopback http destination ${url.origin}: ` +
      'only a user-configured loopback endpoint may use cleartext',
  );
}
