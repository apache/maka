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

import { defineObjectShape, hasExactShape } from './record-schema.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ClientCapabilityGrantCapability = 'browser' | 'computer_use' | 'desktop_mcp';

export type ClientCapabilityGrantScope =
  | { readonly kind: 'browser_origin'; readonly origin: string }
  | { readonly kind: 'capability' }
  | { readonly kind: 'mcp_tool'; readonly serverId: string; readonly toolName: string };

export interface ClientCapabilityGrantTarget {
  readonly providerId: string;
  readonly contractId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly capability: ClientCapabilityGrantCapability;
  readonly scope: ClientCapabilityGrantScope;
}

export interface ClientCapabilitySessionGrantKey extends ClientCapabilityGrantTarget {
  readonly sessionId: string;
}

export interface ClientCapabilitySessionGrant extends ClientCapabilitySessionGrantKey {
  readonly version: 1;
  readonly grantedAt: number;
}

export interface ClientCapabilityResponse {
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
}

const GRANT_SHAPE = defineObjectShape<ClientCapabilitySessionGrant>()(
  [
    'version',
    'sessionId',
    'providerId',
    'contractId',
    'serverId',
    'toolName',
    'capability',
    'scope',
    'grantedAt',
  ],
  [],
);
const BROWSER_ORIGIN_SCOPE_SHAPE = defineObjectShape<
  Extract<ClientCapabilityGrantScope, { kind: 'browser_origin' }>
>()(['kind', 'origin'], []);
const CAPABILITY_SCOPE_SHAPE = defineObjectShape<
  Extract<ClientCapabilityGrantScope, { kind: 'capability' }>
>()(['kind'], []);
const MCP_TOOL_SCOPE_SHAPE = defineObjectShape<
  Extract<ClientCapabilityGrantScope, { kind: 'mcp_tool' }>
>()(['kind', 'serverId', 'toolName'], []);

export function decodeClientCapabilitySessionGrantKey(
  value: unknown,
): ClientCapabilitySessionGrantKey {
  const record = plainRecord(value, 'Client Capability Session Grant key');
  return deepFreeze({
    sessionId: safeId(record.sessionId, 'sessionId'),
    ...decodeClientCapabilityGrantTarget(record),
  });
}

export function decodeClientCapabilityGrantTarget(value: unknown): ClientCapabilityGrantTarget {
  const record = plainRecord(value, 'Client Capability Grant target');
  const capability = oneOf(
    record.capability,
    ['browser', 'computer_use', 'desktop_mcp'] as const,
    'capability',
  );
  const scope = decodeClientCapabilityGrantScope(record.scope);
  if (
    (capability === 'browser' && scope.kind !== 'browser_origin') ||
    (capability === 'computer_use' && scope.kind !== 'capability') ||
    (capability === 'desktop_mcp' && scope.kind !== 'mcp_tool')
  ) {
    throw new Error('Client Capability Session Grant scope does not match capability');
  }
  return deepFreeze({
    providerId: safeId(record.providerId, 'providerId'),
    contractId: safeId(record.contractId, 'contractId'),
    serverId: safeId(record.serverId, 'serverId'),
    toolName: safeId(record.toolName, 'toolName'),
    capability,
    scope,
  });
}

export function decodeClientCapabilitySessionGrant(value: unknown): ClientCapabilitySessionGrant {
  const record = plainRecord(value, 'Client Capability Session Grant');
  if (!hasExactShape(record, GRANT_SHAPE)) {
    throw new Error('Invalid Client Capability Session Grant fields');
  }
  if (record.version !== 1) throw new Error('Invalid Client Capability Session Grant version');
  if (
    typeof record.grantedAt !== 'number' ||
    !Number.isSafeInteger(record.grantedAt) ||
    record.grantedAt < 0
  ) {
    throw new Error('Invalid Client Capability Session Grant timestamp');
  }
  return deepFreeze({
    version: 1,
    ...decodeClientCapabilitySessionGrantKey(record),
    grantedAt: record.grantedAt,
  });
}

export function clientCapabilityScopeIdentity(scope: ClientCapabilityGrantScope): string {
  switch (scope.kind) {
    case 'browser_origin':
      return scope.origin;
    case 'capability':
      return '*';
    case 'mcp_tool':
      return `${scope.serverId}\0${scope.toolName}`;
  }
}

function decodeClientCapabilityGrantScope(value: unknown): ClientCapabilityGrantScope {
  const record = plainRecord(value, 'Client Capability Session Grant scope');
  switch (record.kind) {
    case 'browser_origin': {
      if (!hasExactShape(record, BROWSER_ORIGIN_SCOPE_SHAPE)) {
        throw new Error('Invalid Browser origin scope fields');
      }
      if (typeof record.origin !== 'string' || record.origin.length > 16_384) {
        throw new Error('Invalid Browser origin scope');
      }
      const url = new URL(record.origin);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== record.origin) {
        throw new Error('Browser origin scope must be a canonical HTTP origin');
      }
      return deepFreeze({ kind: 'browser_origin', origin: record.origin });
    }
    case 'capability':
      if (!hasExactShape(record, CAPABILITY_SCOPE_SHAPE)) {
        throw new Error('Invalid capability scope fields');
      }
      return Object.freeze({ kind: 'capability' });
    case 'mcp_tool':
      if (!hasExactShape(record, MCP_TOOL_SCOPE_SHAPE)) {
        throw new Error('Invalid MCP tool scope fields');
      }
      return Object.freeze({
        kind: 'mcp_tool',
        serverId: safeId(record.serverId, 'scope.serverId'),
        toolName: safeId(record.toolName, 'scope.toolName'),
      });
    default:
      throw new Error('Invalid Client Capability Session Grant scope kind');
  }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function oneOf<const T extends readonly unknown[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value)) throw new Error(`Invalid ${label}`);
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
