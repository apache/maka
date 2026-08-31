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

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { toJSONSchema } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export interface CanonicalToolSet {
  providerTools: MakaTool[];
  activeTools: string[];
}

export type PreparedRequestSegmentKind =
  | 'tool_schema'
  | 'system_prompt'
  | 'message'
  | 'provider_options';

export interface PreparedRequestSegment {
  kind: PreparedRequestSegmentKind;
  index: number;
  cacheable: boolean;
  /** Exact hashes may be compared; opaque hashes are diagnostic-only. */
  comparison: 'exact' | 'opaque';
  hash: string;
  bytes: number;
  /** Number of source segments represented; greater than one is an opaque remainder. */
  representedSegments?: number;
  role?: string;
  /**
   * What this segment is, when the seam can name it. Set for `tool_schema` from
   * the tool's own name, which the provider payload already carries.
   *
   * Present so a size can be acted on: "tool definitions are 40% of the prompt"
   * names no tool to remove, and every segment kind but this one is already a
   * single thing (#2323). Optional because a payload that names nothing is a
   * shape this capture still has to describe.
   */
  label?: string;
}

export interface PreparedProviderRequestInput {
  providerId: string;
  modelId: string;
  instructions?: unknown;
  messages: readonly unknown[];
  tools?: readonly unknown[];
  providerOptions?: Record<string, unknown>;
  /** Exact secret-free model-call parameters captured at the provider seam. */
  requestPayload?: unknown;
}

export interface PreparedProviderRequestCapture {
  schemaVersion: 2;
  requestHash: string;
  /** Hash of protocol-independent model-call semantics for cross-protocol comparison. */
  requestPayloadWithoutProviderOptionsHash: string;
  requestBytes: number;
  serializedRequest: string;
  segments: PreparedRequestSegment[];
}

export type PreparedRequestSegmentRef = Pick<PreparedRequestSegment, 'kind' | 'index' | 'role'>;

/**
 * Split the registry into the full dispatch set (`providerTools`) and the
 * model-visible subset (`activeTools`).
 *
 * `activeNames` is the explicit allow-list of tools to advertise this step —
 * the single source of truth computed by `ToolAvailabilityRuntime` (core +
 * ungrouped + loaded groups). A tool absent from it is withheld from
 * `activeTools` but stays in `providerTools` so it remains dispatchable once
 * its group loads. Omitting `activeNames` advertises every visible tool — the
 * full-surface case (search availability omitted).
 */
export function canonicalizeToolSet(
  tools: readonly MakaTool[],
  invalidTool: MakaTool,
  activeNames?: ReadonlySet<string>,
): CanonicalToolSet {
  const visibleTools = tools
    .filter((tool) => tool.name !== invalidTool.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  // providerTools stays the full registry (dispatch never depends on visibility).
  // activeTools is the model-visible subset the AI SDK serializes to the
  // provider, so a gated-and-unloaded schema stays off the wire.
  const activeTools = visibleTools
    .filter((tool) => activeNames === undefined || activeNames.has(tool.name))
    .map((tool) => tool.name);
  return {
    providerTools: [...visibleTools, invalidTool],
    activeTools,
  };
}

export function toolSchemaCharsForDiagnostics(
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
): number {
  return stableStringify({
    activeTools: [...activeTools],
    providerTools: providerVisibleTools(providerTools, activeTools).map(toolShapeForDiagnostics),
  }).length;
}

/**
 * Observe the standardized request at the AI SDK model-call seam.
 *
 * Segment order follows Maka's semantic request-prefix model: tools, system
 * instructions, then conversation messages. Provider options are retained for
 * exact request evidence, but are not claimed to be a provider-cacheable prefix
 * segment. None of this is presented as the provider's final wire body.
 */
export function capturePreparedProviderRequest(
  input: PreparedProviderRequestInput,
): PreparedProviderRequestCapture {
  const payload = input.requestPayload ?? {
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    messages: input.messages,
    tools: input.tools ?? [],
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
  };
  const normalizedPayload = normalizePreparedValue(payload);
  const serializedRequest = JSON.stringify(normalizedPayload.value);
  const segments: PreparedRequestSegment[] = [];
  const parts = semanticRequestParts(payload, input);

  for (const [index, tool] of parts.tools.entries()) {
    segments.push(preparedSegment('tool_schema', index, tool, true, undefined, toolLabel(tool)));
  }
  if (parts.instructions !== undefined) {
    const instructions = Array.isArray(parts.instructions)
      ? parts.instructions
      : [parts.instructions];
    for (const [index, instruction] of instructions.entries()) {
      segments.push(preparedSegment('system_prompt', index, instruction, true));
    }
  }
  for (const [index, message] of parts.messages.entries()) {
    const role =
      isObjectLike(message) && typeof message.role === 'string' ? message.role : undefined;
    segments.push(preparedSegment('message', index, message, true, role));
  }
  if (parts.providerOptions !== undefined) {
    segments.push(preparedSegment('provider_options', 0, parts.providerOptions, false));
  }

  return {
    schemaVersion: 2,
    requestHash: hashSerialized(serializedRequest),
    requestPayloadWithoutProviderOptionsHash: stableHash(
      normalizePreparedValue(protocolIndependentRequestPayload(payload)).value,
    ),
    requestBytes: Buffer.byteLength(serializedRequest, 'utf8'),
    serializedRequest,
    segments: boundPreparedRequestSegments(segments),
  };
}

const MAX_PREPARED_REQUEST_SEGMENTS = 256;
const MAX_PREPARED_REQUEST_REMAINDERS = 4;

function boundPreparedRequestSegments(
  segments: readonly PreparedRequestSegment[],
): PreparedRequestSegment[] {
  if (segments.length <= MAX_PREPARED_REQUEST_SEGMENTS) return [...segments];
  const kept = segments.slice(0, MAX_PREPARED_REQUEST_SEGMENTS - MAX_PREPARED_REQUEST_REMAINDERS);
  const remainders: PreparedRequestSegment[] = [];
  for (const segment of segments.slice(kept.length)) {
    const previous = remainders.at(-1);
    if (previous?.kind === segment.kind) {
      previous.bytes += segment.bytes;
      previous.representedSegments = (previous.representedSegments ?? 1) + 1;
      previous.hash = hashSerialized(
        JSON.stringify(['prepared-segment-remainder', previous.hash, segment.hash]),
      );
      continue;
    }
    remainders.push({
      kind: segment.kind,
      index: segment.index,
      cacheable: segment.cacheable,
      comparison: 'opaque',
      hash: hashSerialized(JSON.stringify(['prepared-segment-remainder', segment.hash])),
      bytes: segment.bytes,
      representedSegments: 1,
    });
  }
  return [...kept, ...remainders];
}

function semanticRequestParts(
  payload: unknown,
  fallback: PreparedProviderRequestInput,
): {
  instructions?: unknown;
  messages: readonly unknown[];
  tools: readonly unknown[];
  providerOptions?: Record<string, unknown>;
} {
  if (!isObjectLike(payload)) {
    return {
      ...(fallback.instructions !== undefined ? { instructions: fallback.instructions } : {}),
      messages: fallback.messages,
      tools: fallback.tools ?? [],
      ...(fallback.providerOptions !== undefined
        ? { providerOptions: fallback.providerOptions }
        : {}),
    };
  }
  const prompt = Array.isArray(payload.prompt) ? payload.prompt : undefined;
  const instructions: unknown[] = [];
  const messages: unknown[] = [];
  if (prompt) {
    for (const item of prompt) {
      const record = isObjectLike(item) ? item : undefined;
      if (record?.role === 'system') instructions.push(record.content);
      else messages.push(item);
    }
  }
  const payloadMessages = Array.isArray(payload.messages) ? payload.messages : undefined;
  const providerOptions = isPlainObject(payload.providerOptions)
    ? payload.providerOptions
    : fallback.providerOptions;
  return {
    ...(prompt
      ? instructions.length > 0
        ? { instructions }
        : {}
      : payload.instructions !== undefined
        ? { instructions: payload.instructions }
        : fallback.instructions !== undefined
          ? { instructions: fallback.instructions }
          : {}),
    messages: prompt ? messages : (payloadMessages ?? fallback.messages),
    tools: Array.isArray(payload.tools) ? payload.tools : (fallback.tools ?? []),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
}

function protocolIndependentRequestPayload(payload: unknown): unknown {
  if (!isObjectLike(payload)) return payload;
  const { providerOptions, ...shared } = payload;
  const identities: ProtocolIndependentRequestIdentities = {
    approvalIds: new Map(),
    toolCallIds: new Map(),
  };
  const reasoningEffort = protocolIndependentReasoningEffort(providerOptions);
  const protocolIndependent: Record<string, unknown> = {
    ...shared,
    ...(Array.isArray(shared.prompt)
      ? {
          prompt: shared.prompt.map((message) => withoutPromptProviderOptions(message, identities)),
        }
      : {}),
    ...(Array.isArray(shared.messages)
      ? {
          messages: shared.messages.map((message) =>
            withoutPromptProviderOptions(message, identities),
          ),
        }
      : {}),
    ...(Array.isArray(shared.tools)
      ? { tools: shared.tools.map(withoutObjectProviderOptions) }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
  const thinkingBudget = anthropicThinkingBudget(providerOptions);
  if (
    thinkingBudget === undefined ||
    !isNonNegativeSafeInteger(protocolIndependent.maxOutputTokens)
  ) {
    return protocolIndependent;
  }
  const wireOutputLimit = protocolIndependent.maxOutputTokens + thinkingBudget;
  return Number.isSafeInteger(wireOutputLimit)
    ? { ...protocolIndependent, maxOutputTokens: wireOutputLimit }
    : protocolIndependent;
}

function protocolIndependentReasoningEffort(
  providerOptions: unknown,
): string | string[] | undefined {
  if (!isObjectLike(providerOptions)) return undefined;
  const efforts = new Set<string>();
  const anthropic = providerOptions.anthropic;
  if (isObjectLike(anthropic) && typeof anthropic.effort === 'string') {
    efforts.add(anthropic.effort);
  }
  for (const namespace of Object.values(providerOptions)) {
    if (!isObjectLike(namespace)) continue;
    if (typeof namespace.reasoningEffort === 'string') efforts.add(namespace.reasoningEffort);
    if (isObjectLike(namespace.thinking) && namespace.thinking.type === 'disabled') {
      efforts.add('none');
    }
    const thinkingConfig = namespace.thinkingConfig;
    if (isObjectLike(thinkingConfig) && typeof thinkingConfig.thinkingLevel === 'string') {
      efforts.add(thinkingConfig.thinkingLevel);
    }
    if (isObjectLike(thinkingConfig) && thinkingConfig.thinkingBudget === 0) {
      efforts.add('none');
    }
    const chatTemplateKwargs = namespace.chat_template_kwargs;
    if (isObjectLike(chatTemplateKwargs) && chatTemplateKwargs.thinking === false) {
      efforts.add('none');
    }
  }
  const normalized = [...efforts].sort();
  return normalized.length > 1 ? normalized : normalized[0];
}

interface ProtocolIndependentRequestIdentities {
  approvalIds: Map<string, string>;
  toolCallIds: Map<string, string>;
}

function withoutPromptProviderOptions(
  value: unknown,
  identities: ProtocolIndependentRequestIdentities,
): unknown {
  const message = withoutObjectProviderOptions(value);
  if (!isObjectLike(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) => withoutPromptPartProviderOptions(part, identities)),
  };
}

function withoutPromptPartProviderOptions(
  value: unknown,
  identities: ProtocolIndependentRequestIdentities,
): unknown {
  const part = withoutObjectProviderOptions(value);
  if (!isObjectLike(part)) return part;
  if (part.type === 'tool-call') {
    const { providerExecuted: _providerExecuted, ...shared } = part;
    return {
      ...shared,
      toolCallId: protocolIndependentId(part.toolCallId, identities.toolCallIds, 'tool-call'),
    };
  }
  if (part.type === 'tool-approval-request') {
    const { isAutomatic: _isAutomatic, signature: _signature, ...shared } = part;
    return {
      ...shared,
      approvalId: protocolIndependentId(part.approvalId, identities.approvalIds, 'approval'),
      toolCallId: protocolIndependentId(part.toolCallId, identities.toolCallIds, 'tool-call'),
    };
  }
  if (part.type === 'tool-approval-response') {
    const { providerExecuted: _providerExecuted, ...shared } = part;
    return {
      ...shared,
      approvalId: protocolIndependentId(part.approvalId, identities.approvalIds, 'approval'),
    };
  }
  if (part.type !== 'tool-result') return part;
  const output = withoutObjectProviderOptions(part.output);
  const normalizedPart = {
    ...part,
    toolCallId: protocolIndependentId(part.toolCallId, identities.toolCallIds, 'tool-call'),
  };
  if (!isObjectLike(output) || output.type !== 'content' || !Array.isArray(output.value)) {
    return { ...normalizedPart, output };
  }
  return {
    ...normalizedPart,
    output: { ...output, value: output.value.map(withoutObjectProviderOptions) },
  };
}

function protocolIndependentId(
  value: unknown,
  identities: Map<string, string>,
  prefix: string,
): unknown {
  if (typeof value !== 'string') return value;
  const existing = identities.get(value);
  if (existing) return existing;
  const normalized = `${prefix}-${identities.size + 1}`;
  identities.set(value, normalized);
  return normalized;
}

function withoutObjectProviderOptions(value: unknown): unknown {
  if (!isObjectLike(value)) return value;
  const { providerOptions: _providerOptions, ...shared } = value;
  return shared;
}

function anthropicThinkingBudget(providerOptions: unknown): number | undefined {
  if (!isObjectLike(providerOptions)) return undefined;
  const anthropic = providerOptions.anthropic;
  if (!isObjectLike(anthropic)) return undefined;
  const thinking = anthropic.thinking;
  if (!isObjectLike(thinking) || thinking.type !== 'enabled') return undefined;
  return isNonNegativeSafeInteger(thinking.budgetTokens) ? thinking.budgetTokens : undefined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function findFirstChangedCacheableSegment(
  current: Pick<PreparedProviderRequestCapture, 'segments'>,
  prior: Pick<PreparedProviderRequestCapture, 'segments'>,
): PreparedRequestSegmentRef | undefined {
  const currentSegments = current.segments.filter((segment) => segment.cacheable);
  const priorSegments = prior.segments.filter((segment) => segment.cacheable);
  const segmentCount = Math.max(currentSegments.length, priorSegments.length);
  for (let position = 0; position < segmentCount; position += 1) {
    const currentSegment = currentSegments[position];
    const priorSegment = priorSegments[position];
    if (
      currentSegment?.kind === priorSegment?.kind &&
      currentSegment?.index === priorSegment?.index &&
      currentSegment?.hash === priorSegment?.hash
    ) {
      continue;
    }
    const changed = currentSegment ?? priorSegment;
    if (!changed) return undefined;
    return {
      kind: changed.kind,
      index: changed.index,
      ...(changed.role !== undefined ? { role: changed.role } : {}),
    };
  }
  return undefined;
}

/** The provider-visible tools — the active subset actually serialized on the wire. */
function providerVisibleTools(
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
): MakaTool[] {
  const active = new Set(activeTools);
  return providerTools.filter((tool) => active.has(tool.name));
}

function preparedSegment(
  kind: PreparedRequestSegmentKind,
  index: number,
  value: unknown,
  cacheable: boolean,
  role?: string,
  label?: string,
): PreparedRequestSegment {
  const normalized = normalizePreparedValue(value);
  const serialized = JSON.stringify(normalized.value);
  return {
    kind,
    index,
    cacheable,
    comparison: normalized.opaque || containsComparisonOpaqueRedaction(value) ? 'opaque' : 'exact',
    hash: hashSerialized(serialized),
    bytes: Buffer.byteLength(serialized, 'utf8'),
    ...(role !== undefined ? { role } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * The tool's own name as the payload carries it.
 *
 * Read off the prepared payload rather than the registry: this observation
 * describes what Maka handed to the model-call seam, so a name absent there is
 * not a name this segment can claim.
 */
function toolLabel(tool: unknown): string | undefined {
  if (!isObjectLike(tool)) return undefined;
  return typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined;
}

export function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function hashSerialized(serialized: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export function toolCatalogHash(tools: readonly MakaTool[]): `sha256:${string}` {
  return stableHash(
    [...tools]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(toolShapeForDiagnostics),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

interface NormalizedPreparedValue {
  value: unknown;
  opaque: boolean;
}

/**
 * Lossless JSON representation for the semantic values accepted by the model
 * seam. Every value is tagged, so a bigint cannot collide with a user string
 * and an undefined property cannot disappear. Values that cannot be described
 * exactly are retained as explicit opaque markers instead of pretending they
 * were equal to another request.
 */
function normalizePreparedValue(value: unknown): NormalizedPreparedValue {
  const tag = '__makaPreparedValue';
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): NormalizedPreparedValue => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return { value: current, opaque: false };
    }
    if (typeof current === 'number') {
      if (Number.isFinite(current) && !Object.is(current, -0)) {
        return { value: current, opaque: false };
      }
      const encoded = Number.isNaN(current)
        ? 'NaN'
        : current === Infinity
          ? 'Infinity'
          : current === -Infinity
            ? '-Infinity'
            : '-0';
      return { value: { [tag]: 'number', value: encoded }, opaque: false };
    }
    if (typeof current === 'bigint') {
      return { value: { [tag]: 'bigint', value: current.toString() }, opaque: false };
    }
    if (typeof current === 'undefined') {
      return { value: { [tag]: 'undefined' }, opaque: false };
    }
    if (typeof current === 'function' || typeof current === 'symbol') {
      return { value: { [tag]: 'opaque', kind: typeof current }, opaque: true };
    }
    if (typeof current !== 'object') {
      return { value: { [tag]: 'opaque', kind: typeof current }, opaque: true };
    }
    if (depth >= 64) {
      return { value: { [tag]: 'opaque', kind: 'max-depth' }, opaque: true };
    }
    if (ancestors.has(current)) {
      return { value: { [tag]: 'opaque', kind: 'cycle' }, opaque: true };
    }
    ancestors.add(current);
    try {
      if (current instanceof Date) {
        const timestamp = current.getTime();
        return {
          value: {
            [tag]: 'date',
            value: Number.isNaN(timestamp) ? 'invalid' : current.toISOString(),
          },
          opaque: false,
        };
      }
      if (current instanceof Map) {
        let opaque = false;
        const entries = [...current.entries()].map(([key, entry]) => {
          const normalizedKey = visit(key, depth + 1);
          const normalizedEntry = visit(entry, depth + 1);
          opaque ||= normalizedKey.opaque || normalizedEntry.opaque;
          return [normalizedKey.value, normalizedEntry.value];
        });
        return { value: { [tag]: 'map', entries }, opaque };
      }
      if (current instanceof Set) {
        let opaque = false;
        const entries = [...current].map((entry) => {
          const normalized = visit(entry, depth + 1);
          opaque ||= normalized.opaque;
          return normalized.value;
        });
        return { value: { [tag]: 'set', entries }, opaque };
      }
      if (Array.isArray(current)) {
        let opaque = false;
        const entries = Array.from({ length: current.length }, (_, index) => {
          if (!(index in current)) return { [tag]: 'array-hole' };
          const normalized = visit(current[index], depth + 1);
          opaque ||= normalized.opaque;
          return normalized.value;
        });
        return { value: entries, opaque };
      }
      if (isPlainObject(current)) {
        let opaque = false;
        const entries = Object.keys(current).map((key) => {
          let normalized: NormalizedPreparedValue;
          try {
            normalized = visit(current[key], depth + 1);
          } catch {
            normalized = {
              value: { [tag]: 'opaque', kind: 'unreadable-property' },
              opaque: true,
            };
          }
          opaque ||= normalized.opaque;
          return [key, normalized.value];
        });
        if (Object.hasOwn(current, tag)) {
          return { value: { [tag]: 'object', entries }, opaque };
        }
        return { value: Object.fromEntries(entries), opaque };
      }
      const toJSON = (current as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        try {
          return visit(toJSON.call(current), depth + 1);
        } catch {
          return { value: { [tag]: 'opaque', kind: 'toJSON-failed' }, opaque: true };
        }
      }
      return {
        value: {
          [tag]: 'opaque',
          kind: current.constructor?.name ?? 'non-plain-object',
        },
        opaque: true,
      };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function containsComparisonOpaqueRedaction(value: unknown, seen = new Set<object>()): boolean {
  if (!isObjectLike(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsComparisonOpaqueRedaction(entry, seen));
  }
  if (
    value.type === 'custom' &&
    value.kind === 'openai.compaction' &&
    isPlainObject(value.providerOptions) &&
    isPlainObject(value.providerOptions.openai) &&
    value.providerOptions.openai.redacted === true
  ) {
    return true;
  }
  return Object.values(value).some((entry) => containsComparisonOpaqueRedaction(entry, seen));
}

function toolShapeForDiagnostics(tool: MakaTool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schemaShapeForHash(tool.parameters),
    ...(tool.providerTool ? { providerTool: tool.providerTool } : {}),
  };
}

function schemaShapeForHash(schema: unknown): unknown {
  if (isObjectLike(schema)) {
    try {
      return stripJsonSchemaRuntimeFields(
        toJSONSchema(schema as never, {
          io: 'input',
          target: 'draft-07',
          unrepresentable: 'any',
          cycles: 'ref',
          reused: 'inline',
        }),
      );
    } catch {
      // Fall through to structural canonicalization for plain JSON-schema-like objects.
    }
  }
  return schema;
}

function stripJsonSchemaRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaRuntimeFields);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '~standard' || key === '$schema') continue;
    out[key] = stripJsonSchemaRuntimeFields(entry);
  }
  return out;
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return shouldSortArray(parentKey)
      ? items.slice().sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      : items;
  }
  if (value instanceof Date) return value.toISOString();
  if (!isObjectLike(value)) return String(value);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key], key);
  }
  return out;
}

function shouldSortArray(parentKey: string | undefined): boolean {
  return parentKey === 'required' || parentKey === 'enum';
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
