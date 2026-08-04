import {
  activePlanExecution,
  DEFAULT_SESSION_NAME,
  defaultWebSearchSettings,
  isDeepResearchSession,
  resolveModelVisionSupport,
} from '@maka/core';
import type {
  AppSettings,
  CollaborationMode,
  LlmConnection,
  SessionHeader,
} from '@maka/core';
import {
  emptyPlanSessionState,
  type PlanExecution,
  type PlanSessionState,
  type PlanStore,
} from '@maka/core/plan';
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_GROUP_ID,
  buildCancelPlanTool,
  isDeepResearchToolAllowed,
  buildMcpTools,
  buildSubmitPlanTool,
  buildToolsForAgentDefinition,
  buildUpdatePlanTool,
  projectEffectiveProductToolSurface,
  routeWebSearchTools,
  selectCollaborationTools,
} from '@maka/runtime';
import type {
  HostCapabilities,
  MakaTool,
  ToolAvailabilityConfig,
} from '@maka/runtime';
import type { McpClientManager } from '@maka/mcp';
import { computerUseToolsForModel } from './computer-use-model-tools.js';
import type { ReadyConnection } from './chat-readiness.js';

export interface DesktopBackendToolSurfaceDeps {
  isComputerUseRealModelE2e: boolean;
  ensureMcpReady: () => Promise<void>;
  getReadyConnection: (
    slug: string | null | undefined,
    model?: string,
  ) => Promise<ReadyConnection>;
  mcpManager: McpClientManager;
  deepResearchTools: readonly MakaTool[];
  computerUseTools: readonly MakaTool[];
  builtinTools: readonly MakaTool[];
  toolEconomy: boolean;
  planStore: PlanStore;
  getAgentGraphSupervisorTools?: (
    sessionId: string,
    header: SessionHeader,
  ) => Promise<readonly MakaTool[]>;
  getWebSearchSettings?: () => Promise<AppSettings['webSearch']>;
  getPrivacySettings?: () => Promise<AppSettings['privacy']>;
  /** Complete child catalog before per-session search routing. */
  childTools?: readonly MakaTool[];
  /** Rebuilds parent agent tools from the routed child capability surface. */
  buildParentAgentToolsForChildSurface?: (childTools: readonly MakaTool[]) => readonly MakaTool[];
}

export interface DesktopBackendToolSurfaceInput {
  sessionId: string;
  header: SessionHeader;
  /** Scoped child tools. Main sessions leave this undefined. */
  tools?: readonly MakaTool[];
  /** Reuse a connection already resolved for a not-yet-persisted session preview. */
  readyConnection?: ReadyConnection;
  /** Avoid reading a durable plan ledger for a not-yet-persisted session preview. */
  planState?: PlanSessionState;
  /** A new-session preview has no durable root Session to supervise yet. */
  includeAgentGraphSupervisorTools?: boolean;
}

export interface DesktopBackendToolSurface {
  connection: LlmConnection;
  apiKey: string;
  model: string;
  supportsVision: boolean;
  collaborationMode: CollaborationMode;
  planState: PlanSessionState;
  activeExecution?: PlanExecution;
  interruptedExecution?: PlanExecution;
  selectedTools: MakaTool[];
  toolAvailability: ToolAvailabilityConfig;
  skillHost: HostCapabilities;
  admitsAgentChildren: boolean;
}

export interface DesktopNewSessionSkillContext {
  collaborationMode?: CollaborationMode;
}

/**
 * Resolve the child capability surface from the same connection, search policy,
 * and privacy authority used by backend creation.
 */
export async function resolveDesktopChildToolSurface(
  deps: DesktopBackendToolSurfaceDeps,
  input: {
    header: SessionHeader;
    tools: readonly MakaTool[];
    readyConnection?: ReadyConnection;
  },
): Promise<MakaTool[]> {
  const { connection, model } =
    input.readyConnection ??
    (await deps.getReadyConnection(input.header.llmConnectionSlug, input.header.model));
  const webSearchSettings = await (deps.getWebSearchSettings?.() ??
    Promise.resolve(defaultWebSearchSettings()));
  const privacySettings = await deps.getPrivacySettings?.();
  return routeWebSearchTools({
    tools: input.tools,
    settings: webSearchSettings,
    connection,
    model,
    ...(privacySettings ? { privacy: privacySettings } : {}),
  });
}

/**
 * Resolve Skill capabilities for an existing Desktop session from the same
 * durable child-tool snapshot that Runtime uses when it builds that session's
 * backend. Root sessions keep using the normal Desktop catalog.
 */
export async function resolveDesktopSessionSkillHost(
  deps: DesktopBackendToolSurfaceDeps,
  input: {
    sessionId: string;
    header: SessionHeader;
    childTools: readonly MakaTool[];
  },
): Promise<HostCapabilities> {
  if (input.header.backend !== 'ai-sdk') return { toolNames: new Set() };
  const tools = resolveDurableChildTools(input.header, input.childTools);
  return (
    await resolveDesktopBackendToolSurface(deps, {
      sessionId: input.sessionId,
      header: input.header,
      ...(tools !== undefined ? { tools } : {}),
    })
  ).skillHost;
}

/**
 * Resolve Skill capabilities for the empty-state composer before a session is
 * persisted. The preview header stands in for the session the composer will
 * create on first send, which is always a plain chat — entry points that pick
 * a mode (Deep Research) create their session up front, so by the time the
 * composer mounts there is a real header to read from.
 */
export async function resolveDesktopNewSessionSkillHost(
  deps: DesktopBackendToolSurfaceDeps,
  input: {
    projectRoot: string;
    workspaceRoot: string;
    readyConnection: ReadyConnection;
    context?: DesktopNewSessionSkillContext;
  },
): Promise<HostCapabilities> {
  const sessionId = 'new-session-skill-preview';
  const now = Date.now();
  const header: SessionHeader = {
    id: sessionId,
    workspaceRoot: input.workspaceRoot,
    cwd: input.projectRoot,
    createdAt: now,
    lastUsedAt: now,
    name: DEFAULT_SESSION_NAME,
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: input.readyConnection.connection.slug,
    connectionLocked: false,
    model: input.readyConnection.model,
    permissionMode: 'ask',
    collaborationMode: input.context?.collaborationMode ?? 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
  return (
    await resolveDesktopBackendToolSurface(deps, {
      sessionId,
      header,
      readyConnection: input.readyConnection,
      planState: emptyPlanSessionState(sessionId),
      includeAgentGraphSupervisorTools: false,
    })
  ).skillHost;
}

/**
 * Derive the exact tool surface an upcoming Desktop ai-sdk backend will bind.
 *
 * Pre-send Skill resolution and slash discovery call this with the persisted
 * session header; backend construction calls it with the same header/context.
 * Keeping the model, collaboration, plan, MCP and child-tool
 * filters here prevents either path from advertising capabilities the other
 * path cannot execute.
 */
export async function resolveDesktopBackendToolSurface(
  deps: DesktopBackendToolSurfaceDeps,
  input: DesktopBackendToolSurfaceInput,
): Promise<DesktopBackendToolSurface> {
  // MCP is optional. A corrupt mcp.json remains visible in the MCP module,
  // but must not prevent builtin-only conversations or Skill discovery.
  await deps.ensureMcpReady().catch(() => {});
  const { connection, apiKey, model } =
    input.readyConnection ??
    (await deps.getReadyConnection(
      input.header.llmConnectionSlug,
      input.header.model,
    ));
  const supportsVision = modelSupportsVision(connection, model);
  const collaborationMode = input.header.collaborationMode ?? 'agent';
  const planState = input.planState ?? (await deps.planStore.readState(input.sessionId));
  const activeExecution = activePlanExecution(planState);
  const interruptedExecution = [...planState.executions]
    .reverse()
    .find((execution) => execution.status === 'interrupted');
  const agentGraphSupervisorTools =
    !input.tools &&
    input.includeAgentGraphSupervisorTools !== false &&
    deps.getAgentGraphSupervisorTools
      ? await deps.getAgentGraphSupervisorTools(input.sessionId, input.header)
      : [];
  const unscopedCandidateTools = input.tools
    ? [...input.tools]
    : deps.isComputerUseRealModelE2e
      ? [...deps.computerUseTools]
      : [
          ...deps.builtinTools,
          ...agentGraphSupervisorTools,
          ...buildMcpTools(deps.mcpManager),
          ...(isDeepResearchSession(input.header.labels) ? deps.deepResearchTools : []),
        ];
  const candidateTools =
    !input.tools && isDeepResearchSession(input.header.labels)
      ? unscopedCandidateTools.filter(isDeepResearchToolAllowed)
      : unscopedCandidateTools;
  const webSearchSettings = await (deps.getWebSearchSettings?.() ??
    Promise.resolve(defaultWebSearchSettings()));
  const privacySettings = await deps.getPrivacySettings?.();
  const routedCandidateTools = routeWebSearchTools({
    tools: candidateTools,
    settings: webSearchSettings,
    connection,
    model,
    ...(privacySettings ? { privacy: privacySettings } : {}),
  });
  const routedChildTools = deps.childTools
    ? routeWebSearchTools({
        tools: deps.childTools,
        settings: webSearchSettings,
        connection,
        model,
        ...(privacySettings ? { privacy: privacySettings } : {}),
      })
    : undefined;
  const effectiveCandidateTools =
    !input.tools && routedChildTools && deps.buildParentAgentToolsForChildSurface
      ? replaceParentAgentTools(
          routedCandidateTools,
          deps.buildParentAgentToolsForChildSurface(routedChildTools),
        )
      : routedCandidateTools;
  const toolEconomy = deps.isComputerUseRealModelE2e ? false : deps.toolEconomy;

  const planControlTools = input.tools
    ? []
    : collaborationMode === 'plan'
      ? [buildSubmitPlanTool(deps.planStore, interruptedExecution?.executionId)]
      : activeExecution
        ? [
            buildUpdatePlanTool(deps.planStore, activeExecution.executionId),
            buildCancelPlanTool(deps.planStore, activeExecution.executionId),
          ]
        : [];
  const backendTools = computerUseToolsForModel(
    [...effectiveCandidateTools, ...planControlTools],
    deps.computerUseTools,
    supportsVision,
  );
  const selectedTools = selectCollaborationTools({
    mode: collaborationMode,
    tools: backendTools,
    hasActiveExecution: activeExecution !== undefined,
  });
  const productToolSurface = projectEffectiveProductToolSurface({
    host: 'desktop',
    tools: selectedTools,
    policy: { economy: toolEconomy },
  });

  return {
    connection,
    apiKey,
    model,
    supportsVision,
    collaborationMode,
    planState,
    activeExecution,
    interruptedExecution,
    selectedTools: [...productToolSurface.tools],
    toolAvailability: productToolSurface.toolAvailability,
    skillHost: productToolSurface.hostCapabilities,
    admitsAgentChildren: productToolSurface.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID),
  };
}

function replaceParentAgentTools(
  tools: readonly MakaTool[],
  replacements: readonly MakaTool[],
): MakaTool[] {
  const parentToolNames = new Set<string>(AGENT_TOOL_NAMES);
  const result: MakaTool[] = [];
  let replaced = false;
  for (const tool of tools) {
    if (!parentToolNames.has(tool.name)) {
      result.push(tool);
      continue;
    }
    if (!replaced) {
      result.push(...replacements);
      replaced = true;
    }
  }
  return result;
}

function modelSupportsVision(connection: LlmConnection, model: string): boolean {
  return resolveModelVisionSupport(connection.providerType, connection.models, model);
}

function resolveDurableChildTools(
  header: SessionHeader,
  availableChildTools: readonly MakaTool[],
): MakaTool[] | undefined {
  const snapshot = header.subagentRuntime;
  if (!snapshot) {
    if (header.subagentParent) {
      throw new Error('Linked child session is missing its durable runtime snapshot');
    }
    return undefined;
  }
  if (!header.subagentParent) {
    throw new Error('Subagent runtime snapshot requires a linked child session');
  }
  const tools = buildToolsForAgentDefinition(availableChildTools, {
    id: snapshot.agentId,
    permissionMode: header.permissionMode,
    tools: snapshot.toolNames,
  });
  if (tools.length !== snapshot.toolNames.length) {
    throw new Error('Subagent runtime tool snapshot is unavailable');
  }
  return tools;
}
