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

import {
  normalizeRequestBodyOverlay,
  normalizeRequestHeaders,
  type JsonObject,
} from '@maka/core/runtime-policy';

export interface RequestCustomization {
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyOverlay?: JsonObject;
  /** Final provider-owned body policy, applied after caller overlays. */
  readonly finalizeBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

export function createRequestCustomizationFetch(
  upstream: typeof globalThis.fetch,
  customization: RequestCustomization,
): typeof globalThis.fetch {
  const headers = normalizeRequestHeaders(customization.headers ?? {});
  const bodyOverlay = normalizeRequestBodyOverlay(customization.bodyOverlay ?? {});
  const bodyOverlayKeys = Object.keys(bodyOverlay);
  if (
    Object.keys(headers).length === 0 &&
    bodyOverlayKeys.length === 0 &&
    !customization.finalizeBody
  ) {
    return upstream;
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const nextHeaders = new Headers(request.headers);
    for (const [name, value] of Object.entries(headers)) {
      const current = nextHeaders.get(name);
      if (current !== null && current !== value) {
        throw new Error(`Custom request header conflicts with a generated header: ${name}`);
      }
      nextHeaders.set(name, value);
    }

    let body: BodyInit | null = request.body === null ? null : await request.clone().arrayBuffer();
    if (bodyOverlayKeys.length > 0 || customization.finalizeBody) {
      if (!requestHasJsonBody(request)) {
        if (customization.finalizeBody) {
          throw new Error('Request body finalizer requires a JSON object request body');
        }
        return upstream(request.url, requestInit(request, nextHeaders, body));
      }
      const generatedBody = await parseRequestBody(
        request,
        customization.finalizeBody
          ? 'Request body finalizer requires a JSON object request body'
          : 'Extra request body can only be applied to a JSON object request',
      );
      for (const key of bodyOverlayKeys) {
        if (Object.hasOwn(generatedBody, key)) {
          throw new Error(`Extra request body conflicts with a generated field: ${key}`);
        }
      }
      const customizedBody = { ...generatedBody, ...bodyOverlay };
      body = JSON.stringify(
        customization.finalizeBody ? customization.finalizeBody(customizedBody) : customizedBody,
      );
      nextHeaders.delete('content-length');
    }
    return upstream(request.url, requestInit(request, nextHeaders, body));
  };
}

function requestInit(request: Request, headers: Headers, body: BodyInit | null): RequestInit {
  return {
    method: request.method,
    headers: [...headers.entries()],
    ...(body === null ? {} : { body, duplex: 'half' }),
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  } as RequestInit;
}

function requestHasJsonBody(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) return false;
  const contentType = request.headers.get('content-type');
  return (
    contentType === null || /(^|\s|;)application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
  );
}

async function parseRequestBody(
  request: Request,
  invalidBodyMessage: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.clone().text());
  } catch {
    throw new Error(invalidBodyMessage);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(invalidBodyMessage);
  }
  return parsed as Record<string, unknown>;
}
