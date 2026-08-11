import {
  BUILTIN_TOOL_CATEGORY,
  type PermissionMode,
  type PolicyDecision,
  type ToolCategory,
} from '@maka/core/permission';
import {
  SUBAGENT_PROFILES,
  type SubagentPreset,
  type SubagentProfile,
} from '@maka/core/subagent-settings';
import type { MakaTool } from './tool-runtime.js';

export const LOCAL_READ_AGENT_ID = 'local-read';
export const LOCAL_READ_AGENT_PROFILE = 'local_read';
export const WEB_RESEARCH_AGENT_ID = 'web-research';
export const WEB_RESEARCH_AGENT_PROFILE = 'web_research';
export const IMPLEMENTATION_AGENT_ID = 'implementation';
export const IMPLEMENTATION_AGENT_PROFILE = 'implementation';
export const BUILTIN_AGENT_PROFILES = SUBAGENT_PROFILES;
export const AGENT_INVOCATION_FOREGROUND = 'foreground';
export const AGENT_CONTEXT_ISOLATED = 'isolated';
export const AGENT_WORKSPACE_SAME_WORKSPACE = 'same_workspace';
export const AGENT_WORKSPACE_WORKTREE = 'worktree';
export const AGENT_WRITE_BACK_SUMMARY = 'summary';
export const AGENT_WRITE_BACK_PATCH = 'patch';

export type AgentProfile = SubagentProfile;
export type AgentCapability = AgentProfile;
export type AgentInvocationMode = typeof AGENT_INVOCATION_FOREGROUND;
export type AgentContextMode = typeof AGENT_CONTEXT_ISOLATED;
export type AgentWorkspaceMode = typeof AGENT_WORKSPACE_SAME_WORKSPACE | 'worktree' | 'sandbox';
export type AgentWriteBackMode =
  | typeof AGENT_WRITE_BACK_SUMMARY
  | 'decision'
  | 'artifact'
  | 'patch';
export type AgentToolGroup = 'file_edit';

const AGENT_TOOL_GROUP_ALTERNATIVES = {
  file_edit: [['Write', 'Edit'], ['apply_patch']],
} as const satisfies Record<AgentToolGroup, readonly (readonly string[])[]>;

export interface AgentProfileContract {
  capability: AgentCapability;
  invocation: AgentInvocationMode;
  context: AgentContextMode;
  workspace: AgentWorkspaceMode;
  defaultWriteBack: AgentWriteBackMode;
  supportedWriteBack: readonly AgentWriteBackMode[];
}

export type AgentDefinitionAvailability =
  | { status: 'unknown' }
  | { status: 'available' }
  | {
      status: 'unavailable';
      reason: 'missing_tools';
      missingTools: string[];
    }
  | {
      status: 'unavailable';
      reason: 'workspace_isolation_unavailable';
      workspace: AgentWorkspaceMode;
      requiredRuntime: 'worktree_child_executor';
    };

export interface AgentDefinition {
  definitionVersion: number;
  id: string;
  profile: AgentProfile;
  name: string;
  description: string;
  contract: AgentProfileContract;
  permissionMode: PermissionMode;
  tools: readonly string[];
  toolGroups?: readonly AgentToolGroup[];
  systemPrompt: string;
}

export type AgentRuntimeDefinition = Pick<
  AgentDefinition,
  'id' | 'permissionMode' | 'tools' | 'toolGroups'
>;

export interface AgentDefinitionListItem {
  id: string;
  profile: AgentProfile;
  name: string;
  description: string;
  contract: AgentProfileContract;
  availability: AgentDefinitionAvailability;
  permissionMode: PermissionMode;
  tools: string[];
}

export type SubagentPresetAvailability =
  | { status: 'available' }
  | {
      status: 'unavailable';
      reason: 'disabled' | 'missing_connection' | 'connection_disabled' | 'model_disabled';
    };

export interface SubagentPresetListItem extends SubagentPreset {
  availability: SubagentPresetAvailability;
}

export interface AgentDefinitionListOptions {
  tools?: readonly MakaTool[];
  worktreeChildExecutorAvailable?: boolean;
}

export const LOCAL_READ_AGENT_DEFINITION: AgentDefinition = {
  definitionVersion: 1,
  id: LOCAL_READ_AGENT_ID,
  profile: LOCAL_READ_AGENT_PROFILE,
  name: 'Local Read',
  description: 'Read-only repository exploration with file and text search tools only.',
  contract: {
    capability: 'local_read',
    invocation: AGENT_INVOCATION_FOREGROUND,
    context: AGENT_CONTEXT_ISOLATED,
    workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
    defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
    supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
  },
  permissionMode: 'explore',
  tools: ['Read', 'Glob', 'Grep'],
  systemPrompt: [
    'You are a foreground local-read child agent.',
    'Use only the provided Read, Glob, and Grep tools.',
    'Do not use shell, web, browser, write, or nested agent tools.',
    'Return a concise answer with concrete file or symbol evidence.',
  ].join('\n'),
};

export const WEB_RESEARCH_AGENT_DEFINITION: AgentDefinition = {
  definitionVersion: 1,
  id: WEB_RESEARCH_AGENT_ID,
  profile: WEB_RESEARCH_AGENT_PROFILE,
  name: 'Web Research',
  description: 'Network-backed web research with WebSearch only.',
  contract: {
    capability: 'web_research',
    invocation: AGENT_INVOCATION_FOREGROUND,
    context: AGENT_CONTEXT_ISOLATED,
    workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
    defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
    supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
  },
  permissionMode: 'execute',
  tools: ['WebSearch'],
  systemPrompt: [
    'You are a foreground web-research child agent.',
    'Use only the provided WebSearch tool.',
    'Do not read local files, use shell, browser, write, or nested agent tools.',
    'Return concise findings with source titles and URLs for every external claim.',
    'Separate sourced facts from your own inference.',
  ].join('\n'),
};

export const IMPLEMENTATION_AGENT_DEFINITION: AgentDefinition = {
  definitionVersion: 3,
  id: IMPLEMENTATION_AGENT_ID,
  profile: IMPLEMENTATION_AGENT_PROFILE,
  name: 'Implementation',
  description: 'Code-changing implementation work in an isolated worktree with patch write-back.',
  contract: {
    capability: 'implementation',
    invocation: AGENT_INVOCATION_FOREGROUND,
    context: AGENT_CONTEXT_ISOLATED,
    workspace: AGENT_WORKSPACE_WORKTREE,
    defaultWriteBack: AGENT_WRITE_BACK_PATCH,
    supportedWriteBack: [AGENT_WRITE_BACK_PATCH],
  },
  permissionMode: 'execute',
  tools: [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'apply_patch',
    'Bash',
    'WriteStdin',
    'StopBackgroundTask',
  ],
  toolGroups: ['file_edit'],
  systemPrompt: [
    'You are a foreground implementation child agent.',
    'Run only inside a dedicated worktree child executor when the host provides one.',
    'Use local file and shell tools only for the assigned implementation task.',
    'Do not use web, browser, or nested agent tools.',
    'Return a concise patch-oriented summary with verification results.',
  ].join('\n'),
};

export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  LOCAL_READ_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_DEFINITION,
];

export function listBuiltinAgentDefinitions(
  options: AgentDefinitionListOptions = {},
): AgentDefinitionListItem[] {
  return BUILTIN_AGENT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    profile: definition.profile,
    name: definition.name,
    description: definition.description,
    contract: definition.contract,
    availability: options.tools
      ? evaluateAgentDefinitionAvailability({
          definition,
          tools: options.tools,
          worktreeChildExecutorAvailable: options.worktreeChildExecutorAvailable,
        })
      : { status: 'unknown' },
    permissionMode: definition.permissionMode,
    tools: [...definition.tools],
  }));
}

export function getBuiltinAgentDefinition(id: string): AgentDefinition | undefined {
  return BUILTIN_AGENT_DEFINITIONS.find((definition) => definition.id === id);
}

export function getBuiltinAgentDefinitionByProfile(profile: string): AgentDefinition | undefined {
  return BUILTIN_AGENT_DEFINITIONS.find((definition) => definition.profile === profile);
}

export function agentProfilesForDefinitions(
  definitions: readonly AgentDefinition[],
): [AgentProfile, ...AgentProfile[]] {
  const profiles = definitions.map((definition) => definition.profile);
  if (profiles.length === 0) throw new Error('At least one agent definition is required');
  if (new Set(profiles).size !== profiles.length) {
    throw new Error('Agent definitions must have unique profiles');
  }
  return profiles as [AgentProfile, ...AgentProfile[]];
}

export function requireAgentDefinitionByProfile(
  definitions: readonly AgentDefinition[],
  profile: string,
): AgentDefinition {
  const definition = definitions.find((candidate) => candidate.profile === profile);
  if (!definition) {
    const available = definitions.map((candidate) => candidate.profile).join(', ');
    throw new Error(`Unknown agent profile "${profile}". Available profiles: ${available}.`);
  }
  return definition;
}

export function requireBuiltinAgentDefinition(id: string): AgentDefinition {
  const definition = getBuiltinAgentDefinition(id);
  if (!definition) {
    const available = BUILTIN_AGENT_DEFINITIONS.map((agent) => agent.id).join(', ');
    throw new Error(`Unknown agent "${id}". Available agents: ${available}.`);
  }
  return definition;
}

export function requireBuiltinAgentDefinitionByProfile(profile: string): AgentDefinition {
  return requireAgentDefinitionByProfile(BUILTIN_AGENT_DEFINITIONS, profile);
}

export function listRunnableBuiltinAgentDefinitions(
  options: AgentDefinitionListOptions,
): AgentDefinition[] {
  return BUILTIN_AGENT_DEFINITIONS.filter(
    (definition) =>
      evaluateAgentDefinitionAvailability({
        definition,
        tools: options.tools ?? [],
        worktreeChildExecutorAvailable: options.worktreeChildExecutorAvailable,
      }).status === 'available',
  );
}

export function evaluateAgentDefinitionToolAccess(
  definition: AgentRuntimeDefinition,
  tool: Pick<MakaTool, 'name' | 'categoryHint'>,
): { category: ToolCategory; decision: PolicyDecision } {
  const category = categoryForTool(tool);
  return { category, decision: definition.tools.includes(tool.name) ? 'allow' : 'block' };
}

export function evaluateAgentDefinitionAvailability(input: {
  definition: AgentDefinition;
  tools: readonly MakaTool[];
  worktreeChildExecutorAvailable?: boolean;
}): AgentDefinitionAvailability {
  const { definition, tools } = input;
  if (
    definition.contract.workspace === AGENT_WORKSPACE_WORKTREE &&
    !input.worktreeChildExecutorAvailable
  ) {
    return {
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: definition.contract.workspace,
      requiredRuntime: 'worktree_child_executor',
    };
  }

  const { missingTools } = resolveAgentDefinitionToolSet(tools, definition);
  if (missingTools.length > 0) {
    return { status: 'unavailable', reason: 'missing_tools', missingTools };
  }

  return { status: 'available' };
}

export function buildToolsForAgentDefinition(
  tools: readonly MakaTool[],
  definition: AgentRuntimeDefinition = LOCAL_READ_AGENT_DEFINITION,
): MakaTool[] {
  return resolveAgentDefinitionToolSet(tools, definition).tools;
}

function resolveAgentDefinitionToolSet(
  tools: readonly MakaTool[],
  definition: AgentRuntimeDefinition,
): { tools: MakaTool[]; missingTools: string[] } {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const groupedToolNames = new Set<string>(
    (definition.toolGroups ?? []).flatMap((group) =>
      AGENT_TOOL_GROUP_ALTERNATIVES[group].flatMap((alternative) => alternative),
    ),
  );
  const missingTools = definition.tools.filter(
    (name) => !groupedToolNames.has(name) && !byName.has(name),
  );
  for (const group of definition.toolGroups ?? []) {
    const alternatives = AGENT_TOOL_GROUP_ALTERNATIVES[group];
    if (alternatives.some((alternative) => alternative.every((name) => byName.has(name)))) continue;
    for (const name of alternatives.flat()) {
      if (!byName.has(name) && !missingTools.includes(name)) missingTools.push(name);
    }
  }
  return {
    tools: definition.tools.flatMap((name) => {
      const tool = byName.get(name);
      return tool ? [tool] : [];
    }),
    missingTools,
  };
}

export function assertAgentDefinitionRunnable(input: {
  definition: AgentDefinition;
  tools: readonly MakaTool[];
  worktreeChildExecutorAvailable?: boolean;
}): void {
  const { definition, tools } = input;
  const availability = evaluateAgentDefinitionAvailability({
    definition,
    tools,
    worktreeChildExecutorAvailable: input.worktreeChildExecutorAvailable,
  });
  if (availability.status !== 'unavailable') return;

  if (availability.reason === 'missing_tools') {
    throw new Error(
      `Agent "${definition.id}" is unavailable: missing tools: ${availability.missingTools.join(', ')}`,
    );
  }
  if (availability.reason === 'workspace_isolation_unavailable') {
    throw new Error(
      `Agent "${definition.id}" is unavailable: "${availability.workspace}" workspace isolation requires a worktree child executor.`,
    );
  }
}

function categoryForTool(tool: Pick<MakaTool, 'name' | 'categoryHint'>): ToolCategory {
  return tool.categoryHint ?? BUILTIN_TOOL_CATEGORY[tool.name] ?? 'custom_tool';
}
