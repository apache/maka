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
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type {
  PrefixChangeReason,
  ToolSchemaChangeReason,
  ToolAvailabilityDiagnostic,
} from '@maka/core/usage-stats/types';
import type { ModelMessage } from './model-protocol.js';
import { toJSONSchema } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export interface CanonicalToolSet {
  providerTools: MakaTool[];
  activeTools: string[];
}

export interface RequestShapeInput {
  connection: RuntimeExecutionConnection;
  modelId: string;
  systemPrompt?: string;
  providerOptions?: Record<string, unknown>;
  providerTools: readonly MakaTool[];
  activeTools: readonly string[];
  priorMessages: readonly ModelMessage[];
  toolAvailability?: ToolAvailabilityDiagnostic;
}

export interface RequestShapeComponents {
  modelProviderHash: string;
  systemPromptHash: string;
  providerOptionsHash: string;
  toolSchemaHash: string;
  historyProjectionHash: string;
}

export type DurablePrefixComponents = Omit<RequestShapeComponents, 'historyProjectionHash'>;

export interface RequestShapeDiagnostic {
  /** Durable provider prefix shape, excluding prior-history projection. */
  prefixHash: string;
  prefixChangeReason: PrefixChangeReason;
  /** Full request shape, including prior-history projection. */
  requestShapeHash: string;
  requestShapeChangeReason: PrefixChangeReason;
  componentHashes: RequestShapeComponents;
  toolSchemaChangeReason?: ToolSchemaChangeReason;
  toolAvailability?: ToolAvailabilityDiagnostic;
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
  hash: string;
  bytes: number;
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
 * full-surface case (economy off / no gating).
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

export function computeRequestShapeDiagnostic(
  input: RequestShapeInput,
  prior: RequestShapeDiagnostic | undefined,
): RequestShapeDiagnostic {
  const componentHashes: RequestShapeComponents = {
    modelProviderHash: stableHash({
      providerId: input.connection.providerType,
      connectionSlug: input.connection.slug,
      modelId: input.modelId,
    }),
    systemPromptHash: stableHash(input.systemPrompt ?? ''),
    providerOptionsHash: stableHash(input.providerOptions ?? {}),
    toolSchemaHash: stableHash({
      activeTools: [...input.activeTools],
      // Only the provider-visible (active) subset crosses the wire, so the
      // schema hash must reflect that subset — otherwise an inactive deferred
      // tool's schema change would falsely fire `tool_schema_changed`, and a
      // load would not be distinguishable from churn.
      providerTools: providerVisibleTools(input.providerTools, input.activeTools).map(
        toolShapeForDiagnostics,
      ),
    }),
    historyProjectionHash: stableHash(input.priorMessages.map(messageShapeForHash)),
  };
  const durablePrefixComponents = durableComponents(componentHashes);
  const prefixHash = stableHash(durablePrefixComponents);
  const requestShapeHash = stableHash(componentHashes);
  const toolSchemaChangeReason = classifyToolSchemaChange(
    componentHashes,
    prior?.componentHashes,
    input.toolAvailability,
    prior?.toolAvailability,
  );
  return {
    prefixHash,
    prefixChangeReason: classifyDurablePrefixChange(
      durablePrefixComponents,
      prior ? durableComponents(prior.componentHashes) : undefined,
    ),
    requestShapeHash,
    requestShapeChangeReason: classifyRequestShapeChange(componentHashes, prior?.componentHashes),
    componentHashes,
    ...(toolSchemaChangeReason !== undefined ? { toolSchemaChangeReason } : {}),
    ...(input.toolAvailability !== undefined ? { toolAvailability: input.toolAvailability } : {}),
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
 * Capture the standardized request immediately before the provider call.
 *
 * Segment order follows the stable Maka request-prefix model used for cache
 * diagnostics: tools, system instructions, then conversation messages.
 * Provider options are retained for exact replay evidence, but are not claimed
 * to be a provider-cacheable prefix segment.
 */
export function capturePreparedProviderRequest(
  input: PreparedProviderRequestInput,
): PreparedProviderRequestCapture {
  const payload = input.requestPayload ?? {
    instructions: input.instructions,
    messages: input.messages,
    tools: input.tools ?? [],
    providerOptions: input.providerOptions ?? {},
  };
  // This is the evidence body, not the hash canonicalizer: preserve the exact
  // JSON ordering and values presented at the model-call seam.
  const serializedRequest = JSON.stringify(payload);
  const segments: PreparedRequestSegment[] = [];

  for (const [index, tool] of (input.tools ?? []).entries()) {
    segments.push(preparedSegment('tool_schema', index, tool, true, undefined, toolLabel(tool)));
  }
  if (input.instructions !== undefined) {
    const instructions = Array.isArray(input.instructions)
      ? input.instructions
      : [input.instructions];
    for (const [index, instruction] of instructions.entries()) {
      segments.push(preparedSegment('system_prompt', index, instruction, true));
    }
  }
  for (const [index, message] of input.messages.entries()) {
    const role =
      isObjectLike(message) && typeof message.role === 'string' ? message.role : undefined;
    segments.push(preparedSegment('message', index, message, true, role));
  }
  if (input.providerOptions !== undefined) {
    segments.push(preparedSegment('provider_options', 0, input.providerOptions, false));
  }

  return {
    schemaVersion: 2,
    requestHash: stableHash({
      providerId: input.providerId,
      modelId: input.modelId,
      payload,
    }),
    requestPayloadWithoutProviderOptionsHash: stableHash(
      protocolIndependentRequestPayload(payload),
    ),
    requestBytes: Buffer.byteLength(serializedRequest, 'utf8'),
    serializedRequest,
    segments,
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
  const serialized = stableStringify(value);
  return {
    kind,
    index,
    cacheable,
    hash: stableHash(value),
    bytes: Buffer.byteLength(serialized, 'utf8'),
    ...(role !== undefined ? { role } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * The tool's own name as the payload carries it.
 *
 * Read off the serialized tool rather than the registry: this capture describes
 * what crossed the wire, so a name that is not in the payload is not a name this
 * segment can claim.
 */
function toolLabel(tool: unknown): string | undefined {
  if (!isObjectLike(tool)) return undefined;
  return typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined;
}

export function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
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

function classifyDurablePrefixChange(
  current: DurablePrefixComponents,
  prior: DurablePrefixComponents | undefined,
): PrefixChangeReason {
  if (!prior) return 'first_turn';
  if (current.modelProviderHash !== prior.modelProviderHash) return 'model_or_provider_changed';
  if (current.systemPromptHash !== prior.systemPromptHash) return 'system_prompt_changed';
  if (current.toolSchemaHash !== prior.toolSchemaHash) return 'tool_schema_changed';
  if (current.providerOptionsHash !== prior.providerOptionsHash) return 'provider_options_changed';
  return 'stable';
}

function classifyRequestShapeChange(
  current: RequestShapeComponents,
  prior: RequestShapeComponents | undefined,
): PrefixChangeReason {
  if (!prior) return 'first_turn';
  if (current.modelProviderHash !== prior.modelProviderHash) return 'model_or_provider_changed';
  if (current.systemPromptHash !== prior.systemPromptHash) return 'system_prompt_changed';
  if (current.toolSchemaHash !== prior.toolSchemaHash) return 'tool_schema_changed';
  if (current.providerOptionsHash !== prior.providerOptionsHash) return 'provider_options_changed';
  if (current.historyProjectionHash !== prior.historyProjectionHash)
    return 'history_projection_changed';
  return 'stable';
}

function classifyToolSchemaChange(
  current: RequestShapeComponents,
  prior: RequestShapeComponents | undefined,
  currentAvail: ToolAvailabilityDiagnostic | undefined,
  priorAvail: ToolAvailabilityDiagnostic | undefined,
): ToolSchemaChangeReason | undefined {
  if (!prior || current.toolSchemaHash === prior.toolSchemaHash) return undefined;
  if (
    isEnabledSourceStrictSuperset(currentAvail, priorAvail) &&
    sourceCatalogStable(currentAvail, priorAvail)
  ) {
    return 'tool_source_enabled';
  }
  if (sourceStateChanged(currentAvail, priorAvail)) {
    return 'tool_source_state_changed';
  }
  return 'tool_schema_changed';
}

function isEnabledSourceStrictSuperset(
  current: ToolAvailabilityDiagnostic | undefined,
  prior: ToolAvailabilityDiagnostic | undefined,
): boolean {
  if (current?.mode !== 'economy' || prior?.mode !== 'economy') return false;
  const currentIds = new Set(current.enabledSourceIds);
  const priorIds = new Set(prior.enabledSourceIds);
  if (currentIds.size <= priorIds.size) return false;
  for (const sourceId of priorIds) {
    if (!currentIds.has(sourceId)) return false;
  }
  return true;
}

function sourceCatalogStable(
  current: ToolAvailabilityDiagnostic | undefined,
  prior: ToolAvailabilityDiagnostic | undefined,
): boolean {
  if (!current || !prior) return false;
  return (
    stableStringify(sourceCatalogShape(current)) === stableStringify(sourceCatalogShape(prior))
  );
}

function sourceStateChanged(
  current: ToolAvailabilityDiagnostic | undefined,
  prior: ToolAvailabilityDiagnostic | undefined,
): boolean {
  return stableStringify(current ?? null) !== stableStringify(prior ?? null);
}

function sourceCatalogShape(diagnostic: ToolAvailabilityDiagnostic): unknown {
  return {
    mode: diagnostic.mode,
    connectorToolName: diagnostic.connectorToolName,
    visibleToolNamesBySource: diagnostic.visibleToolNamesBySource ?? {},
  };
}

function durableComponents(components: RequestShapeComponents): DurablePrefixComponents {
  return {
    modelProviderHash: components.modelProviderHash,
    systemPromptHash: components.systemPromptHash,
    providerOptionsHash: components.providerOptionsHash,
    toolSchemaHash: components.toolSchemaHash,
  };
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

function messageShapeForHash(message: ModelMessage): unknown {
  const raw = message as unknown as { role?: unknown; content?: unknown };
  return {
    role: typeof raw.role === 'string' ? raw.role : 'unknown',
    content: contentShapeForHash(raw.content),
  };
}

function contentShapeForHash(content: unknown): unknown {
  if (typeof content === 'string') {
    return { type: 'text', chars: content.length };
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!isObjectLike(part)) return { type: typeof part };
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      return {
        type,
        ...(typeof part.toolName === 'string' ? { toolName: part.toolName } : {}),
        ...(typeof part.toolCallId === 'string' ? { toolCallId: part.toolCallId } : {}),
        ...(typeof part.text === 'string' ? { chars: part.text.length } : {}),
        ...('output' in part ? { output: payloadShapeForHash(part.output) } : {}),
      };
    });
  }
  return { type: typeof content };
}

function payloadShapeForHash(value: unknown): unknown {
  const serialized = stableStringify(value);
  return {
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    chars: serialized.length,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    hash: stableHash(value),
  };
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
