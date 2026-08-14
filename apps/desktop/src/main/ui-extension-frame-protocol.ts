import type { ExtensionUiSnapshotResult } from '@maka/runtime-host/protocol';
import {
  uiExtensionFramePolicy,
  withUiSandboxPolicy,
} from './ui-extension-frame-document.js';

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPECTED_QUERY_KEYS = Object.freeze([
  'bindingId',
  'contributionId',
  'extensionId',
  'revision',
  'scopeId',
  'token',
]);

export interface UiExtensionFrameClient {
  request(
    operation: 'extension.ui.snapshot',
    input: { readonly scopeId: string },
  ): Promise<ExtensionUiSnapshotResult>;
}

export function createUiExtensionFrameRequestHandler(
  resolveClient: () => UiExtensionFrameClient | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return response('Method not allowed', 405);
    const identity = decodeFrameIdentity(request.url);
    if (!identity) return response('Invalid UI Extension frame request', 400);
    const client = resolveClient();
    if (!client) return response('Runtime Host unavailable', 503);
    try {
      const snapshot = await client.request('extension.ui.snapshot', {
        scopeId: identity.scopeId,
      });
      const contribution = snapshot.contributions.find(
        (item) =>
          item.bindingId === identity.bindingId &&
          item.extensionId === identity.extensionId &&
          item.revision === identity.revision &&
          item.id === identity.contributionId,
      );
      if (!contribution) return response('UI Extension contribution not active', 404);
      const document = withUiSandboxPolicy(
        contribution.document,
        contribution.network,
        identity.token,
      );
      return new Response(document, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-security-policy': uiExtensionFramePolicy(contribution.network),
          'content-type': 'text/html; charset=utf-8',
          'cross-origin-resource-policy': 'cross-origin',
        },
      });
    } catch {
      return response('Runtime Host unavailable', 503);
    }
  };
}

function decodeFrameIdentity(urlValue: string): {
  readonly scopeId: 'desktop-ui';
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly contributionId: string;
  readonly token: string;
} | null {
  const url = new URL(urlValue);
  if (url.protocol !== 'maka-ui:' || url.hostname !== 'frame' || url.pathname !== '/v1') {
    return null;
  }
  if ([...url.searchParams.keys()].sort().join('\0') !== EXPECTED_QUERY_KEYS.join('\0')) {
    return null;
  }
  const scopeId = url.searchParams.get('scopeId');
  const bindingId = url.searchParams.get('bindingId');
  const extensionId = url.searchParams.get('extensionId');
  const revision = url.searchParams.get('revision');
  const contributionId = url.searchParams.get('contributionId');
  const token = url.searchParams.get('token');
  if (
    scopeId !== 'desktop-ui' ||
    !bindingId ||
    !extensionId ||
    !revision ||
    !contributionId ||
    !token ||
    !TOKEN_PATTERN.test(token)
  ) {
    return null;
  }
  return { scopeId, bindingId, extensionId, revision, contributionId, token };
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
