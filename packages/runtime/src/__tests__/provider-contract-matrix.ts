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

import { lookupModelRuntimeOverride, openAiAdapterApiProtocol } from '@maka/core/model-metadata';
import {
  PROVIDER_REGISTRY,
  type ProviderDefaults,
  type ProviderType,
} from '@maka/core/provider-registry';

export const PROVIDER_CONTRACT_DIMENSIONS = [
  'discovery',
  'exact-model-id',
  'tool-loop',
  'reasoning-replay',
] as const;

export type ProviderContractDimension = (typeof PROVIDER_CONTRACT_DIMENSIONS)[number];

/** The four request wires a generated cell can be executed against. */
export type ProviderContractWire =
  | 'openai-chat'
  | 'anthropic-messages'
  | 'google-generate'
  | 'cohere-v2';

/** Providers whose request wire is provider-specific (auth, headers,
 * per-model protocol) and therefore cannot be generated from the declaration. */
export const SUBSCRIPTION_WIRE_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  'openai-codex',
  'github-copilot',
]);

/**
 * The wire a provider's Runtime adapter speaks, which its `/models` endpoint
 * follows. Derived from the adapter rather than declared beside it: the two
 * cannot then disagree.
 */
export type ProviderWireProtocol = 'anthropic' | 'openai' | 'google' | 'cohere';

function wireProtocolFor(def: ProviderDefaults): ProviderWireProtocol {
  switch (def.runtimeAdapter.kind) {
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'google';
    case 'cohere':
      return 'cohere';
    case 'unavailable':
      throw new Error('an unavailable adapter has no wire');
    default:
      return 'openai';
  }
}

/** Derived expectation for a generated `discovery` cell. */
export interface ProviderContractDiscoveryPlan {
  protocol: ProviderWireProtocol;
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
  /** Field the next request must carry the replayed reasoning in. */
  replayField: 'reasoning_content' | 'reasoning';
}

export interface ProviderContractGeneratedCell {
  state: 'generated';
  /** Present for wire dimensions (`exact-model-id`, `tool-loop`, `reasoning-replay`). */
  wire?: ProviderContractWire;
  /** Present for the `discovery` dimension. */
  discovery?: ProviderContractDiscoveryPlan;
  /** Present for the `reasoning-replay` dimension. */
  reasoningReplay?: ProviderContractReasoningReplayPlan;
}

export interface ProviderContractOverrideCell {
  state: 'override';
  /** Stable `${providerType}:${dimension}` key a named hand-written test registers against. */
  overrideKey: string;
}

export type ProviderContractReverseAssertion = 'must-not-request-models-endpoint';

export interface ProviderContractNotApplicableCell {
  state: 'not-applicable';
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

function wireForProtocol(protocol: ProviderWireProtocol): ProviderContractWire {
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
    if (lookupModelRuntimeOverride(providerType, id)) return false;
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
  const adapter = def.runtimeAdapter;
  const supportsResponses =
    adapter.kind === 'openai' ||
    (adapter.kind === 'openai-compatible' && adapter.responses !== undefined);
  return (
    supportsResponses && openAiAdapterApiProtocol(modelId, providerType) === 'openai-responses'
  );
}

const EDGE_WIRE_SAMPLES: Partial<Record<ProviderType, readonly ProviderContractEdgeWireSample[]>> =
  {
    'opencode-go': [{ modelId: 'kimi-k2.7-code', wire: 'openai-chat' }],
    localai: [{ modelId: 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M', wire: 'openai-chat' }],
    'lm-studio': [
      { modelId: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF', wire: 'openai-chat' },
    ],
    'minimax-coding-plan': [{ modelId: 'MiniMax-M2.7-highspeed', wire: 'anthropic-messages' }],
    'tencent-tokenhub': [{ modelId: 'hy3-preview', wire: 'openai-chat' }],
  };

function discoveryCell(providerType: ProviderType, def: ProviderDefaults): ProviderContractCell {
  const discovery = def.modelDiscovery;
  switch (discovery.kind) {
    case 'fallback':
      return {
        state: 'not-applicable',
        reason: discovery.reason,
        reverseAssertion: 'must-not-request-models-endpoint',
      };
    case 'cloudflare':
      return {
        state: 'override',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
      };
    case 'fireworks':
      return {
        state: 'override',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
      };
    case 'cohere':
      return {
        state: 'override',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
      };
    case 'ollama':
      return {
        state: 'override',
        overrideKey: overrideKeyFor(providerType, 'discovery'),
      };
    case 'protocol':
      if (discovery.auth === 'github-copilot') {
        return {
          state: 'override',
          overrideKey: overrideKeyFor(providerType, 'discovery'),
        };
      }
      return {
        state: 'generated',
        discovery: {
          protocol: wireProtocolFor(def),
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
      reason: `${providerType} has no Runtime adapter and cannot send`,
    };
  }
  if (SUBSCRIPTION_WIRE_PROVIDER_TYPES.has(providerType)) {
    return {
      state: 'override',
      overrideKey: overrideKeyFor(providerType, dimension),
    };
  }
  if (
    def.runtimeAdapter.kind === 'openai' &&
    def.runtimeAdapter.apiProtocol === 'openai-responses'
  ) {
    return {
      state: 'override',
      overrideKey: overrideKeyFor(providerType, dimension),
    };
  }
  return { state: 'generated', wire: wireForProtocol(wireProtocolFor(def)) };
}

function reasoningReplayCell(
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractCell {
  const adapter = def.runtimeAdapter;
  if (adapter.kind === 'unavailable') {
    return {
      state: 'not-applicable',
      reason: `${providerType} has no Runtime adapter and cannot send`,
    };
  }
  if (SUBSCRIPTION_WIRE_PROVIDER_TYPES.has(providerType)) {
    return {
      state: 'override',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
    };
  }
  if (adapter.kind === 'openai-compatible' && adapter.responses !== undefined) {
    return {
      state: 'override',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
    };
  }
  if (adapter.kind === 'openai-compatible') {
    if (adapter.replayAssistantReasoningDetails === true) {
      return {
        state: 'override',
        overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
      };
    }
    return {
      state: 'generated',
      wire: 'openai-chat',
      reasoningReplay: {
        replayField: adapter.replayAssistantReasoningAs ?? 'reasoning_content',
      },
    };
  }
  if (adapter.kind === 'openai' && adapter.apiProtocol === 'openai-responses') {
    return {
      state: 'override',
      overrideKey: overrideKeyFor(providerType, 'reasoning-replay'),
    };
  }
  // Native Anthropic / OpenAI / Google / Cohere SDKs own signed reasoning replay
  // opaquely; except for the declared per-adapter Responses contracts above, the
  // Maka provider layer adds no wire transform to derive from.
  return {
    state: 'not-applicable',
    reason: 'vendor-sdk-owns-signed-reasoning-replay',
  };
}

function isRow(def: ProviderDefaults): boolean {
  return def.status === 'ready';
}

function buildProviderContractRow(
  providerType: ProviderType,
  def: ProviderDefaults,
): ProviderContractRow {
  return {
    providerType,
    sampleModelId: sampleModelIdFor(providerType, def),
    edgeWireSamples: EDGE_WIRE_SAMPLES[providerType] ?? [],
    cells: {
      discovery: discoveryCell(providerType, def),
      'exact-model-id': wireDimensionCell('exact-model-id', providerType, def),
      'tool-loop': wireDimensionCell('tool-loop', providerType, def),
      'reasoning-replay': reasoningReplayCell(providerType, def),
    },
  };
}

/** Derive the full conformance matrix plan from the live {@link PROVIDER_REGISTRY}. */
function buildProviderContractMatrixPlan(): ProviderContractMatrixPlan {
  const rows = (Object.entries(PROVIDER_REGISTRY) as Array<[ProviderType, ProviderDefaults]>)
    .filter(([, def]) => isRow(def))
    .map(([providerType, def]) => buildProviderContractRow(providerType, def));
  return { dimensions: PROVIDER_CONTRACT_DIMENSIONS, rows };
}

/** Flatten the plan into one cell per (provider, dimension), in a stable order. */
export function listProviderContractCells(
  plan: ProviderContractMatrixPlan,
): ProviderContractCell[] {
  const cells: ProviderContractCell[] = [];
  for (const row of plan.rows) {
    for (const dimension of plan.dimensions) {
      cells.push(row.cells[dimension]);
    }
  }
  return cells;
}

/** The live plan for the current registry. */
export const PROVIDER_CONTRACT_MATRIX_PLAN = buildProviderContractMatrixPlan();
