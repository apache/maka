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

import { z } from 'zod';

export const RUNTIME_HOST_WEBRTC_STUN_URL_MAX_BYTES = 512;
export const RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT = 8;

export const DEFAULT_RUNTIME_HOST_WEBRTC_STUN_URLS = Object.freeze([
  'stun:stun.cloudflare.com:3478',
] as const);

export type RuntimeHostWebRtcStunPolicy =
  | { readonly kind: 'default' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'custom'; readonly urls: readonly string[] };

export const runtimeHostWebRtcStunPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('default') }).strict(),
  z.object({ kind: z.literal('disabled') }).strict(),
  z
    .object({
      kind: z.literal('custom'),
      urls: z
        .array(z.string().refine(isRuntimeHostWebRtcStunUrl))
        .min(1)
        .max(RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT),
    })
    .strict(),
]);

export function decodeRuntimeHostWebRtcStunPolicy(value: unknown): RuntimeHostWebRtcStunPolicy {
  if (!isRecord(value)) throw new TypeError('WebRTC STUN policy must be an object');
  if (value.kind === 'default' || value.kind === 'disabled') {
    if (Object.keys(value).length !== 1) {
      throw new TypeError('WebRTC STUN policy contains unsupported fields');
    }
    return { kind: value.kind };
  }
  if (value.kind === 'custom' && Object.keys(value).length === 2) {
    if (!Array.isArray(value.urls) || value.urls.some((url) => typeof url !== 'string')) {
      throw new TypeError('Custom WebRTC STUN policy requires a URL list');
    }
    const urls = normalizeRuntimeHostWebRtcStunUrls(value.urls);
    if (urls.length === 0) {
      throw new TypeError('Custom WebRTC STUN policy requires at least one URL');
    }
    return { kind: 'custom', urls };
  }
  throw new TypeError('WebRTC STUN policy kind is invalid');
}

export function resolveRuntimeHostWebRtcStunUrls(
  policy: RuntimeHostWebRtcStunPolicy,
): readonly string[] {
  switch (policy.kind) {
    case 'default':
      return [...DEFAULT_RUNTIME_HOST_WEBRTC_STUN_URLS];
    case 'disabled':
      return [];
    case 'custom':
      return normalizeRuntimeHostWebRtcStunUrls(policy.urls);
  }
}

export function normalizeRuntimeHostWebRtcStunUrls(values: readonly string[]): string[] {
  if (values.length > RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT) {
    throw new RangeError(
      `WebRTC cannot use more than ${String(RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT)} STUN URLs`,
    );
  }
  const urls: string[] = [];
  for (const value of values) {
    if (!isRuntimeHostWebRtcStunUrl(value)) {
      throw new TypeError('WebRTC STUN URL must use the stun: scheme and contain no whitespace');
    }
    if (!urls.includes(value)) urls.push(value);
  }
  return urls;
}

export function isRuntimeHostWebRtcStunUrl(value: string): boolean {
  return (
    value.startsWith('stun:') &&
    value.length > 'stun:'.length &&
    !/\s/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= RUNTIME_HOST_WEBRTC_STUN_URL_MAX_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
