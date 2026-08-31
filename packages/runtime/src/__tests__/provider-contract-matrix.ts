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

/**
 * Provider conformance matrix — a registry-driven plan.
 *
 * Conformance is the interpreted execution of what `providerRegistry`
 * *declares*. This module derives, for every ready provider and every contract
 * dimension, one of three states:
 *
 *   - `generated`      the expectation is fully recoverable from the declaration
 *                      (protocol, runtime adapter, model discovery), so a
 *                      parametric wire test can stand in for a hand-written one.
 *   - `override`       the declaration proves the dimension exists but its
 *                      contract is provider-specific and cannot be recovered
 *                      generically; a named hand-written test owns it.
 *   - `not-applicable` the declaration proves the dimension does not apply, with
 *                      a machine-readable reason (and, where useful, a reverse
 *                      assertion the executor must still hold).
 *
 * The row set is discovered from the registry, never a hard-coded provider list:
 * every `status: 'ready'` entry whose runtime adapter is wired (i.e. not
 * `unavailable`) is a row. Crucially this is *not* `READY_PROVIDER_TYPES`, whose
 * membership is "has a `readyOrder`" and would silently drop `github-copilot`
 * (ready, but intentionally without a `readyOrder`).
 *
 * Pure: no IO, no network, no clock. Given the registry it is a total function.
 */

import { lookupModelProviderOverride, openAiAdapterApiProtocol } from '@maka/core/model-metadata';
import {
  PROVIDER_REGISTRY,
  type ProviderDefaults,
  type ProviderModelDiscovery,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from '@maka/core/provider-registry';
import { resolveRuntimeProviderAdapter } from '../provider-runtime-policy.js';

export const PROVIDER_CONTRACT_DIMENSIONS = [
  'discovery',
  'exact-model-id',
  'tool-loop',
  'reasoning-replay',
] as const;

export type ProviderContractDimension = (typeof PROVIDER_CONTRACT_DIMENSIONS)[number];

export type ProviderContractCellState = 'generated' | 'override' | 'not-applicable';

/** The four request wires a generated cell can be executed against. */
export type ProviderContractWire =
  | 'openai-chat'
  | 'anthropic-messages'
  | 'google-generate'
  | 'cohere-v2';

/** Runtime-adapter kinds whose request wire is provider-specific (auth, headers,
 * per-model protocol) and therefore cannot be generated from the declaration. */
export const SUBSCRIPTION_WIRE_ADAPTER_KINDS: ReadonlySet<ProviderRuntimeAdapter['kind']> = new Set(
  ['openai-codex', 'github-copilot'],
);

/** Derived expectation for a generated `discovery` cell. */
export interface ProviderContractDiscoveryPlan {
  protocol: ProviderDefaults['protocol'];
  /**
   * How the discovery request carries (or omits) a credential:
   *   - `none`     the request must carry no credential — a public model list, or
   *                a provider with no credential to send (`authKind: 'none'`).
   *   - `default`  the request must carry the provider's credential (`api_key`).
   *   - `optional` the credential is user-optional (`authKind: 'optional_api_key'`):
   *                the request carries it when a key is configured and omits it
   *                entirely when none is, so both branches must be exercised.
   */
  auth: 'default' | 'none' | 'optional';
  path?: string;
  query?: Readonly<Record<string, string>>;
  responseShape?: 'array-or-data';
  filter?: 'fallback-models' | 'language-models' | 'tool-capable';
}

/** Derived expectation for a generated `reasoning-replay` cell. */
export interface ProviderContractReasoningReplayPlan {
  /** Field the upstream response carries reasoning in. */
  sourceField: 'reasoning_content';
  /** Field the next request must carry the replayed reasoning in. */
  replayField: 'reasoning_content' | 'reasoning';
}

export interface ProviderContractGeneratedCell {
  state: 'generated';
  dimension: ProviderContractDimension;
  /** Present for wire dimensions (`exact-model-id`, `tool-loop`, `reasoning-replay`). */
  wire?: ProviderContractWire;
  /** Present for the `discovery` dimension. */
  discovery?: ProviderContractDiscoveryPlan;
  /** Present for the `reasoning-replay` dimension. */
  reasoningReplay?: ProviderContractReasoningReplayPlan;
}

export interface ProviderContractOverrideCell {
  state: 'override';
  dimension: ProviderContractDimension;
  /** Stable `${providerType}:${dimension}` key a named hand-written test registers against. */
  overrideKey: string;
  /** Human-readable statement of the provider-specific contract the override owns. */
  contract: string;
}

export type ProviderContractReverseAssertion = 'must-not-request-models-endpoint';

export interface ProviderContractNotApplicableCell {
  state: 'not-applicable';
  dimension: ProviderContractDimension;
  /** Human-readable justification derived from the provider declaration. */
  reason: string;
  /** An assertion the executor must still hold even though the dimension is N/A. */
  reverseAssertion?: ProviderContractReverseAssertion;
}

export type ProviderContractCell =
  | ProviderContractGeneratedCell
  | ProviderContractOverrideCell
  | ProviderContractNotApplicableCell;

/**
 * A declared edge-shaped model id the generated wire must also carry verbatim
 * (exact-model-id + tool-loop), with the wire resolved per id through the same
 * seams the runtime uses (per-model provider overrides, then the adapter's
 * declared protocol).
 */
export interface ProviderContractEdgeWireSample {
  modelId: string;
  wire: ProviderContractWire;
}

export interface ProviderContractRow {
  providerType: ProviderType;
  protocol: ProviderDefaults['protocol'];
  adapterKind: ProviderRuntimeAdapter['kind'];
  discoveryKind: ProviderModelDiscovery['kind'];
  /** Deterministic model id generated cells drive through discovery and the wire. */
  sampleModelId: string;
  /** Declared edge-shaped ids the wire executor drives in addition to {@link sampleModelId}. */
  edgeWireSamples: readonly ProviderContractEdgeWireSample[];
  cells: Record<ProviderContractDimension, ProviderContractCell>;
}

export interface ProviderContractMatrixPlan {
  dimensions: readonly ProviderContractDimension[];
  rows: ProviderContractRow[];
}

const SYNTHETIC_SAMPLE_MODEL_ID = 'conformance-sample-model';

function overrideKeyFor(providerType: ProviderType, dimension: ProviderContractDimension): string {
  return `${providerType}:${dimension}`;
}

function wireForProtocol(protocol: ProviderDefaults['protocol']): ProviderContractWire {
  switch (protocol) {
    case 'openai':
      return 'openai-chat';
    case 'anthropic':
      return 'anthropic-messages';
    case 'google':
      return 'google-generate';
    case 'cohere':
      return 'cohere-v2';
  }
}

/**
 * The generated wire tests the provider's *declared default* wire, so the sample
 * model id must not divert to another one:
 *
 *   - a model carrying a per-model provider override (models.dev `npm`/`api`)
 *     resolves to a different adapter/protocol at runtime (e.g. OpenCode routes
 *     `gpt-5*` to the OpenAI Responses wire); that per-model contract is owned by
 *     a hand-written test, not this generated default-wire cell.
 *   - the native OpenAI adapter routes `gpt-5*` to the Responses API by id shape.
 *
 * The first fallback model that survives both filters is the most faithful
 * choice — a real, exact id that also sits in any `fallback-models` discovery
 * allowlist. Providers with no such model fall back to a synthetic id.
 */
function sampleModelIdFor(providerType: ProviderType, def: ProviderDefaults): string {
  const usesDefaultWire = (id: string): boolean => {
    if (lookupModelProviderOverride(providerType, id)) return false;
    if (usesOpenAiResponsesWire(providerType, def, id)) return false;
    return true;
  };
  return def.fallbackModels.find(usesDefaultWire) ?? SYNTHETIC_SAMPLE_MODEL_ID;
}

function usesOpenAiResponsesWire(
  providerType: ProviderType,
  def: ProviderDefaults,
  modelId: string,
): boolean {
  const adapter = resolveRuntimeProviderAdapter(def.runtimeAdapter);
  const supportsResponses =
    adapter.kind === 'openai' ||
    (adapter.kind === 'openai-compatible' && adapter.responses !== undefined);
  return (
    supportsResponses && openAiAdapterApiProtocol(modelId, providerType) === 'openai-responses'
  );
}

/**
 * Edge-shaped model ids each provider's account surface can really serve —
 * slashes, dots, colon-suffixed quantization/cloud tags, vendor casing — that
 * the plain first-fallback sample does not exercise. The generated wire
 * executor drives every declared id end-to-end (exact-model-id + tool-loop) on
 * the wire resolved for that id, proving exact-id preservation is not an
 * artifact of simple ids. Future providers enter by declaration alone.
 */
const EDGE_WIRE_SAMPLE_MODEL_IDS: Partial<Record<ProviderType, readonly string[]>> = {
  'opencode-go': ['kimi-k2.7-code'],
  localai: ['localai/Qwen3-8B-Instruct-GGUF:Q4_K_M'],
  'lm-studio': ['lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF'],
  'minimax-coding-plan': ['MiniMax-M2.7-highspeed'],
  'tencent-tokenhub': ['hy3-preview'],
};

/**
 * Resolve the wire a declared edge id executes on, mirroring the runtime's
 * per-model resolution order: a models.dev per-model override wins, then the
 * native OpenAI adapter's declared per-id protocol, then the provider's
 * default protocol wire. Ids that resolve outside the four executable wires
 * (e.g. OpenAI Responses) must be owned by a named override instead of an edge
 * declaration; declaring one here is a plan-construction error.
 */
function edgeWireSamplesFor(
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractEdgeWireSample[] {
  return (EDGE_WIRE_SAMPLE_MODEL_IDS[providerType] ?? []).map((modelId) => {
    const override = lookupModelProviderOverride(providerType, modelId);
    if (override) {
      switch (override.npm) {
        case '@ai-sdk/anthropic':
          return { modelId, wire: 'anthropic-messages' as const };
        case '@ai-sdk/google':
          return { modelId, wire: 'google-generate' as const };
        case '@ai-sdk/openai-compatible':
          return { modelId, wire: 'openai-chat' as const };
        default:
          throw new Error(
            `edge wire sample ${providerType}/${modelId} resolves to ${override.npm}, which has no ` +
              'generated wire; own it with a named override binding instead of an edge declaration',
          );
      }
    }
    if (usesOpenAiResponsesWire(providerType, def, modelId)) {
      throw new Error(
        `edge wire sample ${providerType}/${modelId} routes to the OpenAI Responses wire, which has no ` +
          'generated executor; own it with a named override binding instead of an edge declaration',
      );
    }
    return { modelId, wire: wireForProtocol(def.protocol) };
  });
}

function discoveryCell(providerType: ProviderType, def: ProviderDefaults): ProviderContractCell {
  const discovery = def.modelDiscovery;
  switch (discovery.kind) {
    case 'fallback':
      return {
        state: 'not-applicable',
        dimension: 'discovery',
        reason: discovery.reason,
        reverseAssertion: 'must-not-request-models-endpoint',
      };
    case 'cloudflare':
      return {
        state: 'override',
        dimension: 'discovery',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
        contract: 'Cloudflare Workers AI native paginated /ai/models/search discovery',
      };
    case 'fireworks':
      return {
        state: 'override',
        dimension: 'discovery',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
        contract: 'Fireworks account pagination discovery over /v1/accounts + per-account /models',
      };
    case 'cohere':
      return {
        state: 'override',
        dimension: 'discovery',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
        contract: 'Cohere native V2 paginated /v1/models discovery (endpoint=chat)',
      };
    case 'ollama':
      return {
        state: 'override',
        dimension: 'discovery',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
        contract: 'Ollama native /api/tags discovery',
      };
    case 'protocol':
      if (discovery.auth === 'github-copilot') {
        return {
          state: 'override',
          dimension: 'discovery',
          overrideKey: overrideKeyFor(providerType, 'discovery'),
          contract: 'GitHub Copilot subscription /models discovery (picker + endpoint gating)',
        };
      }
      return {
        state: 'generated',
        dimension: 'discovery',
        discovery: {
          protocol: def.protocol,
          auth:
            discovery.auth === 'none' || def.authKind === 'none'
              ? 'none'
              : def.authKind === 'optional_api_key'
                ? 'optional'
                : 'default',
          ...(discovery.path !== undefined ? { path: discovery.path } : {}),
          ...(discovery.query !== undefined ? { query: discovery.query } : {}),
          ...(discovery.responseShape !== undefined
            ? { responseShape: discovery.responseShape }
            : {}),
          ...(discovery.filter !== undefined ? { filter: discovery.filter } : {}),
        },
      };
  }
}

function wireDimensionCell(
  dimension: 'exact-model-id' | 'tool-loop',
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractCell {
  // Ahead of every generated branch: an unavailable adapter has no wire, so
  // falling through would state an `anthropic-messages` contract for a provider
  // that cannot send at all.
  if (def.runtimeAdapter.kind === 'unavailable') {
    return {
      state: 'not-applicable',
      dimension,
      reason: `${providerType} has no Runtime adapter and cannot send`,
    };
  }
  if (SUBSCRIPTION_WIRE_ADAPTER_KINDS.has(def.runtimeAdapter.kind)) {
    return {
      state: 'override',
      dimension,
      overrideKey: overrideKeyFor(providerType, dimension),
      contract: `${def.runtimeAdapter.kind} subscription wire is provider-specific (per-model protocol, headers, auth)`,
    };
  }
  if (
    def.runtimeAdapter.kind === 'openai' &&
    def.runtimeAdapter.apiProtocol === 'openai-responses'
  ) {
    return {
      state: 'override',
      dimension,
      overrideKey: overrideKeyFor(providerType, dimension),
      contract:
        'OpenAI Responses relay wire is provider-specific until the matrix has a generated Responses executor',
    };
  }
  return { state: 'generated', dimension, wire: wireForProtocol(def.protocol) };
}

function reasoningReplayCell(
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractCell {
  const adapter = resolveRuntimeProviderAdapter(def.runtimeAdapter);
  if (adapter.kind === 'unavailable') {
    return {
      state: 'not-applicable',
      dimension: 'reasoning-replay',
      reason: `${providerType} has no Runtime adapter and cannot send`,
    };
  }
  if (SUBSCRIPTION_WIRE_ADAPTER_KINDS.has(adapter.kind)) {
    return {
      state: 'override',
      dimension: 'reasoning-replay',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
      contract: `${adapter.kind} replays reasoning on its provider-specific per-model wire`,
    };
  }
  if (adapter.kind === 'openai-compatible' && adapter.responses !== undefined) {
    return {
      state: 'override',
      dimension: 'reasoning-replay',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
      contract:
        'The explicitly declared Responses adapter owns its provider-specific continuation representation',
    };
  }
  if (adapter.kind === 'openai-compatible') {
    if (adapter.replayAssistantReasoningDetails === true) {
      return {
        state: 'override',
        dimension: 'reasoning-replay',
        overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
        contract:
          'Signed reasoning_details are replayed byte-for-byte (ZenMux), beyond a plain field rename',
      };
    }
    return {
      state: 'generated',
      dimension: 'reasoning-replay',
      wire: 'openai-chat',
      reasoningReplay: {
        sourceField: 'reasoning_content',
        replayField: adapter.replayAssistantReasoningAs ?? 'reasoning_content',
      },
    };
  }
  if (adapter.kind === 'openai' && adapter.apiProtocol === 'openai-responses') {
    return {
      state: 'override',
      dimension: 'reasoning-replay',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
      contract: 'Native OpenAI Responses reasoning items retain their provider continuation state',
    };
  }
  // Native Anthropic / OpenAI / Google / Cohere SDKs own signed reasoning replay
  // opaquely; except for the stateless Agent Plan contract above, the Maka
  // provider layer adds no wire transform to derive from.
  return {
    state: 'not-applicable',
    dimension: 'reasoning-replay',
    reason: 'vendor-sdk-owns-signed-reasoning-replay',
  };
}

function isRow(def: ProviderDefaults): boolean {
  return def.status === 'ready';
}

export function buildProviderContractRow(
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractRow {
  return {
    providerType,
    protocol: def.protocol,
    adapterKind: def.runtimeAdapter.kind,
    discoveryKind: def.modelDiscovery.kind,
    sampleModelId: sampleModelIdFor(providerType, def),
    edgeWireSamples: edgeWireSamplesFor(providerType, def),
    cells: {
      discovery: discoveryCell(providerType, def),
      'exact-model-id': wireDimensionCell('exact-model-id', providerType, def),
      'tool-loop': wireDimensionCell('tool-loop', providerType, def),
      'reasoning-replay': reasoningReplayCell(providerType, def),
    },
  };
}

/**
 * Derive the full conformance matrix plan from a provider registry. Defaults to
 * the live {@link PROVIDER_REGISTRY}; accepts an explicit registry so tests can
 * probe the derivation with fixtures.
 */
export function buildProviderContractMatrixPlan(
  registry: Readonly<Record<string, ProviderDefaults>> = PROVIDER_REGISTRY,
): ProviderContractMatrixPlan {
  const rows = (Object.entries(registry) as Array<[ProviderType, ProviderDefaults]>)
    .filter(([, def]) => isRow(def))
    .map(([providerType, def]) => buildProviderContractRow(providerType, def));
  return { dimensions: PROVIDER_CONTRACT_DIMENSIONS, rows };
}

/** A single (provider, dimension) coordinate flattened from the plan. */
export interface ProviderContractCellEntry {
  providerType: ProviderType;
  dimension: ProviderContractDimension;
  cell: ProviderContractCell;
  row: ProviderContractRow;
}

/** Flatten the plan into one entry per (provider, dimension) cell, in a stable order. */
export function listProviderContractCells(
  plan: ProviderContractMatrixPlan,
): ProviderContractCellEntry[] {
  const entries: ProviderContractCellEntry[] = [];
  for (const row of plan.rows) {
    for (const dimension of plan.dimensions) {
      entries.push({ providerType: row.providerType, dimension, cell: row.cells[dimension], row });
    }
  }
  return entries;
}

/** The live plan for the current registry. */
export const PROVIDER_CONTRACT_MATRIX_PLAN = buildProviderContractMatrixPlan();
