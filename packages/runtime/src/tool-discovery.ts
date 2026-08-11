/**
 * Provider-native Tool Search — discovery policy and lowering contract.
 *
 * maka-agent/maka-agent#1382 (slice 1): establish a Maka-owned discovery
 * policy on the tool catalog plus a provider-native lowering contract that the
 * `ModelAdapter` (#1381 seam) lowers to Anthropic / OpenAI native Tool Search,
 * with a deterministic fallback to the existing `load_tools` economy
 * (`ToolAvailabilityRuntime`) when a provider or model has no native search.
 *
 * This module owns the *contract*, not the live `streamText` wiring. It is
 * deliberately pure and provider-package-free so it is fully unit-testable
 * without importing `@ai-sdk/anthropic` / `@ai-sdk/openai`. A follow-up slice
 * consumes {@link lowerToolsForProvider} inside the backend's tool-assembly
 * point, expands the {@link NativeSearchToolDescriptor} into the real
 * provider-executed search tool, and adjusts the execute-boundary visibility
 * guard + durable replay so a provider-loaded tool still crosses
 * `ToolRuntime`. That wiring is out of scope for the seam.
 *
 * Per the RFC:
 * - One authoritative catalog. A provider search result only *selects* catalog
 *   entries; it never grants permission and never introduces an unknown
 *   schema. The policy is owned by Maka, not by a provider adapter.
 * - Tool Search changes visibility, not authorization. Every loaded tool still
 *   runs through `ToolRuntime`.
 * - Unsupported models keep the current deterministic behavior — they receive
 *   the full surface (the existing `load_tools` economy governs deferral), never
 *   a partially deferred catalog they cannot load.
 */

import type { MakaTool } from './tool-runtime.js';

/**
 * Maka-owned discovery metadata for one catalog entry. Extends the catalog
 * model rather than duplicating it: a tool is either immediately visible
 * (`direct`) or withheld until the model searches for it (`deferred`), grouped
 * under a namespace the provider advertises as one short description instead of
 * every member's full schema.
 *
 * This is the illustrative `ToolDiscovery` from the RFC. The live catalog
 * types (`CatalogToolDef` / `CatalogSurfaceDef` in `@maka/core/tool-catalog`)
 * are extended by *deriving* a policy from them (see
 * {@link buildToolDiscoveryPolicy}), not by adding a parallel field set — the
 * product catalog stays the single authority for product tools.
 */
export type ToolDiscovery =
  | { mode: 'direct' }
  | { mode: 'deferred'; namespace: string; namespaceDescription: string };

/** Per-tool discovery policy keyed by canonical tool name. */
export type ToolDiscoveryPolicy = ReadonlyMap<string, ToolDiscovery>;

/**
 * Which native Tool Search path a resolved model supports, derived from the
 * `ModelAdapter`-resolved provider runtime adapter kind and model id. `none`
 * means the existing `load_tools` economy is the fallback and the lowerer is a
 * no-op.
 */
export type ProviderToolSearchCapability = 'anthropic' | 'openai' | 'none';

/** Anthropic server-side search variant. Default: BM25 (natural language). */
export type AnthropicSearchVariant = 'bm25' | 'regex';

/** The native search tool the adapter expands for the active provider. */
export type NativeSearchToolKind = 'anthropic-bm25' | 'anthropic-regex' | 'openai';

/**
 * Provider-agnostic descriptor for the native search tool. The adapter
 * translates this into the real provider-executed tool
 * (`@ai-sdk/anthropic` `toolSearchBm25_20251119` / `toolSearchRegex_20251119`,
 * or `@ai-sdk/openai` `toolSearch`) at the streamText call site.
 */
export interface NativeSearchToolDescriptor {
  /** Canonical tool name the model calls to search. */
  name: string;
  kind: NativeSearchToolKind;
  /** One-line model-facing description of the search tool. */
  description: string;
}

/**
 * One provider-visible tool entry after lowering. Mirrors the shape the AI SDK
 * `tools` dict takes (name + description + input schema + per-tool
 * `providerOptions`), with the Maka-owned defer/namespace markers that the
 * adapter lowers to provider-native `deferLoading` / `namespace`.
 *
 * `namespace` and `namespaceDescription` are carried together so the adapter
 * can construct the full OpenAI `providerOptions.openai.namespace` payload
 * (`{ name, description }`) the SDK requires for namespace grouping.
 */
export interface LoweredToolEntry {
  name: string;
  description: string;
  /** Passthrough of `MakaTool.parameters` (zod / jsonSchema). */
  parameters: unknown;
  /** True when this entry is withheld from the initial model context. */
  deferLoading?: boolean;
  /** Namespace grouping name (OpenAI functions / namespaces). */
  namespace?: string;
  /** Human-readable description for the namespace group (OpenAI `description`). */
  namespaceDescription?: string;
}

/**
 * The full provider-native lowering result. The backend's tool-assembly point
 * consumes this to build the `streamText` `tools` dict and `activeTools`.
 *
 * - `mode: 'none'` → fallback: `tools` carries every entry as direct, no search
 *   tool, `activeTools` lists every name. Identical to today's full surface;
 *   the existing `ToolAvailabilityRuntime` economy continues to own deferral.
 * - `mode: 'anthropic' | 'openai'` → native: deferred entries carry
 *   `deferLoading` (and `namespace` + `namespaceDescription` for OpenAI), remain
 *   in `activeTools` so the AI SDK `tools` dict keeps them (the `deferLoading`
 *   flag hides them from the initial model context), and a `searchTool` is
 *   added and kept active.
 */
export interface LoweredProviderToolPayload {
  mode: ProviderToolSearchCapability;
  /** Every provider-visible tool entry (direct + deferred + search tool when native). */
  tools: LoweredToolEntry[];
  /**
   * Tool names the provider receives. In native mode this includes deferred
   * tools (kept via the `deferLoading` flag, not omitted) plus the search tool.
   * AI SDK 7 treats `activeTools` as an allowlist — an omitted tool is stripped
   * from the `tools` dict entirely — so deferred tools MUST remain listed to
   * ensure the provider adapter receives their schema + `deferLoading` flag.
   */
  activeTools: string[];
  /** The native search tool descriptor; undefined in fallback mode. */
  searchTool?: NativeSearchToolDescriptor;
  /** Deferred tool names (direct mode excluded), for diagnostics / guard wiring. */
  deferredToolNames: string[];
}

/** Canonical name of the provider-native tool-search tool Maka advertises. */
export const NATIVE_TOOL_SEARCH_NAME = 'tool_search';

/** Model-facing description for the native search tool. */
export const NATIVE_TOOL_SEARCH_DESCRIPTION =
  'Search the deferred tool catalog by natural-language query and load matching ' +
  'tool definitions into your context. Use this before calling a tool you have not ' +
  'seen; loaded tools become callable on your next step.';

/**
 * Resolve the native Tool Search capability for a resolved model. The adapter
 * kind is the same one `resolveModelRuntime` (`model-runtime.ts`) produces.
 *
 * Model-id gating ensures only models that actually support native Tool Search
 * take the native path; older models fall back to the deterministic `load_tools`
 * economy so they never receive a partially deferred catalog they cannot load.
 *
 * Anthropic: native Tool Search is exposed on Claude Opus 4.5 / Sonnet 4.5
 * and later (model ids `claude-opus-4-5*` / `claude-sonnet-4-5*` and above).
 * OpenAI: `tool_search` requires the Responses API on GPT-5.4 or later
 * (`gpt-5.4*` and above). Chat Completions models such as `gpt-4o` and older
 * GPT-5 variants do not support it and fall back to `load_tools`.
 */
export function resolveProviderToolSearchCapability(
  adapterKind: string,
  modelId: string,
): ProviderToolSearchCapability {
  switch (adapterKind) {
    case 'anthropic':
    case 'claude-subscription':
      return supportsAnthropicToolSearch(modelId) ? 'anthropic' : 'none';
    case 'openai':
      return supportsOpenaiToolSearch(modelId) ? 'openai' : 'none';
    default:
      return 'none';
  }
}

/**
 * Anthropic native Tool Search is available on Claude Opus 4.5 / Sonnet 4.5
 * and later. Model ids follow the `claude-{opus|sonnet|haiku}-{major}-{minor}`
 * convention. The capability is gated on Opus 4.5+ / Sonnet 4.5+.
 */
function supportsAnthropicToolSearch(modelId: string): boolean {
  const id = modelId
    .toLowerCase()
    .replace(/-\d{8}$/, '')
    .replace(/-\w{2,4}-\d+$/, '');
  const opusMatch = id.match(/^claude-opus-(\d+)(?:-(\d+))?/);
  if (opusMatch) {
    return (
      Number(opusMatch[1]) > 4 || (Number(opusMatch[1]) === 4 && Number(opusMatch[2] ?? 0) >= 5)
    );
  }
  const sonnetMatch = id.match(/^claude-sonnet-(\d+)(?:-(\d+))?/);
  if (sonnetMatch) {
    return (
      Number(sonnetMatch[1]) > 4 ||
      (Number(sonnetMatch[1]) === 4 && Number(sonnetMatch[2] ?? 0) >= 5)
    );
  }
  // Unknown Anthropic model — be conservative, fall back.
  return false;
}

/**
 * OpenAI native Tool Search (`tool_search`) requires the Responses API on
 * GPT-5.4 or later. Chat Completions models (e.g. `gpt-4o`) and older GPT-5
 * variants (e.g. `gpt-5`, `gpt-5-mini`) do not support it.
 */
function supportsOpenaiToolSearch(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  // GPT-5.4+ or GPT-6+
  return major > 5 || (major === 5 && minor >= 4);
}

export interface DeferredSurfaceInput {
  readonly id: string;
  readonly description: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface McpServerToolsInput {
  readonly serverId: string;
  /** Optional human description; defaults to the server id. */
  readonly serverDescription?: string;
  readonly toolNames: ReadonlyArray<string>;
}

export interface BuildToolDiscoveryPolicyInput {
  /** Product tool names bound on this host (catalog ∩ binding). */
  readonly productToolNames: Iterable<string>;
  /** Deferred catalog surfaces with their bound members. */
  readonly deferredSurfaces: ReadonlyArray<DeferredSurfaceInput>;
  /** MCP tools grouped by server (external to the product catalog). */
  readonly mcpTools: ReadonlyArray<McpServerToolsInput>;
}

/**
 * Build the Maka-owned discovery policy for one host's bound tool set.
 *
 * - A product tool that is a member of a deferred surface → `deferred` under
 *   that surface's namespace (id) and description.
 * - Any other bound product tool → `direct` (frequent core coding tools stay
 *   immediately available without a search round trip).
 * - Every MCP tool → `deferred` under a per-server namespace. A session
 *   connected to several MCP servers can send dozens/hundreds of schemas; the
 *   whole point of #1382 is to keep those out of the initial context.
 *
 * Unknown product names (not in `productToolNames`) passed via MCP are still
 * classified by the MCP branch. A tool claimed by both a deferred surface and
 * an MCP server keeps the first claim (surface), mirroring
 * `ToolAvailabilityRuntime`'s "first group to claim a tool owns it" rule.
 */
export function buildToolDiscoveryPolicy(
  input: BuildToolDiscoveryPolicyInput,
): ToolDiscoveryPolicy {
  const policy = new Map<string, ToolDiscovery>();
  for (const name of input.productToolNames) {
    policy.set(name, { mode: 'direct' });
  }
  for (const surface of input.deferredSurfaces) {
    for (const name of surface.toolNames) {
      // First claim wins: a surface member is only deferred if it is actually
      // bound; an unbound surface member never enters the policy here.
      if (!policy.has(name)) continue;
      policy.set(name, {
        mode: 'deferred',
        namespace: surface.id,
        namespaceDescription: surface.description,
      });
    }
  }
  for (const server of input.mcpTools) {
    const namespace = mcpNamespace(server.serverId);
    const namespaceDescription = server.serverDescription?.trim() || server.serverId;
    for (const name of server.toolNames) {
      if (policy.has(name)) continue; // surface claim wins
      policy.set(name, { mode: 'deferred', namespace, namespaceDescription });
    }
  }
  return policy;
}

/**
 * Lower a full dispatch tool set + discovery policy into the provider-native
 * tool payload for one provider request.
 *
 * Tools absent from the policy default to `direct` (visible immediately) so
 * the lowerer never silently hides a tool the catalog did not classify —
 * matching the RFC's "search results must be validated against the catalog
 * revision" stance: an unclassified tool is treated as known-and-direct, not
 * as deferred-and-searchable.
 *
 * @param tools Full dispatch set (the same `MakaTool[]` the backend builds).
 * @param policy Discovery policy for these tools.
 * @param capability Resolved native search capability for the model.
 * @param options.searchVariant Anthropic search variant; default `bm25`.
 * @param options.neverAdvertise Tool names kept in the dispatch dict but never
 *   advertised (the `invalid` repair fallback). They stay direct and inactive.
 */
export function lowerToolsForProvider(input: {
  tools: ReadonlyArray<MakaTool>;
  policy: ToolDiscoveryPolicy;
  capability: ProviderToolSearchCapability;
  searchVariant?: AnthropicSearchVariant;
  neverAdvertise?: ReadonlySet<string>;
}): LoweredProviderToolPayload {
  const { tools, policy, capability } = input;
  const neverAdvertise = input.neverAdvertise ?? EMPTY_SET;
  const native = capability !== 'none';
  const searchVariant: AnthropicSearchVariant = input.searchVariant ?? 'bm25';

  const entries: LoweredToolEntry[] = [];
  const activeTools: string[] = [];
  const deferredToolNames: string[] = [];

  for (const tool of tools) {
    const discovery = policy.get(tool.name) ?? ({ mode: 'direct' } as const);
    const deferred = native && discovery.mode === 'deferred';
    entries.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(deferred ? { deferLoading: true } : {}),
      ...(deferred && discovery.mode === 'deferred'
        ? {
            namespace: discovery.namespace,
            namespaceDescription: discovery.namespaceDescription,
          }
        : {}),
    });
    if (deferred) {
      deferredToolNames.push(tool.name);
      // Keep deferred tools in `activeTools`. AI SDK 7 treats `activeTools` as an
      // allowlist: any tool omitted is stripped from the `tools` dict, so the
      // provider adapter never receives the deferred schema or its
      // `deferLoading` flag. The provider's `deferLoading` option keeps the
      // tool out of the initial model context — `activeTools` membership only
      // controls whether the schema is *sent* to the provider at all.
      // `neverAdvertise` tools are the exception: they stay in the dispatch
      // dict but are never sent to the provider.
      if (!neverAdvertise.has(tool.name)) {
        activeTools.push(tool.name);
      }
    } else if (!neverAdvertise.has(tool.name)) {
      activeTools.push(tool.name);
    }
  }

  if (!native) {
    // Fallback: today's full-surface behavior. The existing `load_tools`
    // economy (ToolAvailabilityRuntime) continues to own deferral for the
    // product surfaces it already governs; MCP tools stay direct as today.
    return {
      mode: 'none',
      tools: entries,
      activeTools,
      deferredToolNames: [],
    };
  }

  const searchTool: NativeSearchToolDescriptor = {
    name: NATIVE_TOOL_SEARCH_NAME,
    kind:
      capability === 'anthropic'
        ? searchVariant === 'regex'
          ? 'anthropic-regex'
          : 'anthropic-bm25'
        : 'openai',
    description: NATIVE_TOOL_SEARCH_DESCRIPTION,
  };
  entries.push({
    name: searchTool.name,
    description: searchTool.description,
    // The search tool's input schema is provider-native; the adapter supplies
    // it when expanding the descriptor. The lowerer leaves it undefined.
    parameters: undefined,
  });
  activeTools.push(searchTool.name);

  return {
    mode: capability,
    tools: entries,
    activeTools,
    searchTool,
    deferredToolNames,
  };
}

/** Stable namespace id for an MCP server's deferred tool group. */
export function mcpNamespace(serverId: string): string {
  return `mcp__${serverId}`;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
