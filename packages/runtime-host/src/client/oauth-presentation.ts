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
  requestAuthorizationCode(url: string, stateHint: string, signal: AbortSignal): Promise<string>;
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
      switch (request.method) {
        case 'open_external':
          await options.accept();
          await backend.openExternal(url, request.stateHint, options.signal);
          return decodeOAuthPresentationResult(request.method, { kind: 'presented' });
        case 'request_authorization_code': {
          await options.accept();
          const authorizationCode = await backend.requestAuthorizationCode(
            url,
            request.stateHint,
            options.signal,
          );
          return decodeOAuthPresentationResult(request.method, {
            kind: 'authorization_code',
            authorizationCode,
          });
        }
      }
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
