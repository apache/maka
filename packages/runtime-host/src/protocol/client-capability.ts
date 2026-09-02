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

import { TOOL_ACTIVITY_KINDS, type ToolActivityKind } from '@maka/core/events';
import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';

export interface ClientCapabilityToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ClientCapabilityToolDescriptor {
  readonly serverId: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ClientCapabilityToolAnnotations;
  readonly activityKind?: ToolActivityKind;
}

export type ClientCapabilityContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource';
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name?: string;
      readonly description?: string;
      readonly mimeType?: string;
    }
  | { readonly type: 'unknown'; readonly value: unknown };

export interface ClientCapabilityCallResult {
  readonly content: ClientCapabilityContentBlock[];
  readonly structuredContent?: unknown;
}

export type ClientCapabilityAffinity = 'call' | 'turn' | 'session';
export type ClientCapabilityHostPathAccess = 'none' | 'cwd';

export const CLIENT_CAPABILITY_MAX_OFFERS = 32;
export const CLIENT_CAPABILITY_MAX_SERVICES = 32;
export const CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER = 64;
export const CLIENT_CAPABILITY_MAX_TOOLS = 256;
export const CLIENT_CAPABILITY_MAX_MANIFEST_BYTES = 56 * 1024;
export const CLIENT_CAPABILITY_MAX_RESULT_BYTES = 24 * 1024 * 1024;
export const CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES = 36 * 1024;
export const CLIENT_CAPABILITY_MAX_PROGRESS_TOTAL = 1_024;
export const CLIENT_CAPABILITY_MAX_RESULT_CHUNKS = Math.ceil(
  CLIENT_CAPABILITY_MAX_RESULT_BYTES / CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
);

const CLIENT_CAPABILITY_INLINE_RESULT_MAX_BYTES = 40 * 1024;
const CLIENT_CAPABILITY_JSON_MAX_DEPTH = 32;
const CLIENT_CAPABILITY_JSON_MAX_NODES = 8_192;
const CLIENT_CAPABILITY_TOOL_DESCRIPTION_MAX_CHARS = 8_192;
const CLIENT_CAPABILITY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export interface ClientCapabilityOffer {
  readonly offerId: string;
  readonly version: string;
  readonly affinity: ClientCapabilityAffinity;
  readonly hostPathAccess: ClientCapabilityHostPathAccess;
  readonly label: string;
  readonly description?: string;
  readonly tools: readonly ClientCapabilityToolDescriptor[];
}

export interface ClientCapabilityServiceOffer {
  readonly serviceId: string;
  readonly version: string;
}

export interface ClientCapabilityReplaceInput {
  readonly registrationId: string;
  readonly offers: readonly ClientCapabilityOffer[];
  readonly services?: readonly ClientCapabilityServiceOffer[];
}

export interface ClientCapabilityReplaceResult {
  readonly registrationId: string;
  readonly revision: number;
}

export interface ClientCapabilityUnregisterInput {
  readonly registrationId: string;
}

export interface ClientCapabilityUnregisterResult {
  readonly registrationId: string;
  readonly revision: number;
}

export interface ClientCapabilityCallFrame {
  readonly kind: 'client.capability.call';
  readonly invocationId: string;
  readonly registrationId: string;
  readonly offerId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly cwd?: string;
}

export interface ClientCapabilityServiceCallFrame {
  readonly kind: 'client.capability.service_call';
  readonly invocationId: string;
  readonly registrationId: string;
  readonly serviceId: string;
  readonly version: string;
  readonly method: string;
  readonly input: Record<string, unknown>;
}

export interface ClientCapabilityCancelFrame {
  readonly kind: 'client.capability.cancel';
  readonly invocationId: string;
}

export interface ClientCapabilityReleaseFrame {
  readonly kind: 'client.capability.release';
  readonly invocationId: string;
}

export interface ClientCapabilityRegistrationReleaseFrame {
  readonly kind: 'client.capability.registration_release';
  readonly registrationId: string;
}

export interface ClientCapabilityAdmittedFrame {
  readonly kind: 'client.capability.admitted';
  readonly invocationId: string;
}

export type ClientCapabilityHostFrame =
  | ClientCapabilityCallFrame
  | ClientCapabilityServiceCallFrame
  | ClientCapabilityCancelFrame
  | ClientCapabilityReleaseFrame
  | ClientCapabilityRegistrationReleaseFrame
  | ClientCapabilityAdmittedFrame;

export interface ClientCapabilityAcceptedFrame {
  readonly kind: 'client.capability.accepted';
  readonly invocationId: string;
  readonly admissionEvidence: ClientCapabilityAdmissionEvidence;
}

export type ClientCapabilityAdmissionEvidence =
  | { readonly kind: 'none' }
  | { readonly kind: 'browser_url'; readonly url: string };

export interface ClientCapabilityRejectedFrame {
  readonly kind: 'client.capability.rejected';
  readonly invocationId: string;
  readonly message: string;
}

export interface ClientCapabilityFailedFrame {
  readonly kind: 'client.capability.failed';
  readonly invocationId: string;
  readonly message: string;
}

export interface ClientCapabilityProgressFrame {
  readonly kind: 'client.capability.progress';
  readonly invocationId: string;
  readonly current: number;
  readonly total: number;
}

export interface ClientCapabilityResultFrame {
  readonly kind: 'client.capability.result';
  readonly invocationId: string;
  readonly result: ClientCapabilityCallResult;
}

export interface ClientCapabilityResultStartFrame {
  readonly kind: 'client.capability.result_start';
  readonly invocationId: string;
  readonly byteLength: number;
  readonly chunkCount: number;
}

export interface ClientCapabilityResultChunkFrame {
  readonly kind: 'client.capability.result_chunk';
  readonly invocationId: string;
  readonly index: number;
  readonly data: string;
}

export type ClientCapabilityClientFrame =
  | ClientCapabilityAcceptedFrame
  | ClientCapabilityRejectedFrame
  | ClientCapabilityFailedFrame
  | ClientCapabilityProgressFrame
  | ClientCapabilityResultFrame
  | ClientCapabilityResultStartFrame
  | ClientCapabilityResultChunkFrame;

export const CLIENT_CAPABILITY_OPERATION_SPECS = {
  'client.capability.replace': defineHostPathOperation<
    ClientCapabilityReplaceInput,
    ClientCapabilityReplaceResult,
    (typeof CLIENT_CAPABILITY_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: CLIENT_CAPABILITY_ERRORS,
      decodeInput: decodeClientCapabilityReplaceInput,
      decodeOutput: decodeClientCapabilityReplaceResult,
    },
    (input) => input.offers.some((offer) => offer.hostPathAccess === 'cwd'),
  ),
  'client.capability.unregister': defineOperation<
    ClientCapabilityUnregisterInput,
    ClientCapabilityUnregisterResult,
    (typeof CLIENT_CAPABILITY_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: CLIENT_CAPABILITY_ERRORS,
    decodeInput: decodeClientCapabilityUnregisterInput,
    decodeOutput: decodeClientCapabilityUnregisterResult,
  }),
} as const;

export function decodeClientCapabilityReplaceInput(value: unknown): ClientCapabilityReplaceInput {
  const record = requireRecord(value, 'Client Capability replacement');
  assertOptionalExactKeys(
    record,
    'Client Capability replacement',
    ['registrationId', 'offers'],
    ['services'],
  );
  if (!Array.isArray(record.offers) || record.offers.length > CLIENT_CAPABILITY_MAX_OFFERS) {
    throw invalidProtocolFrame('Invalid Client Capability offers');
  }
  const serviceValues = record.services ?? [];
  if (!Array.isArray(serviceValues) || serviceValues.length > CLIENT_CAPABILITY_MAX_SERVICES) {
    throw invalidProtocolFrame('Invalid Client Capability services');
  }
  if (record.offers.length === 0 && serviceValues.length === 0) {
    throw invalidProtocolFrame('Client Capability registration is empty');
  }
  const offers = record.offers.map((offer) => decodeClientCapabilityOffer(offer));
  const services = serviceValues.map((service) => decodeClientCapabilityServiceOffer(service));
  const offerIds = new Set<string>();
  const serviceContracts = new Set<string>();
  const toolIdentities = new Set<string>();
  let toolCount = 0;
  for (const offer of offers) {
    if (offerIds.has(offer.offerId)) {
      throw invalidProtocolFrame('Duplicate Client Capability offer');
    }
    offerIds.add(offer.offerId);
    toolCount += offer.tools.length;
    for (const tool of offer.tools) {
      const identity = `${tool.serverId}\0${tool.name}`;
      if (toolIdentities.has(identity)) {
        throw invalidProtocolFrame('Duplicate Client Capability tool');
      }
      toolIdentities.add(identity);
    }
  }
  if (toolCount > CLIENT_CAPABILITY_MAX_TOOLS) {
    throw invalidProtocolFrame('Too many Client Capability tools');
  }
  for (const service of services) {
    const contract = `${service.serviceId}\0${service.version}`;
    if (serviceContracts.has(contract)) {
      throw invalidProtocolFrame('Duplicate Client Capability service');
    }
    serviceContracts.add(contract);
  }
  const decoded = {
    registrationId: requireEntityId(record.registrationId, 'registrationId'),
    offers,
    ...(record.services === undefined ? {} : { services }),
  };
  if (jsonByteLength(decoded) > CLIENT_CAPABILITY_MAX_MANIFEST_BYTES) {
    throw invalidProtocolFrame('Client Capability manifest is too large');
  }
  return decoded;
}

export function decodeClientCapabilityReplaceResult(value: unknown): ClientCapabilityReplaceResult {
  const record = requireExactRecord(value, 'Client Capability replacement result', [
    'registrationId',
    'revision',
  ]);
  return {
    registrationId: requireEntityId(record.registrationId, 'registrationId'),
    revision: requireCount(record.revision, 'revision'),
  };
}

export function decodeClientCapabilityUnregisterInput(
  value: unknown,
): ClientCapabilityUnregisterInput {
  const record = requireExactRecord(value, 'Client Capability unregister input', [
    'registrationId',
  ]);
  return {
    registrationId: requireEntityId(record.registrationId, 'registrationId'),
  };
}

export function decodeClientCapabilityUnregisterResult(
  value: unknown,
): ClientCapabilityUnregisterResult {
  const record = requireExactRecord(value, 'Client Capability unregister result', [
    'registrationId',
    'revision',
  ]);
  return {
    registrationId: requireEntityId(record.registrationId, 'registrationId'),
    revision: requireCount(record.revision, 'revision'),
  };
}

export function isClientCapabilityClientFrameKind(
  value: unknown,
): value is ClientCapabilityClientFrame['kind'] {
  return (
    typeof value === 'string' &&
    CLIENT_CAPABILITY_CLIENT_FRAME_KINDS.has(value as ClientCapabilityClientFrame['kind'])
  );
}

export function isClientCapabilityHostFrameKind(
  value: unknown,
): value is ClientCapabilityHostFrame['kind'] {
  return (
    typeof value === 'string' &&
    CLIENT_CAPABILITY_HOST_FRAME_KINDS.has(value as ClientCapabilityHostFrame['kind'])
  );
}

export function decodeClientCapabilityClientFrame(value: unknown): ClientCapabilityClientFrame {
  const frame = requireRecord(value, 'Client Capability client frame');
  switch (frame.kind) {
    case 'client.capability.accepted':
      assertExactKeys(frame, 'Client Capability accepted frame', [
        'kind',
        'invocationId',
        'admissionEvidence',
      ]);
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        admissionEvidence: decodeClientCapabilityAdmissionEvidence(frame.admissionEvidence),
      };
    case 'client.capability.rejected':
    case 'client.capability.failed':
      assertExactKeys(frame, 'Client Capability failure frame', [
        'kind',
        'invocationId',
        'message',
      ]);
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        message: requireString(frame.message, 'message', 4_096),
      };
    case 'client.capability.progress': {
      assertExactKeys(frame, 'Client Capability progress frame', [
        'kind',
        'invocationId',
        'current',
        'total',
      ]);
      const current = requireCount(frame.current, 'current');
      const total = requireCount(frame.total, 'total');
      if (total === 0 || total > CLIENT_CAPABILITY_MAX_PROGRESS_TOTAL || current > total) {
        throw invalidProtocolFrame('Invalid Client Capability progress bounds');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        current,
        total,
      };
    }
    case 'client.capability.result':
      assertExactKeys(frame, 'Client Capability result frame', ['kind', 'invocationId', 'result']);
      if (jsonByteLength(frame.result) > CLIENT_CAPABILITY_INLINE_RESULT_MAX_BYTES) {
        throw invalidProtocolFrame('Client Capability inline result is too large');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        result: decodeClientCapabilityResult(frame.result),
      };
    case 'client.capability.result_start': {
      assertExactKeys(frame, 'Client Capability result start frame', [
        'kind',
        'invocationId',
        'byteLength',
        'chunkCount',
      ]);
      const byteLength = requireCount(frame.byteLength, 'byteLength');
      const chunkCount = requireCount(frame.chunkCount, 'chunkCount');
      if (
        byteLength === 0 ||
        byteLength > CLIENT_CAPABILITY_MAX_RESULT_BYTES ||
        chunkCount === 0 ||
        chunkCount > CLIENT_CAPABILITY_MAX_RESULT_CHUNKS ||
        chunkCount !== Math.ceil(byteLength / CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES)
      ) {
        throw invalidProtocolFrame('Invalid Client Capability result bounds');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        byteLength,
        chunkCount,
      };
    }
    case 'client.capability.result_chunk': {
      assertExactKeys(frame, 'Client Capability result chunk frame', [
        'kind',
        'invocationId',
        'index',
        'data',
      ]);
      const data = requireString(
        frame.data,
        'data',
        Math.ceil(CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES / 3) * 4,
      );
      if (!isCanonicalBase64(data)) {
        throw invalidProtocolFrame('Invalid Client Capability result chunk');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        index: requireCount(frame.index, 'index'),
        data,
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Client Capability client frame kind');
  }
}

function decodeClientCapabilityAdmissionEvidence(
  value: unknown,
): ClientCapabilityAdmissionEvidence {
  const evidence = requireRecord(value, 'Client Capability admission evidence');
  switch (evidence.kind) {
    case 'none':
      assertExactKeys(evidence, 'Client Capability admission evidence', ['kind']);
      return { kind: evidence.kind };
    case 'browser_url':
      assertExactKeys(evidence, 'Client Capability admission evidence', ['kind', 'url']);
      return {
        kind: evidence.kind,
        url: requireString(evidence.url, 'url', 16_384),
      };
    default:
      throw invalidProtocolFrame('Unknown Client Capability admission evidence kind');
  }
}

export function decodeClientCapabilityHostFrame(value: unknown): ClientCapabilityHostFrame {
  const frame = requireRecord(value, 'Client Capability Host frame');
  switch (frame.kind) {
    case 'client.capability.call': {
      assertOptionalExactKeys(
        frame,
        'Client Capability call frame',
        [
          'kind',
          'invocationId',
          'registrationId',
          'offerId',
          'serverId',
          'toolName',
          'arguments',
          'sessionId',
          'turnId',
          'toolCallId',
        ],
        ['cwd'],
      );
      const argumentsValue = decodeJsonRecord(frame.arguments, 'arguments');
      if (jsonByteLength(argumentsValue) > 40 * 1024) {
        throw invalidProtocolFrame('Client Capability arguments are too large');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        registrationId: requireEntityId(frame.registrationId, 'registrationId'),
        offerId: requireEntityId(frame.offerId, 'offerId'),
        serverId: requireString(frame.serverId, 'serverId', 128),
        toolName: requireString(frame.toolName, 'toolName', 128),
        arguments: argumentsValue,
        sessionId: requireEntityId(frame.sessionId, 'sessionId'),
        turnId: requireEntityId(frame.turnId, 'turnId'),
        toolCallId: requireEntityId(frame.toolCallId, 'toolCallId'),
        ...(frame.cwd === undefined ? {} : { cwd: requireString(frame.cwd, 'cwd', 4_096) }),
      };
    }
    case 'client.capability.service_call': {
      assertExactKeys(frame, 'Client Capability service call frame', [
        'kind',
        'invocationId',
        'registrationId',
        'serviceId',
        'version',
        'method',
        'input',
      ]);
      const input = decodeJsonRecord(frame.input, 'input');
      if (jsonByteLength(input) > 40 * 1024) {
        throw invalidProtocolFrame('Client Capability service input is too large');
      }
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
        registrationId: requireEntityId(frame.registrationId, 'registrationId'),
        serviceId: requireEntityId(frame.serviceId, 'serviceId'),
        version: requireString(frame.version, 'version', 64),
        method: requireEntityId(frame.method, 'method'),
        input,
      };
    }
    case 'client.capability.cancel':
    case 'client.capability.release':
    case 'client.capability.admitted':
      assertExactKeys(frame, 'Client Capability invocation control frame', [
        'kind',
        'invocationId',
      ]);
      return {
        kind: frame.kind,
        invocationId: requireEntityId(frame.invocationId, 'invocationId'),
      };
    case 'client.capability.registration_release':
      assertExactKeys(frame, 'Client Capability registration release frame', [
        'kind',
        'registrationId',
      ]);
      return {
        kind: frame.kind,
        registrationId: requireEntityId(frame.registrationId, 'registrationId'),
      };
    default:
      throw invalidProtocolFrame('Invalid Client Capability Host frame kind');
  }
}

export function decodeClientCapabilityResult(value: unknown): ClientCapabilityCallResult {
  const record = requireRecord(value, 'Client Capability result');
  assertOptionalExactKeys(record, 'Client Capability result', ['content'], ['structuredContent']);
  if (!Array.isArray(record.content) || record.content.length > 256) {
    throw invalidProtocolFrame('Invalid Client Capability result content');
  }
  const content = record.content.map(decodeContentBlock);
  return {
    content,
    ...(Object.hasOwn(record, 'structuredContent')
      ? {
          structuredContent: decodeJsonValue(record.structuredContent, 'structuredContent'),
        }
      : {}),
  };
}

function decodeClientCapabilityOffer(value: unknown): ClientCapabilityOffer {
  const record = requireRecord(value, 'Client Capability offer');
  assertOptionalExactKeys(
    record,
    'Client Capability offer',
    ['offerId', 'version', 'affinity', 'hostPathAccess', 'label', 'tools'],
    ['description'],
  );
  if (
    !Array.isArray(record.tools) ||
    record.tools.length === 0 ||
    record.tools.length > CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER
  ) {
    throw invalidProtocolFrame('Invalid Client Capability offer tools');
  }
  return {
    offerId: requireEntityId(record.offerId, 'offerId'),
    version: requireString(record.version, 'version', 64),
    affinity: decodeClientCapabilityAffinity(record.affinity),
    hostPathAccess: decodeClientCapabilityHostPathAccess(record.hostPathAccess),
    label: requireString(record.label, 'label', 128),
    ...(record.description === undefined
      ? {}
      : {
          description: requireString(record.description, 'description', 1_024),
        }),
    tools: record.tools.map(decodeToolDescriptor),
  };
}

function decodeClientCapabilityServiceOffer(value: unknown): ClientCapabilityServiceOffer {
  const record = requireExactRecord(value, 'Client Capability service offer', [
    'serviceId',
    'version',
  ]);
  return {
    serviceId: requireEntityId(record.serviceId, 'serviceId'),
    version: requireString(record.version, 'version', 64),
  };
}

function decodeClientCapabilityAffinity(value: unknown): ClientCapabilityAffinity {
  if (value === 'call' || value === 'turn' || value === 'session') return value;
  throw invalidProtocolFrame('Invalid Client Capability affinity');
}

function decodeClientCapabilityHostPathAccess(value: unknown): ClientCapabilityHostPathAccess {
  if (value === 'none' || value === 'cwd') return value;
  throw invalidProtocolFrame('Invalid Client Capability Host path access');
}

function decodeToolDescriptor(value: unknown): ClientCapabilityToolDescriptor {
  const record = requireRecord(value, 'Client Capability tool');
  assertOptionalExactKeys(
    record,
    'Client Capability tool',
    ['serverId', 'name', 'inputSchema'],
    ['description', 'annotations', 'activityKind'],
  );
  const inputSchema = decodeJsonRecord(record.inputSchema, 'inputSchema');
  if (jsonByteLength(inputSchema) > 32 * 1024) {
    throw invalidProtocolFrame('Client Capability tool schema is too large');
  }
  validateToolInputSchema(inputSchema);
  return {
    serverId: requireString(record.serverId, 'serverId', 128),
    name: requireString(record.name, 'name', 128),
    ...(record.description === undefined
      ? {}
      : {
          description: requireString(
            record.description,
            'description',
            CLIENT_CAPABILITY_TOOL_DESCRIPTION_MAX_CHARS,
          ),
        }),
    inputSchema,
    ...(record.activityKind === undefined
      ? {}
      : { activityKind: decodeToolActivityKind(record.activityKind) }),
    ...(record.annotations === undefined
      ? {}
      : { annotations: decodeToolAnnotations(record.annotations) }),
  };
}

function decodeToolActivityKind(value: unknown): ToolActivityKind {
  if (typeof value === 'string' && (TOOL_ACTIVITY_KINDS as readonly string[]).includes(value)) {
    return value as ToolActivityKind;
  }
  throw invalidProtocolFrame('Invalid Client Capability tool activity kind');
}

const CLIENT_CAPABILITY_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);
const CLIENT_CAPABILITY_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'definitions',
  'description',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'oneOf',
  'pattern',
  'propertyNames',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
]);

function validateToolInputSchema(root: Record<string, unknown>): void {
  if (!Object.hasOwn(root, 'type') || root.type !== 'object') {
    throw invalidProtocolFrame('Client Capability tool schema root must be an object');
  }
  const references: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'boolean') return;
    const schema = requireRecord(value, 'Client Capability tool schema');
    if (Object.keys(schema).some((key) => !CLIENT_CAPABILITY_SCHEMA_KEYWORDS.has(key))) {
      throw invalidProtocolFrame('Unsupported Client Capability tool schema keyword');
    }
    if (schema.type !== undefined) validateSchemaType(schema.type);
    for (const key of ['title', 'description', 'format', 'pattern'] as const) {
      if (schema[key] !== undefined && typeof schema[key] !== 'string') {
        throw invalidProtocolFrame(`Invalid Client Capability tool schema ${key}`);
      }
    }
    if (typeof schema.pattern === 'string') {
      try {
        new RegExp(schema.pattern);
      } catch {
        throw invalidProtocolFrame('Invalid Client Capability tool schema pattern');
      }
    }
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
    ] as const) {
      if (
        schema[key] !== undefined &&
        (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))
      ) {
        throw invalidProtocolFrame(`Invalid Client Capability tool schema ${key}`);
      }
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf <= 0) {
      throw invalidProtocolFrame('Invalid Client Capability tool schema multipleOf');
    }
    for (const key of [
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'minProperties',
      'maxProperties',
    ] as const) {
      if (
        schema[key] !== undefined &&
        (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0)
      ) {
        throw invalidProtocolFrame(`Invalid Client Capability tool schema ${key}`);
      }
    }
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
      throw invalidProtocolFrame('Invalid Client Capability tool schema uniqueItems');
    }
    for (const key of ['properties', '$defs', 'definitions'] as const) {
      if (schema[key] === undefined) continue;
      const entries = requireRecord(schema[key], `Client Capability tool schema ${key}`);
      for (const nested of Object.values(entries)) visit(nested);
    }
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((entry) => typeof entry !== 'string') ||
        new Set(schema.required).size !== schema.required.length
      ) {
        throw invalidProtocolFrame('Invalid Client Capability tool schema required');
      }
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean'
    ) {
      visit(schema.additionalProperties);
    }
    if (schema.propertyNames !== undefined) {
      visit(schema.propertyNames);
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        if (schema.items.length === 0) {
          throw invalidProtocolFrame('Invalid Client Capability tool schema items');
        }
        for (const nested of schema.items) visit(nested);
      } else {
        visit(schema.items);
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key]) || schema[key].length === 0) {
        throw invalidProtocolFrame(`Invalid Client Capability tool schema ${key}`);
      }
      for (const nested of schema[key]) visit(nested);
    }
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
      throw invalidProtocolFrame('Invalid Client Capability tool schema enum');
    }
    if (schema.examples !== undefined && !Array.isArray(schema.examples)) {
      throw invalidProtocolFrame('Invalid Client Capability tool schema examples');
    }
    if (schema.$ref !== undefined) {
      if (
        typeof schema.$ref !== 'string' ||
        !/^#\/(?:\$defs|definitions)(?:\/(?:[^~/]|~[01])+)+$/u.test(schema.$ref)
      ) {
        throw invalidProtocolFrame('Client Capability tool schema reference must be local');
      }
      references.push(schema.$ref);
    }
  };
  visit(root);
  for (const reference of references) {
    if (!resolveLocalSchemaReference(root, reference)) {
      throw invalidProtocolFrame('Client Capability tool schema reference is unresolved');
    }
  }
}

function validateSchemaType(value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0 ||
    values.some(
      (entry) => typeof entry !== 'string' || !CLIENT_CAPABILITY_SCHEMA_TYPES.has(entry),
    ) ||
    new Set(values).size !== values.length
  ) {
    throw invalidProtocolFrame('Invalid Client Capability tool schema type');
  }
}

function resolveLocalSchemaReference(root: Record<string, unknown>, reference: string): boolean {
  let value: unknown = root;
  for (const token of reference
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, token)
    ) {
      return false;
    }
    value = (value as Record<string, unknown>)[token];
  }
  return typeof value === 'boolean' || (value !== null && typeof value === 'object');
}

function decodeToolAnnotations(value: unknown): ClientCapabilityToolAnnotations {
  const record = requireRecord(value, 'Client Capability tool annotations');
  assertOptionalExactKeys(
    record,
    'Client Capability tool annotations',
    [],
    ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
  );
  return {
    ...(record.title === undefined ? {} : { title: requireString(record.title, 'title', 128) }),
    ...optionalBoolean(record, 'readOnlyHint'),
    ...optionalBoolean(record, 'destructiveHint'),
    ...optionalBoolean(record, 'idempotentHint'),
    ...optionalBoolean(record, 'openWorldHint'),
  };
}

function decodeContentBlock(value: unknown): ClientCapabilityContentBlock {
  const record = requireRecord(value, 'Client Capability content block');
  switch (record.type) {
    case 'text':
      assertExactKeys(record, 'Client Capability text block', ['type', 'text']);
      return {
        type: 'text',
        text: requireBoundedString(record.text, 'text', CLIENT_CAPABILITY_MAX_RESULT_BYTES),
      };
    case 'image':
    case 'audio':
      assertExactKeys(record, `Client Capability ${record.type} block`, [
        'type',
        'data',
        'mimeType',
      ]);
      const data = requireBoundedString(record.data, 'data', CLIENT_CAPABILITY_MAX_RESULT_BYTES);
      if (!isCanonicalBase64(data)) {
        throw invalidProtocolFrame(`Invalid Client Capability ${record.type} data`);
      }
      return {
        type: record.type,
        data,
        mimeType:
          record.type === 'image'
            ? requireImageMimeType(record.mimeType)
            : requireString(record.mimeType, 'mimeType', 256),
      };
    case 'resource':
      assertOptionalExactKeys(
        record,
        'Client Capability resource block',
        ['type', 'uri'],
        ['mimeType', 'text', 'blob'],
      );
      return {
        type: 'resource',
        uri: requireString(record.uri, 'uri', 4_096),
        ...(record.mimeType === undefined
          ? {}
          : { mimeType: requireString(record.mimeType, 'mimeType', 256) }),
        ...(record.text === undefined
          ? {}
          : {
              text: requireBoundedString(record.text, 'text', CLIENT_CAPABILITY_MAX_RESULT_BYTES),
            }),
        ...(record.blob === undefined
          ? {}
          : {
              blob: requireCanonicalBase64(record.blob, 'blob', CLIENT_CAPABILITY_MAX_RESULT_BYTES),
            }),
      };
    case 'resource_link':
      assertOptionalExactKeys(
        record,
        'Client Capability resource link block',
        ['type', 'uri'],
        ['name', 'description', 'mimeType'],
      );
      return {
        type: 'resource_link',
        uri: requireString(record.uri, 'uri', 4_096),
        ...(record.name === undefined ? {} : { name: requireString(record.name, 'name', 512) }),
        ...(record.description === undefined
          ? {}
          : {
              description: requireString(record.description, 'description', 4_096),
            }),
        ...(record.mimeType === undefined
          ? {}
          : { mimeType: requireString(record.mimeType, 'mimeType', 256) }),
      };
    case 'unknown':
      assertExactKeys(record, 'Client Capability unknown block', ['type', 'value']);
      return {
        type: 'unknown',
        value: decodeJsonValue(record.value, 'value'),
      };
    default:
      throw invalidProtocolFrame('Invalid Client Capability content block type');
  }
}

function decodeJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const decoded = decodeJsonValue(value, label);
  return requireRecord(decoded, label);
}

function decodeJsonValue(value: unknown, label: string): unknown {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > CLIENT_CAPABILITY_JSON_MAX_NODES || depth > CLIENT_CAPABILITY_JSON_MAX_DEPTH) {
      throw invalidProtocolFrame(`Invalid ${label}`);
    }
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return entry;
    }
    if (Array.isArray(entry)) {
      if (ancestors.has(entry)) throw invalidProtocolFrame(`Invalid ${label}`);
      ancestors.add(entry);
      try {
        return entry.map((item) => visit(item, depth + 1));
      } finally {
        ancestors.delete(entry);
      }
    }
    if (entry && typeof entry === 'object') {
      if (ancestors.has(entry)) throw invalidProtocolFrame(`Invalid ${label}`);
      ancestors.add(entry);
      const output: Record<string, unknown> = {};
      try {
        for (const [key, item] of Object.entries(entry)) {
          if (key.length === 0 || key.length > 256) throw invalidProtocolFrame(`Invalid ${label}`);
          Object.defineProperty(output, key, {
            value: visit(item, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      } finally {
        ancestors.delete(entry);
      }
      return output;
    }
    throw invalidProtocolFrame(`Invalid ${label}`);
  };
  return visit(value, 0);
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireCanonicalBase64(value: unknown, label: string, maxLength: number): string {
  const data = requireBoundedString(value, label, maxLength);
  if (!isCanonicalBase64(data)) throw invalidProtocolFrame(`Invalid ${label}`);
  return data;
}

function requireImageMimeType(value: unknown): string {
  const mimeType = requireString(value, 'mimeType', 256);
  if (!/^image\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(mimeType)) {
    throw invalidProtocolFrame('Invalid Client Capability image MIME type');
  }
  return mimeType;
}

function assertOptionalExactKeys(
  record: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: keyof ClientCapabilityToolAnnotations,
): Partial<ClientCapabilityToolAnnotations> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${key}`);
  return { [key]: value };
}

function jsonByteLength(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame('Invalid JSON value');
  }
  if (encoded === undefined) throw invalidProtocolFrame('Invalid JSON value');
  return Buffer.byteLength(encoded, 'utf8');
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

const CLIENT_CAPABILITY_CLIENT_FRAME_KINDS = new Set<ClientCapabilityClientFrame['kind']>([
  'client.capability.accepted',
  'client.capability.rejected',
  'client.capability.failed',
  'client.capability.progress',
  'client.capability.result',
  'client.capability.result_start',
  'client.capability.result_chunk',
]);

const CLIENT_CAPABILITY_HOST_FRAME_KINDS = new Set<ClientCapabilityHostFrame['kind']>([
  'client.capability.call',
  'client.capability.service_call',
  'client.capability.cancel',
  'client.capability.release',
  'client.capability.registration_release',
  'client.capability.admitted',
]);
