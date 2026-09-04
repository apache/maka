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
 * Controllable thinking level for reasoning-capable models.
 *
 * A `ThinkingLevel` is a user-facing reasoning-depth knob. It is a per-model
 * variant: each model supports a subset of levels (declared here by
 * `thinkingVariantsForModel`), and switching models clears the choice so a
 * level is never sent to a model that does not understand it. `undefined`
 * means "no override" (the model's default behaviour) and is the only value
 * persisted-absent — the UI shows it as "默认". `'off'` explicitly disables
 * reasoning for providers that expose a true off switch (`reasoningEffort:
 * 'none'` for OpenAI gpt-5 / codex, `thinking: { type: 'disabled' }` for
 * Anthropic-protocol); providers without a clean off switch do not list it.
 *
 * The runtime maps a chosen level to the ai-sdk provider option
 * (`reasoningEffort` / `thinking.budgetTokens` / `thinkingConfig`) in
 * `buildProviderOptions`; this module owns only the vocabulary and the
 * per-model supported set, so the UI and runtime share one source of truth.
 */

import type { ProviderType } from './llm-connections.js';
import { lookupModelMetadata } from './model-metadata.js';

/**
 * Reasoning-depth variants. Ordered from shallowest to deepest for display.
 * Not every model supports every level — call `thinkingVariantsForModel` for
 * the model-specific subset.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * The levels a generic-relay declaration may hold — the vocabulary the
 * settings surfaces offer and the one the data layer admits. `off` is the
 * sole exclusion: it is not an intensity tier but a *disable* wire
 * (`reasoning_effort: 'none'`), and no generic relay is presumed to honor
 * that encoding; built-in providers that support it get `off` from their own
 * metadata instead. `minimal` and every effort tier above are pure
 * intensity values — the user declaring them is the authority on what the
 * relay accepts.
 */
export const DECLARABLE_RELAY_THINKING_LEVELS: readonly ThinkingLevel[] = THINKING_LEVELS.filter(
  (level) => level !== 'off',
);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Per-model reasoning controls, mirroring models.dev `reasoning_options` plus
 * Maka's adapter knowledge for real disabled wires. `efforts` are provider
 * native effort enum values (e.g. `none`, `low`, `high`, `xhigh`, `max`);
 * `toggle` records the catalog fact that the model has an on/off switch, but
 * UI only exposes `off` when `offBehavior` (or effort `none`) says this adapter
 * can actually send a disabled/none/budget-zero request.
 */
export type ThinkingOffBehavior =
  | 'anthropic-thinking-disabled'
  | 'cohere-thinking-disabled'
  | 'cloudflare-chat-template-thinking-false'
  | 'google-thinking-budget-zero'
  | 'volcengine-thinking-disabled';

export interface ThinkingOptions {
  readonly efforts?: readonly string[];
  readonly toggle?: boolean;
  readonly offBehavior?: ThinkingOffBehavior;
}

/**
 * Derive the user-facing thinking-level choices from a model's declared
 * `ThinkingOptions`. `none` (OpenAI's off effort) and declared `offBehavior`
 * surface as `'off'`; other effort values map to the same-named
 * `ThinkingLevel`. Raw `toggle` alone is intentionally not enough because some
 * adapters have no real disabled wire. Unknown effort values (not in
 * `ThinkingLevel`) are dropped. Returns `[]` for models with no declared
 * options (miss → no thinking menu, fallback default).
 */
function deriveThinkingChoices(options: ThinkingOptions | undefined): readonly ThinkingLevel[] {
  if (!options) return [];
  const choices = new Set<ThinkingLevel>();
  if (options.offBehavior) choices.add('off');
  for (const effort of options.efforts ?? []) {
    if (effort === 'none') choices.add('off');
    else if (isThinkingLevel(effort)) choices.add(effort);
    // Unknown effort values (not in ThinkingLevel) are dropped — add the
    // level to THINKING_LEVELS if a provider introduces a new effort tier.
  }
  return THINKING_LEVELS.filter((level) => choices.has(level));
}

/**
 * One model as declared by the user: the facts no other source can be trusted
 * to know. Every field is independent, and every ABSENT field means "Auto" —
 * the provider's /models report and the metadata chain decide. The single
 * exception in shape, not spirit, is `vision: false`: an explicit DISABLE that
 * overrides Auto, because the runtime would otherwise believe a vision report
 * the provider may emit regardless.
 *
 * Declarations live on the connection as a first-class typed field
 * (`relayModelProfiles`, keyed by model id) rather than on the `models[]` rows
 * a catalog refresh rewrites, so they sit next to the user-edited connection
 * fields and survive it.
 *
 * The name is historical, and the table now splits by FIELD rather than by
 * provider. `contextWindow` and `vision` state facts about a model: a relay's
 * models are unknown to `model-metadata.ts`, but so is any model newer than
 * the bundled snapshot on any provider, and a provider without a model-list
 * endpoint cannot describe one either. Confining those to relays left the user
 * no way to state a context window Maka had no other way to learn (#1584).
 *
 * `thinkingLevels` and `serviceTier` stay relay-only: they name wire features
 * (`reasoning_effort` tiers, priority processing) that only the
 * OpenAI-compatible relays accept. `assertProfileFieldsFitProvider` in the
 * catalog codec is the write seam that enforces it, so reads here do not
 * re-derive it; `supportsRelayFastServiceTier` below is a narrower read-side
 * question — which relay MODELS carry the tier.
 *
 * One invariant is still enforced at the store boundaries: declarations exist
 * only for models in `enabledModelIds` (disabling a model deletes its
 * declaration).
 */
export interface RelayModelProfile {
  readonly thinkingLevels?: readonly ThinkingLevel[];
  readonly vision?: boolean;
  readonly contextWindow?: number;
  /** Use OpenAI's low-latency service tier for this relay model. */
  readonly serviceTier?: 'fast';
}

export type RelayModelProfiles = Readonly<Record<string, RelayModelProfile>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRelayModelProfile(entry: unknown): RelayModelProfile | undefined {
  if (!isRecord(entry)) return undefined;
  const declared: {
    thinkingLevels?: readonly ThinkingLevel[];
    vision?: boolean;
    contextWindow?: number;
    serviceTier?: 'fast';
  } = {};
  if (Array.isArray(entry.thinkingLevels)) {
    // Declared levels are filtered to the declarable vocabulary, not merely
    // the level vocabulary: `off` is a disable-wire encoding no generic
    // relay is presumed to speak, and a declaration table has no business
    // carrying it. The codec rejects it in persisted documents for the same
    // reason; normalize silently drops it because it also sanitizes input
    // that never passed a validator (settings drafts, hand-edited tables).
    const declaredSet = new Set(
      entry.thinkingLevels.filter(
        (level): level is ThinkingLevel =>
          isThinkingLevel(level) &&
          (DECLARABLE_RELAY_THINKING_LEVELS as readonly ThinkingLevel[]).includes(level),
      ),
    );
    if (declaredSet.size > 0) {
      declared.thinkingLevels = DECLARABLE_RELAY_THINKING_LEVELS.filter((level) =>
        declaredSet.has(level),
      );
    }
  }
  if (typeof entry.vision === 'boolean') declared.vision = entry.vision;
  // Safe-integer, matching the store codec's 1..MAX_SAFE_INTEGER bound: a
  // value that normalizes here must never be rejected by the write it feeds.
  if (
    typeof entry.contextWindow === 'number' &&
    Number.isSafeInteger(entry.contextWindow) &&
    entry.contextWindow > 0
  ) {
    declared.contextWindow = entry.contextWindow;
  }
  if (entry.serviceTier === 'fast') declared.serviceTier = 'fast';
  return Object.keys(declared).length > 0 ? (declared as RelayModelProfile) : undefined;
}

/**
 * Write-side sanitation for a whole profiles table (settings drafts, config
 * imports): every entry passes the same filter the read seam applies,
 * over-long/empty model ids are dropped (the codec bounds ids the same way),
 * and the result is `undefined` when nothing usable remains so callers can
 * omit the field instead of storing an empty table. fromEntries, not
 * `table[modelId] = profile` on a `{}`: relay-supplied ids may be prototype
 * keys, and literal assignment would poison the prototype instead of storing
 * the entry.
 */
export function normalizeRelayModelProfiles(
  table: unknown,
): Record<string, RelayModelProfile> | undefined {
  if (!isRecord(table)) return undefined;
  const parsed: [string, RelayModelProfile][] = [];
  for (const [modelId, entry] of Object.entries(table)) {
    if (modelId.length === 0 || modelId.length > 512) continue;
    const declared = normalizeRelayModelProfile(entry);
    if (declared) parsed.push([modelId, declared]);
  }
  return parsed.length > 0 ? Object.fromEntries(parsed) : undefined;
}

/**
 * Restore the `keys(profiles) ⊆ enabledModelIds` invariant after a selection
 * change that left the table untouched: profiles for models the user just
 * disabled are dropped rather than kept stale. Returns `undefined` for an
 * empty remainder so the recycled state reads as "no profiles", never "{}".
 */
export function pruneRelayModelProfiles(
  table: RelayModelProfiles | undefined,
  enabledModelIds: readonly string[],
): RelayModelProfiles | undefined {
  if (table === undefined) return undefined;
  const kept = Object.fromEntries(
    Object.entries(table).filter(([modelId]) => enabledModelIds.includes(modelId)),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Minimal connection shape the connection-aware helpers below need. Kept
 * structural so callers holding either `LlmConnection` or a partial view can
 * pass it through without widening runtime connection types.
 */
export interface ConnectionThinkingContext {
  readonly providerType: ProviderType;
  readonly relayModelProfiles?: RelayModelProfiles;
}

/**
 * The one read seam for user declarations: thinking, vision, and context
 * window reads all enter through here, so the precedence of a declaration over
 * the metadata chain is decided in exactly one place. Entries ride through
 * `normalizeRelayModelProfile` so even a hand-edited local file degrades to
 * Auto instead of trusting a malformed field.
 */
export function relayModelProfile(
  connection: ConnectionThinkingContext,
  modelId: string,
): RelayModelProfile | undefined {
  return normalizeRelayModelProfile(connection.relayModelProfiles?.[modelId]);
}

/** The connection fields the declared-window rule reads; structural so runtime and UI projections both fit. */
export interface DeclaredContextWindowContext extends ConnectionThinkingContext {
  readonly models?: readonly {
    readonly id: string;
    readonly contextWindow?: number;
    readonly inputLimit?: number;
    readonly factOverriddenFields?: readonly string[];
  }[];
}

/**
 * The context window the USER declared for a model — the Maka window: the
 * proactive compaction target, and nothing else. Exactly two sources count as
 * a declaration: a model-facts pin (`factOverriddenFields` includes
 * `contextWindow`, narrowest of window/input limit) and a relay model profile.
 * A provider's `/models` report and generated metadata describe the model and
 * are shown as a hint; they never become a threshold on their own. This is the
 * single owner of that rule for runtime and UI (#4559).
 */
export function declaredContextWindow(
  connection: DeclaredContextWindowContext,
  modelId: string,
): number | undefined {
  const model = connection.models?.find((candidate) => candidate.id === modelId);
  if (model?.factOverriddenFields?.includes('contextWindow')) {
    const values = [model.contextWindow, model.inputLimit].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
    return values.length > 0 ? Math.min(...values) : undefined;
  }
  return relayModelProfile(connection, modelId)?.contextWindow;
}

/**
 * Mirrors @ai-sdk/openai@4.0.42 priority-processing detection. The UI and
 * runtime share this gate so a saved Fast declaration always reaches the wire.
 */
export function supportsRelayFastServiceTier(providerType: ProviderType, modelId: string): boolean {
  if (providerType !== 'openai-responses-compatible') return false;
  const oSeriesVersion = /^o(\d+)(?:-|$)/.exec(modelId)?.[1];
  const gptMatch = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(modelId);
  const gptMajor = gptMatch?.[1] === undefined ? undefined : Number(gptMatch[1]);
  const gptVariant = gptMatch?.[3];
  const isGptNanoModel = gptVariant?.startsWith('nano') ?? false;
  const isGptChatModel = gptVariant?.startsWith('chat') ?? false;
  return (
    modelId.startsWith('gpt-4') ||
    (gptMajor !== undefined && gptMajor >= 5 && !isGptNanoModel && !isGptChatModel) ||
    (oSeriesVersion !== undefined && Number(oSeriesVersion) >= 3)
  );
}

/**
 * OpenAI-compatible relay connections declare thinking support **per model** via
 * `relayModelProfiles[modelId].thinkingLevels` — a relay may front a
 * DeepSeek-family reasoner and a plain instruct model side by side, so the
 * declaration granularity is the model, not the connection. Without a usable
 * declaration for that model every provider (including relays) falls through
 * to the metadata-derived variants.
 */
export function thinkingVariantsForConnection(
  connection: ConnectionThinkingContext,
  modelId: string,
): readonly ThinkingLevel[] {
  const declared = relayModelProfile(connection, modelId)?.thinkingLevels;
  if (declared) return declared;
  return thinkingVariantsForModel(connection.providerType, modelId);
}

/**
 * Discard-semantics gate: returns the level when the model offers it,
 * `undefined` otherwise. Callers that must *reject* a bad level (IPC/session
 * boundaries with an error channel) keep their own `includes` branch — the
 * distinction between "silently drop" and "tell the caller" is the policy of
 * the call site, not of this helper.
 */
export function resolveThinkingLevel(
  connection: ConnectionThinkingContext,
  modelId: string,
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  return level !== undefined && thinkingVariantsForConnection(connection, modelId).includes(level)
    ? level
    : undefined;
}

/**
 * Per-model reasoning options declared in `model-metadata.ts`
 * (mirroring models.dev `reasoning_options`). Returns `undefined` for models
 * with no declared options (miss → `thinkingVariantsForModel` returns `[]`).
 */
export function thinkingOptionsForModel(
  providerType: ProviderType,
  modelId: string,
): ThinkingOptions | undefined {
  return lookupModelMetadata(providerType, modelId).thinkingOptions;
}

/**
 * Levels a model supports, in display order. Returns an empty list for
 * non-reasoning models and for provider/model combinations whose reasoning
 * support is not declarable from `providerType` + `modelId` alone (e.g.
 * `openai-compatible`, where the backing model is user-configured and
 * unknown). The UI hides the thinking switcher when this returns `[]`.
 *
 * Heuristics are intentionally conservative: only patterns known to accept the
 * mapped provider option are listed. Refine here as provider support grows —
 * this is the single place that decides which models expose the knob.
 */
export function thinkingVariantsForModel(
  providerType: ProviderType,
  modelId: string,
): readonly ThinkingLevel[] {
  return deriveThinkingChoices(thinkingOptionsForModel(providerType, modelId));
}
