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

import type { ToolAvailabilityDiagnostic } from '@maka/core/usage-stats/types';
import { z } from 'zod';

import { estimateTokens } from './context-budget-helpers.js';
import { canonicalizeToolSet, stableHash, toolSchemaCharsForDiagnostics } from './request-shape.js';
import type { MakaTool, ToolGating } from './tool-runtime.js';

/**
 * Unified tool-availability mechanism (issue #37): one catalog, one connector,
 * one same-turn activation policy, one diagnostics source. Subsumes the former
 * deferred-loader (PR #30) and tool-source-economy (PR #34) into a single
 * runtime whose only knob is the global `economy` switch.
 *
 * - `economy: false` (or no hideable groups) → every tool is advertised every
 *   turn; no connector, no gating, no diagnostics (the full-surface case).
 * - `economy: true` → only ungrouped tools are visible; each group's
 *   tools are withheld until the model activates the group via `load_tools`,
 *   which takes effect in the next Runtime request projection. Activations persist
 *   across turns by re-seeding from the RuntimeEvent ledger.
 */

/** Canonical name of the always-on group-activation connector. */
export const LOAD_TOOLS_NAME = 'load_tools';

/**
 * Historical connector names accepted ONLY when re-seeding prior-turn
 * activations from the durable ledger, so sessions that activated groups under
 * the pre-unification connectors (`load_tool` from PR #30, `connect_tool_source`
 * from PR #34) do not regress. Same-turn activation never honors these — only
 * `LOAD_TOOLS_NAME` is a live connector. Never exposed as a provider-visible tool.
 */
const SEED_CONNECTOR_NAMES: ReadonlySet<string> = new Set([
  LOAD_TOOLS_NAME,
  'load_tool',
  'connect_tool_source',
]);

/** A natural cluster of tools that load together (browser, computer use, …). */
export interface ToolGroup {
  id: string;
  toolNames: readonly string[];
  label?: string;
  description?: string;
}

export interface ToolAvailabilityConfig {
  /** `true` = only ungrouped tools are visible, groups load on demand; `false` = all visible. */
  economy: boolean;
  /** Natural clusters hidden behind the connector when economy is on. */
  groups?: readonly ToolGroup[];
}

export function toolAvailabilityHash(config: ToolAvailabilityConfig): `sha256:${string}` {
  return stableHash({
    economy: config.economy,
    groups: (config.groups ?? []).map((group) => ({
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

/** The minimal shape this module reads from an AI SDK `StepResult`. */
export interface StepLike {
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
}

/** The minimal shape this module reads from a durable `RuntimeEvent`. */
export interface RuntimeEventLike {
  content?: { kind?: string; name?: string; args?: unknown } | undefined;
}

/**
 * Everything the backend needs for one turn. Produced by `prepare()`, which
 * seeds prior-turn activations from the ledger and wires same-turn activation.
 */
export interface ToolAvailabilityPlan {
  /** Full dispatch set (sorted visible tools + the repair fallback). */
  providerTools: MakaTool[];
  /** Step-0 model-visible active subset. */
  activeTools: string[];
  /** Recomputes the active subset from completed provider steps. */
  projectActiveTools?: (options: { completedSteps?: ReadonlyArray<StepLike> }) => {
    activeTools: string[];
  };
  /** Tool names the repair path matches against; tracks the current step's snapshot. */
  currentRepairToolNames: () => string[];
  /** Execute-boundary gating; undefined in full mode. */
  gating?: ToolGating;
  /** Diagnostic for a given active set + measured visible schema chars; undefined in full mode. */
  diagnostics: (
    activeTools: readonly string[],
    visibleToolSchemaChars: number,
  ) => ToolAvailabilityDiagnostic | undefined;
}

interface CatalogGroup {
  id: string;
  /** Gated members only (core/unknown tools excluded). Sorted. */
  toolNames: string[];
  label?: string;
  description?: string;
}

export class ToolAvailabilityRuntime {
  private readonly economy: boolean;
  private readonly groups: CatalogGroup[];
  private readonly groupIds: Set<string>;
  /** Tools that may be hidden this session (all group members). */
  private readonly gatedNames: Set<string>;
  /** Tools advertised on every step: ungrouped tools + the connector. */
  private readonly alwaysActive: Set<string>;
  private readonly connector?: MakaTool;
  /** Real tools plus the connector (when present) — the canonicalize input. */
  private readonly allTools: readonly MakaTool[];

  constructor(
    tools: readonly MakaTool[],
    config: ToolAvailabilityConfig | undefined,
    private readonly invalidTool: MakaTool,
  ) {
    const known = new Set(tools.map((tool) => tool.name));

    const groups: CatalogGroup[] = [];
    const gatedNames = new Set<string>();
    for (const group of config?.groups ?? []) {
      if (!group.id) continue;
      const members: string[] = [];
      for (const name of group.toolNames) {
        // Unknown tools are ignored; the first group to claim a tool owns it.
        if (!known.has(name) || gatedNames.has(name)) continue;
        gatedNames.add(name);
        members.push(name);
      }
      if (members.length === 0) continue;
      members.sort((a, b) => a.localeCompare(b));
      groups.push({
        id: group.id,
        toolNames: members,
        ...(group.label !== undefined ? { label: group.label } : {}),
        ...(group.description !== undefined ? { description: group.description } : {}),
      });
    }
    this.groups = groups;
    this.groupIds = new Set(groups.map((group) => group.id));
    this.gatedNames = gatedNames;

    // Economy only bites when there is actually something to hide.
    this.economy = (config?.economy ?? false) && gatedNames.size > 0;

    this.connector = this.economy ? this.buildConnector() : undefined;
    this.alwaysActive = new Set<string>([
      ...[...known].filter((name) => !gatedNames.has(name)),
      ...(this.connector ? [this.connector.name] : []),
    ]);
    this.allTools = this.connector ? [...tools, this.connector] : tools;
  }

  prepare(
    priorEvents: ReadonlyArray<RuntimeEventLike> | undefined,
    requiredToolNames: ReadonlySet<string> = new Set(),
  ): ToolAvailabilityPlan {
    const canonical = canonicalizeToolSet(this.allTools, this.invalidTool);

    if (!this.economy) {
      // Full surface: every visible tool is active, nothing is gated.
      return {
        providerTools: canonical.providerTools,
        activeTools: canonical.activeTools,
        currentRepairToolNames: () => canonical.activeTools,
        diagnostics: () => undefined,
      };
    }

    const seedGroups = this.seedLoadedGroups(priorEvents);
    const knownNames = new Set(canonical.providerTools.map((tool) => tool.name));
    const requiredNames = [...requiredToolNames].filter((name) => knownNames.has(name));
    // Turn-local snapshot the guard / repair / diagnostics read; recomputed
    // before every provider request. No cross-turn mutable state — a load
    // survives turns only via the ledger seed above (durable by construction),
    // and within one send the backend's translation point hands every hook a
    // send-global completed-step view spanning overflow-retry attempts, so activation
    // stays monotonic per send without a bespoke set here.
    const turn = { active: new Set<string>() };
    const computeActive = (steps: ReadonlyArray<StepLike> | undefined): string[] => {
      const loaded = new Set<string>([...seedGroups, ...this.loadedGroupsFromSteps(steps)]);
      const activeNames = this.activeNamesFor(loaded);
      for (const name of requiredNames) activeNames.add(name);
      const active = canonicalizeToolSet(this.allTools, this.invalidTool, activeNames).activeTools;
      turn.active = new Set(active);
      return active;
    };

    return {
      providerTools: canonical.providerTools,
      activeTools: computeActive(undefined),
      projectActiveTools: ({ completedSteps }) => ({
        activeTools: computeActive(completedSteps),
      }),
      currentRepairToolNames: () => [...turn.active],
      gating: { gatedNames: this.gatedNames, activeNames: () => turn.active },
      diagnostics: (active, chars) => this.buildDiagnostic(active, chars),
    };
  }

  // ── catalog helpers ───────────────────────────────────────────────────────

  private activeNamesFor(loadedGroupIds: ReadonlySet<string>): Set<string> {
    const active = new Set<string>(this.alwaysActive);
    for (const group of this.groups) {
      if (loadedGroupIds.has(group.id)) {
        for (const name of group.toolNames) active.add(name);
      }
    }
    return active;
  }

  private seedLoadedGroups(events: ReadonlyArray<RuntimeEventLike> | undefined): Set<string> {
    const out = new Set<string>();
    for (const event of events ?? []) {
      const content = event?.content;
      if (
        !content ||
        content.kind !== 'function_call' ||
        !SEED_CONNECTOR_NAMES.has(content.name ?? '')
      )
        continue;
      // Ledger seeding reads the group id from any historical arg key.
      const id = extractGroupId(content.args);
      if (id && this.groupIds.has(id)) out.add(id);
    }
    return out;
  }

  private loadedGroupsFromSteps(steps: ReadonlyArray<StepLike> | undefined): Set<string> {
    const out = new Set<string>();
    for (const step of steps ?? []) {
      for (const call of step.toolCalls ?? []) {
        // Same-turn activation is the unified connector only. The historical
        // names are accepted for ledger seeding (prior turns), never live this
        // turn — and only the `group` arg is honored here.
        if (call?.toolName !== LOAD_TOOLS_NAME) continue;
        const id = extractGroupId(call.input, ['group']);
        if (id && this.groupIds.has(id)) out.add(id);
      }
    }
    return out;
  }

  private buildConnector(): MakaTool<{ group: string }, { loaded: string[] }> {
    // Only reached when economy is on, which requires at least one gated group,
    // so `ids` is always non-empty — a plain enum, no empty fallback.
    const ids = this.groups.map((group) => group.id);
    const groupSchema = z.enum(ids as [string, ...string[]]);
    return {
      name: LOAD_TOOLS_NAME,
      description: renderCatalog(this.groups),
      parameters: z.object({
        group: groupSchema.describe('The capability group to load.'),
      }),
      nesting: 'direct_only',
      impl: ({ group }: { group: string }) => {
        const found = this.groups.find((candidate) => candidate.id === group);
        if (!found) {
          throw new Error(`Unknown tool group "${group}". Available: ${ids.join(', ')}.`);
        }
        return { loaded: [...found.toolNames] };
      },
    };
  }

  private buildDiagnostic(
    active: readonly string[],
    visibleToolSchemaChars: number,
  ): ToolAvailabilityDiagnostic {
    const activeSet = new Set(active);
    const isLoaded = (group: CatalogGroup): boolean =>
      group.toolNames.every((name) => activeSet.has(name));
    const enabledSourceIds = this.groups
      .filter(isLoaded)
      .map((group) => group.id)
      .sort((a, b) => a.localeCompare(b));
    const availableSourceIds = this.groups
      .filter((group) => !isLoaded(group))
      .map((group) => group.id)
      .sort((a, b) => a.localeCompare(b));

    const full = canonicalizeToolSet(this.allTools, this.invalidTool);
    const fullToolSchemaChars = toolSchemaCharsForDiagnostics(full.providerTools, full.activeTools);
    const toolSchemaCharReduction = Math.max(0, fullToolSchemaChars - visibleToolSchemaChars);

    return {
      mode: 'economy',
      enabledSourceIds,
      availableSourceIds,
      connectorToolName: LOAD_TOOLS_NAME,
      visibleToolNamesBySource: groupToolNamesById(this.groups),
      visibleToolCount: active.length,
      fullToolCount: full.activeTools.length,
      // active and full both count the connector, so the difference is exactly
      // the hidden (unloaded group) tools — keeps full = visible + hidden.
      hiddenToolCount: Math.max(0, full.activeTools.length - active.length),
      visibleToolSchemaChars,
      fullToolSchemaChars,
      toolSchemaCharReduction,
      estimatedToolSchemaTokenReduction: estimateTokens(toolSchemaCharReduction),
    };
  }
}

function extractGroupId(
  input: unknown,
  keys: readonly string[] = ['group', 'namespace', 'source'],
): string | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return undefined;
}

function renderCatalog(groups: readonly CatalogGroup[]): string {
  const lines = groups.map(
    (group) => `- ${group.id}: ${group.description ?? group.label ?? group.toolNames.join(', ')}`,
  );
  return [
    'Load additional tool groups on demand. These capabilities exist but their full',
    'parameter schemas are withheld to keep each turn lean. Call load_tools with a',
    'group id; the tools it returns become callable on your next step.',
    '',
    'Available groups:',
    ...lines,
  ].join('\n');
}

function groupToolNamesById(groups: readonly CatalogGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of [...groups].sort((a, b) => a.id.localeCompare(b.id))) {
    out[group.id] = [...group.toolNames].sort((a, b) => a.localeCompare(b));
  }
  return out;
}
