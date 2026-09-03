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

import type { ToolCategory } from '@maka/core/permission';
import type { ToolAvailabilityDiagnostic } from '@maka/core/usage-stats/types';
import MiniSearch from 'minisearch';
import { z } from 'zod';

import { estimateTokens } from './context-budget-helpers.js';
import { canonicalizeToolSet, stableHash, toolSchemaCharsForDiagnostics } from './request-shape.js';
import type { MakaTool, ToolGating } from './tool-runtime.js';

/** Canonical name of Maka's provider-independent deferred-tool search connector. */
export const TOOL_SEARCH_NAME = 'tool_search';
/** Provider-safe alias used because OpenAI Responses reserves `tool_search`. */
export const TOOL_SEARCH_PROVIDER_NAME = 'maka_tool_search';
export const TOOL_SEARCH_DEFAULT_LIMIT = 8;
export const TOOL_SEARCH_MAX_LIMIT = 20;
export const TOOL_SEARCH_MAX_SCHEMA_CHARS = 64 * 1024;

/** Tools that remain visible whenever they are bound. */
const DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'ArchiveRead',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'AskUserQuestion',
  'StopBackgroundTask',
  // Existing carve-out pending the separate skill-discovery decision.
  'Skill',
  'SkillSearch',
  // Provider-routed equivalent of the direct Write/Edit surface.
  'apply_patch',
]);

/**
 * Discovery capability-family derived from a tool's permission `categoryHint`.
 *
 * This reuses the existing permission taxonomy (`ToolCategory`) purely for
 * *presentation* in the deferred-tool search inventory: it never loads a tool
 * schema and never affects permission classification. Several permission
 * categories intentionally collapse into one browsing family (e.g. every shell
 * bucket → `shell`). `custom_tool` is deliberately `null` so our own
 * session-scoped tools without a stronger hint keep falling back to `other`.
 *
 * The map is TOTAL over `ToolCategory` on purpose: adding a new category to the
 * union forces an explicit decision here (family or `null`) at compile time,
 * instead of silently collapsing the new category into `other`.
 */
const CATEGORY_FAMILY: Record<ToolCategory, { id: string; label: string } | null> = {
  read: { id: 'filesystem', label: 'Filesystem & search' },
  file_write: { id: 'filesystem', label: 'Filesystem & search' },
  fs_destructive: { id: 'filesystem', label: 'Filesystem & search' },
  shell_safe: { id: 'shell', label: 'Shell & processes' },
  shell_unsafe: { id: 'shell', label: 'Shell & processes' },
  privileged: { id: 'shell', label: 'Shell & processes' },
  git_destructive: { id: 'shell', label: 'Shell & processes' },
  web_read: { id: 'web', label: 'Web & network' },
  network_send: { id: 'web', label: 'Web & network' },
  browser: { id: 'browser', label: 'Browser automation' },
  computer_use: { id: 'computer_use', label: 'Computer use' },
  client_capability: { id: 'client_capability', label: 'Client capabilities' },
  subagent: { id: 'agents', label: 'Agent orchestration' },
  // null = intentionally ungrouped; falls back to the `other` bucket.
  custom_tool: null,
};

/** Optional search metadata for a subset of the bound deferred tools. */
export interface ToolGroup {
  id: string;
  toolNames: readonly string[];
  label?: string;
  description?: string;
}

export interface ToolAvailabilityConfig {
  /**
   * Search-space presentation metadata derived from the current bound tools.
   * Supplying this config enables default deferral; omitting it keeps every
   * bound tool direct for an explicit wire-schema ceiling.
   */
  groups?: readonly ToolGroup[];
}

export interface ToolSearchResult {
  readonly activated: string[];
  readonly blocked?: {
    readonly name: string;
    readonly reason: 'schema_too_large' | 'schema_budget_exhausted';
    readonly schemaChars: number;
  };
}

export function toolAvailabilityHash(
  config: ToolAvailabilityConfig | undefined,
): `sha256:${string}` {
  return stableHash({
    mode: config === undefined ? 'full' : 'search',
    groups: (config?.groups ?? []).map((group) => ({
      id: group.id,
      toolNames: [...new Set(group.toolNames)].sort(compareExactString),
      ...(group.label !== undefined ? { label: group.label } : {}),
      ...(group.description !== undefined ? { description: group.description } : {}),
    })),
  });
}

function compareExactString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Everything the backend needs for one turn. */
export interface ToolAvailabilityPlan {
  /** Full dispatch set (sorted bound tools + search connector + repair fallback). */
  providerTools: MakaTool[];
  /** Step-0 model-visible subset. */
  activeTools: string[];
  /** Recomputes the provider-visible subset from the turn-owned activation map. */
  projectActiveTools?: (_options?: unknown) => { activeTools: string[] };
  /** Tool names the repair path matches against; tracks the current step snapshot. */
  currentRepairToolNames: () => string[];
  /** Execute-boundary gating against the immutable step-start snapshot. */
  gating?: ToolGating;
  diagnostics: (
    activeTools: readonly string[],
    visibleToolSchemaChars: number,
  ) => ToolAvailabilityDiagnostic | undefined;
}

interface SearchGroup {
  id: string;
  toolNames: string[];
  label?: string;
  description?: string;
}

interface SearchDocument {
  id: string;
  name: string;
  searchText: string;
}

/**
 * Immutable, backend-scoped bound-tool inventory and MiniSearch index.
 *
 * Mutable activation belongs to the per-send TurnScope and is passed to
 * prepare(). Constructing one AiSdkBackend therefore constructs one index; all
 * turns on that backend reuse it without sharing activation state.
 */
export class ToolAvailabilityRuntime {
  private readonly tools: readonly MakaTool[];
  private readonly toolsByName: ReadonlyMap<string, MakaTool>;
  private readonly groups: readonly SearchGroup[];
  private readonly searchableNames: ReadonlySet<string>;
  private readonly directNames: ReadonlySet<string>;
  private readonly searchIndex?: MiniSearch<SearchDocument>;

  constructor(
    tools: readonly MakaTool[],
    config: ToolAvailabilityConfig | undefined,
    private readonly invalidTool: MakaTool,
  ) {
    if (tools.some((tool) => tool.name === TOOL_SEARCH_NAME)) {
      throw new Error(`Tool name "${TOOL_SEARCH_NAME}" is reserved by Runtime`);
    }
    if (tools.some((tool) => tool.name === TOOL_SEARCH_PROVIDER_NAME)) {
      throw new Error(`Tool name "${TOOL_SEARCH_PROVIDER_NAME}" is reserved by Runtime`);
    }
    this.tools = [...tools];
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

    const known = new Set(this.toolsByName.keys());
    const searchable =
      config === undefined
        ? new Set<string>()
        : new Set([...known].filter((name) => !DIRECT_TOOL_NAMES.has(name)));
    const claimed = new Set<string>();
    const groups: SearchGroup[] = [];
    for (const group of config?.groups ?? []) {
      if (!group.id) continue;
      const members: string[] = [];
      for (const name of group.toolNames) {
        // The first source to claim a currently bound tool owns its inventory row.
        if (!searchable.has(name) || claimed.has(name)) continue;
        claimed.add(name);
        members.push(name);
      }
      if (members.length === 0) continue;
      members.sort(compareExactString);
      groups.push({
        id: group.id,
        toolNames: members,
        ...(group.label !== undefined ? { label: group.label } : {}),
        ...(group.description !== undefined ? { description: group.description } : {}),
      });
    }
    const ungrouped = [...searchable].filter((name) => !claimed.has(name)).sort(compareExactString);
    if (ungrouped.length > 0) {
      // Bucket ungrouped native tools by their permission `categoryHint` so the
      // search inventory advertises a compact capability-family map instead of a
      // single opaque `other` group. This reads metadata already on the bound
      // tool (no schema is loaded) and never affects permission classification.
      // A caller-supplied group with a colliding id keeps precedence: family
      // members merge into it. Tools with no hint (or `custom_tool`) still fall
      // back to `other`.
      const familyMembers = new Map<string, { label?: string; names: string[] }>();
      const otherNames: string[] = [];
      for (const name of ungrouped) {
        const hint = this.toolsByName.get(name)?.categoryHint;
        // A mapped-but-`null` entry (e.g. custom_tool) and an absent hint both
        // route to `other`; only a non-null family is bucketed.
        const family = hint ? CATEGORY_FAMILY[hint] : null;
        if (!family) {
          otherNames.push(name);
          continue;
        }
        const bucket = familyMembers.get(family.id) ?? { label: family.label, names: [] };
        bucket.names.push(name);
        familyMembers.set(family.id, bucket);
      }
      for (const id of [...familyMembers.keys()].sort(compareExactString)) {
        const bucket = familyMembers.get(id)!;
        const existing = groups.find((group) => group.id === id);
        if (existing) {
          existing.toolNames = [...existing.toolNames, ...bucket.names].sort(compareExactString);
        } else {
          groups.push({
            id,
            toolNames: [...bucket.names].sort(compareExactString),
            ...(bucket.label !== undefined ? { label: bucket.label } : {}),
          });
        }
      }
      if (otherNames.length > 0) {
        const fallback = groups.find((group) => group.id === 'other');
        if (fallback) {
          fallback.toolNames = [...fallback.toolNames, ...otherNames].sort(compareExactString);
        } else {
          groups.push({ id: 'other', toolNames: otherNames.sort(compareExactString) });
        }
      }
    }
    this.groups = groups;
    this.searchableNames = searchable;
    this.directNames = new Set([...known].filter((name) => !searchable.has(name)));

    if (searchable.size > 0) {
      const groupByToolName = new Map(
        groups.flatMap((group) => group.toolNames.map((name) => [name, group] as const)),
      );
      const index = new MiniSearch<SearchDocument>({
        fields: ['name', 'searchText'],
        storeFields: ['name'],
        idField: 'id',
        searchOptions: {
          boost: { name: 4, searchText: 1 },
          combineWith: 'OR',
          prefix: true,
          fuzzy: 0.2,
        },
      });
      index.addAll(
        [...searchable].map((name) => {
          const tool = this.toolsByName.get(name)!;
          const group = groupByToolName.get(name);
          return {
            id: name,
            name,
            searchText: [
              name.replaceAll('_', ' '),
              tool.description,
              group?.id,
              group?.label,
              group?.description,
            ]
              .filter((value): value is string => value !== undefined && value.length > 0)
              .join(' '),
          };
        }),
      );
      this.searchIndex = index;
    }
  }

  prepare(
    activeTools: Map<string, MakaTool>,
    requiredToolNames: ReadonlySet<string> = new Set(),
  ): ToolAvailabilityPlan {
    if (!this.searchIndex) {
      const canonical = canonicalizeToolSet(this.tools, this.invalidTool);
      return {
        providerTools: canonical.providerTools,
        activeTools: canonical.activeTools,
        currentRepairToolNames: () => canonical.activeTools,
        diagnostics: () => undefined,
      };
    }

    const connector = this.buildSearchConnector(activeTools);
    const allTools = [...this.tools, connector];
    const canonical = canonicalizeToolSet(allTools, this.invalidTool);
    const knownNames = new Set(canonical.providerTools.map((tool) => tool.name));
    const requiredNames = [...requiredToolNames].filter((name) => knownNames.has(name));
    const step = { active: new Set<string>() };
    const computeActive = (): string[] => {
      const names = new Set<string>([...this.directNames, TOOL_SEARCH_NAME]);
      for (const name of activeTools.keys()) {
        if (knownNames.has(name)) names.add(name);
      }
      for (const name of requiredNames) names.add(name);
      const active = canonicalizeToolSet(allTools, this.invalidTool, names).activeTools;
      // Replace, rather than mutate, so an in-flight step retains its own snapshot.
      step.active = new Set(active);
      return active;
    };

    return {
      providerTools: canonical.providerTools,
      activeTools: computeActive(),
      projectActiveTools: () => ({ activeTools: computeActive() }),
      currentRepairToolNames: () => [...step.active],
      gating: { gatedNames: this.searchableNames, activeNames: () => step.active },
      diagnostics: (active, chars) => this.buildDiagnostic(allTools, active, chars),
    };
  }

  private buildSearchConnector(
    activeTools: Map<string, MakaTool>,
  ): MakaTool<{ query: string; limit?: number }, ToolSearchResult> {
    return {
      name: TOOL_SEARCH_NAME,
      description: renderInventory(this.groups),
      parameters: z.object({
        query: z.string().trim().min(1).describe('Search query describing the needed capability.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TOOL_SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Maximum matches to activate; defaults to ${TOOL_SEARCH_DEFAULT_LIMIT}.`),
      }),
      nesting: 'direct_only',
      impl: ({ query, limit = TOOL_SEARCH_DEFAULT_LIMIT }, context) => {
        const normalizedQuery = query.trim();
        const ranked = this.searchIndex!.search(normalizedQuery)
          .map((result) => String(result.id))
          .filter((name) => !activeTools.has(name))
          .slice(0, TOOL_SEARCH_MAX_LIMIT)
          .filter((name) => this.searchableNames.has(name));
        const activated: string[] = [];
        let blocked: ToolSearchResult['blocked'];
        let schemaChars = 0;
        for (const name of ranked) {
          if (activated.length >= limit) break;
          const tool = this.toolsByName.get(name);
          if (!tool) continue;
          const chars = toolSchemaCharsForDiagnostics([tool], [tool.name]);
          if (chars > TOOL_SEARCH_MAX_SCHEMA_CHARS) {
            blocked ??= { name, reason: 'schema_too_large', schemaChars: chars };
            continue;
          }
          if (schemaChars + chars > TOOL_SEARCH_MAX_SCHEMA_CHARS) {
            blocked = { name, reason: 'schema_budget_exhausted', schemaChars: chars };
            break;
          }
          activated.push(name);
          schemaChars += chars;
        }
        for (const name of activated) activeTools.set(name, this.toolsByName.get(name)!);
        const result: ToolSearchResult = {
          activated,
          ...(blocked ? { blocked } : {}),
        };
        context.emitRunTrace?.('tool_searched', 'Deferred tools searched', {
          query: normalizedQuery,
          requestedLimit: limit,
          ranked,
          activated,
          newlyActivated: activated,
          schemaChars,
          ...(blocked ? { blocked } : {}),
        });
        return result;
      },
      toModelOutput: ({ output }) => {
        const result = output as ToolSearchResult;
        return {
          type: 'json',
          value: {
            activated: [...result.activated],
            ...(result.blocked ? { blocked: { ...result.blocked } } : {}),
          },
        };
      },
    };
  }

  private buildDiagnostic(
    allTools: readonly MakaTool[],
    active: readonly string[],
    visibleToolSchemaChars: number,
  ): ToolAvailabilityDiagnostic {
    const activeSet = new Set(active);
    const enabledSourceIds = this.groups
      .filter((group) => group.toolNames.every((name) => activeSet.has(name)))
      .map((group) => group.id)
      .sort(compareExactString);
    const availableSourceIds = this.groups
      .filter((group) => !group.toolNames.every((name) => activeSet.has(name)))
      .map((group) => group.id)
      .sort(compareExactString);
    const full = canonicalizeToolSet(allTools, this.invalidTool);
    const fullToolSchemaChars = toolSchemaCharsForDiagnostics(full.providerTools, full.activeTools);
    const toolSchemaCharReduction = Math.max(0, fullToolSchemaChars - visibleToolSchemaChars);

    return {
      mode: 'search',
      enabledSourceIds,
      availableSourceIds,
      connectorToolName: TOOL_SEARCH_NAME,
      visibleToolNamesBySource: groupToolNamesById(this.groups),
      visibleToolCount: active.length,
      fullToolCount: full.activeTools.length,
      hiddenToolCount: Math.max(0, full.activeTools.length - active.length),
      visibleToolSchemaChars,
      fullToolSchemaChars,
      toolSchemaCharReduction,
      estimatedToolSchemaTokenReduction: estimateTokens(toolSchemaCharReduction),
    };
  }
}

function renderInventory(groups: readonly SearchGroup[]): string {
  const lines = groups.flatMap((group) => [
    `${group.id}:`,
    ...group.toolNames.map((name) => `- ${name}`),
  ]);
  return [
    'Search the deferred tools bound to this run. A successful search activates the',
    'bounded top matches; their complete callable definitions become visible on the',
    'next provider step. Search again to expand the active set. A blocked result means',
    'the highest remaining match did not fit this search schema budget.',
    '',
    'Searchable tool inventory (group and canonical name only):',
    ...lines,
  ].join('\n');
}

function groupToolNamesById(groups: readonly SearchGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of [...groups].sort((a, b) => compareExactString(a.id, b.id))) {
    out[group.id] = [...group.toolNames].sort(compareExactString);
  }
  return out;
}
