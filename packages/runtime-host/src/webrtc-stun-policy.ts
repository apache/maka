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

const RUNTIME_HOST_WEBRTC_STUN_URL_MAX_BYTES = 512;
const RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT = 8;

const DEFAULT_RUNTIME_HOST_WEBRTC_STUN_URLS = Object.freeze([
  'stun:stun.cloudflare.com:3478',
] as const);

export type RuntimeHostWebRtcStunPolicy =
  | { readonly kind: 'default' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'custom'; readonly urls: readonly string[] };

const runtimeHostWebRtcStunUrlSchema = z.string().refine(isRuntimeHostWebRtcStunUrl, {
  message: 'WebRTC STUN URL must use stun:host[:port] with a valid host and numeric port',
});

export const runtimeHostWebRtcStunPolicySchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('default') }).strict(),
    z.object({ kind: z.literal('disabled') }).strict(),
    z
      .object({
        kind: z.literal('custom'),
        urls: z
          .array(runtimeHostWebRtcStunUrlSchema)
          .min(1)
          .max(RUNTIME_HOST_WEBRTC_STUN_URL_MAX_COUNT),
      })
      .strict(),
  ])
  .transform(
    (policy): RuntimeHostWebRtcStunPolicy =>
      policy.kind === 'custom' ? { kind: 'custom', urls: [...new Set(policy.urls)] } : policy,
  );

export function decodeRuntimeHostWebRtcStunPolicy(value: unknown): RuntimeHostWebRtcStunPolicy {
  const result = runtimeHostWebRtcStunPolicySchema.safeParse(value);
  if (result.success) return result.data;
  throw new TypeError(result.error.issues[0]?.message ?? 'WebRTC STUN policy is invalid');
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
      return [...policy.urls];
  }
}

function isRuntimeHostWebRtcStunUrl(value: string): boolean {
  if (
    !value.startsWith('stun:') ||
    value.startsWith('stun://') ||
    /\s|[/?#@]/u.test(value.slice('stun:'.length)) ||
    value.length > RUNTIME_HOST_WEBRTC_STUN_URL_MAX_BYTES
  ) {
    return false;
  }
  const authority = value.slice('stun:'.length);
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || !isIpv6Literal(authority.slice(1, close))) return false;
    return validPortSuffix(authority.slice(close + 1));
  }
  if (authority.includes('[') || authority.includes(']')) return false;
  const separator = authority.lastIndexOf(':');
  if (separator !== authority.indexOf(':')) return false;
  const host = separator < 0 ? authority : authority.slice(0, separator);
  const port = separator < 0 ? '' : authority.slice(separator);
  return isHost(host) && validPortSuffix(port);
}

function isHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (isIpv4Literal(value)) return true;
  if (/^[0-9.]+$/u.test(value)) {
    return false;
  }
  return value
    .split('.')
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
    );
}

function isIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^\d{1,3}$/u.test(part) && (part === '0' || !part.startsWith('0')) && Number(part) <= 255,
    )
  );
}

function isIpv6Literal(value: string): boolean {
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

function validPortSuffix(value: string): boolean {
  if (value.length === 0) return true;
  if (!/^:\d{1,5}$/u.test(value)) return false;
  const port = Number(value.slice(1));
  return port >= 1 && port <= 65_535;
}
