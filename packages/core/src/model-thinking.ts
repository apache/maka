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
export function deriveThinkingChoices(
  options: ThinkingOptions | undefined,
): readonly ThinkingLevel[] {
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

/**
 * The connection slice `thinkingVariantsForConnection` reads: the provider
 * type plus the per-model declarations on the connection's model list. Both
 * `LlmConnection` and `RuntimeExecutionConnection` satisfy it.
 */
export interface ThinkingDeclaringConnection {
  providerType: ProviderType;
  models?: readonly { id: string; thinkingOptions?: ThinkingOptions }[];
}

/**
 * Levels a model supports on a specific connection, in display order.
 *
 * A user declaration on the connection's model list wins over the built-in
 * catalog: the user knows what their relay's backing model is, which
 * `providerType + modelId` alone cannot say (`openai-compatible` models have
 * no catalog entry, so without a declaration every such connection would
 * report no thinking support). No declaration falls back to
 * `thinkingVariantsForModel`, preserving the current behavior for every
 * provider, model, and connection that has never been declared.
 */
export function thinkingVariantsForConnection(
  connection: ThinkingDeclaringConnection,
  modelId: string,
): readonly ThinkingLevel[] {
  const declared = connection.models?.find(
    (model) => model.id === modelId && model.thinkingOptions !== undefined,
  );
  if (declared?.thinkingOptions !== undefined) {
    return deriveThinkingChoices(declared.thinkingOptions);
  }
  return thinkingVariantsForModel(connection.providerType, modelId);
}
