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

import type { ClientCapabilityServiceCallFrame } from '../protocol/index.js';
import {
  decodeOAuthPresentationRequest,
  decodeOAuthPresentationResult,
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
} from '../protocol/oauth.js';
import type { ClientCapabilityProvider } from './client-capability.js';

export { OAUTH_PRESENTATION_SERVICE_ID, OAUTH_PRESENTATION_SERVICE_VERSION };

export interface OAuthPresentationBackend {
  openExternal(url: string, stateHint: string | undefined, signal: AbortSignal): Promise<void>;
}

/** A presentation-only provider. OAuth token exchange and storage stay in the Host. */
export function createOAuthPresentationClientProvider(
  backend: OAuthPresentationBackend,
): ClientCapabilityProvider {
  return {
    offers: () => [],
    services: () => [
      {
        serviceId: OAUTH_PRESENTATION_SERVICE_ID,
        version: OAUTH_PRESENTATION_SERVICE_VERSION,
      },
    ],
    callService: async (frame, options) => {
      assertOAuthPresentationContract(frame);
      const request = decodeOAuthPresentationRequest(frame.method, frame.input);
      const url = trustedPresentationUrl(request.url);
      await options.accept();
      await backend.openExternal(url, request.stateHint, options.signal);
      return decodeOAuthPresentationResult(request.method, { kind: 'presented' });
    },
  };
}

function assertOAuthPresentationContract(frame: ClientCapabilityServiceCallFrame): void {
  if (
    frame.serviceId !== OAUTH_PRESENTATION_SERVICE_ID ||
    frame.version !== OAUTH_PRESENTATION_SERVICE_VERSION
  ) {
    throw new Error('OAuth presentation service contract does not match');
  }
}

function trustedPresentationUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OAuth presentation URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('OAuth presentation URL is not trusted');
  }
  return parsed.toString();
}
