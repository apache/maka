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
 * Shared product tool vocabulary (#1099).
 *
 * Tool is the catalog atom. Surface is optional and only for jointly governed
 * packs (deferred `load_tools` groups and/or a shared host product boundary).
 * Hosts own implementations; this module owns names and metadata. Derive
 * HostCapabilities / ToolAvailability groups from catalog ∩ host binding.
 *
 * Public catalog tables are deeply frozen. Consumers must not mutate them;
 * each surface owns an independent hosts record so affinity edits cannot bleed.
 */

export const TOOL_HOST_IDS = ['desktop', 'cli', 'runtime-host'] as const;
export type ToolHostId = (typeof TOOL_HOST_IDS)[number];

/** Whether a host product surface may bind the pack. Not a runtime enable flag. */
export type ToolHostSupport = 'supported' | 'unsupported';

/**
 * Reserved for future policy projections (e.g. read-only). v1 does not consume
 * these; hosts and permission stay unchanged.
 */
export type ToolEffect = 'read' | 'write' | 'shell' | 'network' | 'ui' | 'agent';

export interface CatalogToolDef {
  readonly name: string;
  /** Optional future policy tags; unused by v1 product paths. */
  readonly effects?: readonly ToolEffect[];
  /** Feeds HostCapabilities.capabilities when the tool is bound. */
  readonly capabilityTags?: readonly string[];
}

export interface CatalogSurfaceDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** v1 packs are deferred load groups only. */
  readonly economy: 'deferred';
  readonly toolNames: readonly string[];
  readonly hosts: Readonly<Record<ToolHostId, ToolHostSupport>>;
}

function desktopOnlyHosts(): Readonly<Record<ToolHostId, ToolHostSupport>> {
  return Object.freeze({
    desktop: 'supported',
    cli: 'unsupported',
    'runtime-host': 'unsupported',
  } satisfies Record<ToolHostId, ToolHostSupport>);
}

function allHosts(): Readonly<Record<ToolHostId, ToolHostSupport>> {
  return Object.freeze({
    desktop: 'supported',
    cli: 'supported',
    'runtime-host': 'supported',
  } satisfies Record<ToolHostId, ToolHostSupport>);
}

function freezeTool(tool: CatalogToolDef): CatalogToolDef {
  return Object.freeze({
    name: tool.name,
    ...(tool.effects ? { effects: Object.freeze([...tool.effects]) } : {}),
    ...(tool.capabilityTags ? { capabilityTags: Object.freeze([...tool.capabilityTags]) } : {}),
  });
}

function freezeSurface(surface: CatalogSurfaceDef): CatalogSurfaceDef {
  return Object.freeze({
    id: surface.id,
    label: surface.label,
    description: surface.description,
    economy: surface.economy,
    toolNames: Object.freeze([...surface.toolNames]),
    hosts: Object.freeze({ ...surface.hosts }),
  });
}

/** Always-on product tools (no surface) plus every surface member. */
export const MAKA_CATALOG_TOOLS: readonly CatalogToolDef[] = Object.freeze(
  [
    // Core file / shell
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'ArchiveRead' },
    { name: 'Write' },
    { name: 'Edit' },
    { name: 'apply_patch' },
    { name: 'FormatJson' },
    { name: 'Glob' },
    { name: 'Grep' },
    { name: 'StopBackgroundTask' },
    { name: 'WriteStdin' },
    // Host product always-on
    { name: 'AskUserQuestion' },
    { name: 'request_sandbox_boundary' },
    { name: 'Skill' },
    { name: 'SkillSearch' },
    { name: 'WebFetch', effects: ['network'] as const },
    { name: 'WebSearch' },
    { name: 'MakaSettingsGet', effects: ['read'] as const },
    { name: 'MakaSettingsUpdate', effects: ['write'] as const },
    { name: 'ExploreAgent' },
    { name: 'ScheduledTask' },
    { name: 'GoalSet' },
    { name: 'GoalClear' },
    { name: 'GoalStatus' },
    { name: 'GoalPause' },
    { name: 'GoalResume' },
    { name: 'task_create' },
    { name: 'task_update' },
    { name: 'task_list' },
    { name: 'task_get' },
    { name: 'memory_remember' },
    { name: 'memory_extract' },
    // browser surface
    { name: 'browser_navigate' },
    { name: 'browser_snapshot' },
    { name: 'browser_click' },
    { name: 'browser_type' },
    { name: 'browser_wait' },
    { name: 'browser_extract' },
    // computer_use surface
    { name: 'maka_computer' },
    // rive surface
    { name: 'RiveWorkflow' },
    // agent surface (id matches AGENT_TOOL_GROUP_ID)
    { name: 'agent_spawn' },
    { name: 'agent_list' },
    { name: 'agent_output' },
    { name: 'agent_swarm_status' },
    // Host-managed agent graph supervisor surface
    { name: 'view_agent_graph' },
    { name: 'update_agent_graph' },
    { name: 'yield_agent_graph' },
  ].map(freezeTool),
);

/**
 * Jointly governed deferred packs. Id `agent` matches the runtime
 * ToolAvailability group id (AGENT_TOOL_GROUP_ID), not a separate "subagent" id.
 * Each surface gets its own hosts object so affinity cannot cross-contaminate.
 */
export const MAKA_CATALOG_SURFACES: readonly CatalogSurfaceDef[] = Object.freeze(
  [
    {
      id: 'rive',
      label: 'Rive',
      description:
        'Durable multi-agent Rive workflows: validate/import/run/status, scheduler, retries.',
      economy: 'deferred' as const,
      toolNames: ['RiveWorkflow'],
      hosts: desktopOnlyHosts(),
    },
    {
      id: 'browser',
      label: 'Browser',
      description: 'Drive the embedded browser: navigate, snapshot, click, type, wait, extract.',
      economy: 'deferred' as const,
      toolNames: [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_wait',
        'browser_extract',
      ],
      hosts: desktopOnlyHosts(),
    },
    {
      id: 'computer_use',
      label: 'Computer',
      description: 'Observe and operate an explicitly approved local application.',
      economy: 'deferred' as const,
      toolNames: ['maka_computer'],
      hosts: desktopOnlyHosts(),
    },
    {
      id: 'agent',
      label: 'Agent',
      description: 'Spawn, fan out, and inspect foreground child agents.',
      economy: 'deferred' as const,
      toolNames: [
        'agent_spawn',
        'agent_list',
        'agent_output',
        'agent_swarm_status',
        'view_agent_graph',
        'update_agent_graph',
        'yield_agent_graph',
      ],
      hosts: allHosts(),
    },
  ].map(freezeSurface),
);

const TOOL_BY_NAME = new Map(MAKA_CATALOG_TOOLS.map((tool) => [tool.name, tool]));
const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_BY_NAME.keys());

export function catalogToolByName(name: string): CatalogToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Isolated snapshot of catalog tool names (mutations do not affect the catalog). */
export function catalogToolNameSet(): ReadonlySet<string> {
  return new Set(TOOL_NAME_SET);
}

/** Bound names that are not catalog rows (sorted). Empty means the binding is catalog-clean. */
export function unknownBoundToolNames(boundToolNames: Iterable<string>): string[] {
  const unknown: string[] = [];
  for (const name of boundToolNames) {
    if (!TOOL_BY_NAME.has(name)) unknown.push(name);
  }
  return unknown.sort();
}

export function catalogSurfaceById(id: string): CatalogSurfaceDef | undefined {
  return MAKA_CATALOG_SURFACES.find((surface) => surface.id === id);
}
