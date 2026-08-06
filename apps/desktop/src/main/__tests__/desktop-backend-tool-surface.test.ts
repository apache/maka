import { createToolResultArchiveCapability } from '@maka/runtime';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import { emptyPlanSessionState, type PlanStore } from '@maka/core/plan';
import type { McpClientManager } from '@maka/mcp';
import {
  type AiSdkBackendInput,
  type BackendFactoryContext,
  buildParentAgentTools,
  listRunnableBuiltinAgentDefinitions,
  type MakaTool,
  type ToolAvailabilityConfig,
} from '@maka/runtime';
import {
  resolveDesktopBackendToolSurface,
  resolveDesktopChildToolSurface,
  resolveDesktopNewSessionSkillHost,
  resolveDesktopSessionSkillHost,
  type DesktopBackendToolSurfaceDeps,
} from '../desktop-backend-tool-surface.js';
import {
  createAiSdkBackendFactory,
  type AiSdkBackendFactoryDeps,
} from '../session-stream.js';

const readTool = tool('Read', 'read');
const writeTool = tool('Write', 'file_write');
const computerTool = tool('maka_computer', 'computer_use');
const availability: ToolAvailabilityConfig = {
  economy: true,
  groups: [
    { id: 'files', toolNames: ['Read', 'Write'] },
    { id: 'computer_use', toolNames: ['maka_computer'] },
  ],
};

describe('Desktop backend tool surface', () => {
  it('builds the Memory prompt for the backend session identity', async () => {
    const deps = makeFactoryDeps();
    let memorySessionId: string | undefined;
    deps.systemPromptService = {
      ...deps.systemPromptService,
      buildLocalMemoryPromptFragment: async (sessionId) => {
        memorySessionId = sessionId;
        return '';
      },
    };

    await backendInput(createAiSdkBackendFactory(deps), undefined);

    assert.equal(memorySessionId, 'session-1');
  });

  it('uses the effective Agent surface as the complete child-runtime capability boundary', async () => {
    const agentTools = [
      tool('agent_spawn', 'subagent'),
      tool('agent_swarm', 'subagent'),
      tool('agent_list', 'read'),
      tool('agent_output', 'read'),
    ];
    const factory = createAiSdkBackendFactory(
      makeFactoryDeps({
        builtinTools: [readTool, writeTool, computerTool, ...agentTools],
      }),
    );

    const rootInput = await backendInput(factory, undefined);
    for (const capability of AGENT_RUNTIME_CAPABILITIES) {
      assert.equal(typeof rootInput[capability], 'function', `expected root ${capability}`);
    }

    const scopedInput = await backendInput(factory, [readTool]);
    for (const capability of AGENT_RUNTIME_CAPABILITIES) {
      assert.equal(scopedInput[capability], undefined, `unexpected scoped ${capability}`);
    }
  });

  it('derives model-gated Skill capabilities from the current session header', async () => {
    const deps = makeDeps();

    const visual = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('claude-sonnet-4-5-20250929'),
    );
    assert.equal(visual.supportsVision, true);
    assert.equal(visual.skillHost.toolNames.has('maka_computer'), true);
    assert.equal(
      visual.toolAvailability.groups?.some((group) => group.id === 'computer_use'),
      true,
    );

    const textOnly = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('text-only-e2e'),
    );
    assert.equal(textOnly.supportsVision, false);
    assert.equal(textOnly.skillHost.toolNames.has('maka_computer'), false);
    assert.equal(
      textOnly.toolAvailability.groups?.some((group) => group.id === 'computer_use'),
      false,
    );
  });

  it('derives collaboration-gated Skill capabilities from the current session header', async () => {
    const deps = makeDeps();
    const agent = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('claude-sonnet-4-5-20250929', 'agent'),
    );
    assert.equal(agent.skillHost.toolNames.has('Read'), true);
    assert.equal(agent.skillHost.toolNames.has('Write'), true);
    assert.equal(agent.skillHost.toolNames.has('SubmitPlan'), false);

    const plan = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('claude-sonnet-4-5-20250929', 'plan'),
    );
    assert.equal(plan.skillHost.toolNames.has('Read'), true);
    assert.equal(plan.skillHost.toolNames.has('Write'), false);
    assert.equal(plan.skillHost.toolNames.has('SubmitPlan'), true);
  });

  it('keeps MCP readiness fail-open while deriving builtin capabilities', async () => {
    let readinessCalls = 0;
    const deps = makeDeps({
      ensureMcpReady: async () => {
        readinessCalls += 1;
        throw new Error('invalid mcp config');
      },
    });

    const surface = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('claude-sonnet-4-5-20250929'),
    );
    assert.equal(readinessCalls, 1);
    assert.equal(surface.skillHost.toolNames.has('Read'), true);
    assert.equal(surface.skillHost.toolNames.has('Write'), true);
  });

  it('keeps scoped child tools ahead of root-only computer-use and Plan controls', async () => {
    const deps = makeDeps({ isComputerUseRealModelE2e: true });
    const input = inputFor('claude-sonnet-4-5-20250929', 'plan');

    const child = await resolveDesktopBackendToolSurface(deps, {
      ...input,
      tools: [readTool],
    });

    assert.deepEqual([...child.skillHost.toolNames], ['Read']);
    assert.equal(child.skillHost.toolNames.has('maka_computer'), false);
    assert.equal(child.skillHost.toolNames.has('SubmitPlan'), false);
  });

  it('binds graph supervisor tools only to an existing root Session', async () => {
    let graphToolRequests = 0;
    const graphTools = [
      tool('view_agent_graph', 'read'),
      tool('update_agent_graph', 'subagent'),
    ];
    const deps = makeDeps({
      getAgentGraphSupervisorTools: async () => {
        graphToolRequests += 1;
        return graphTools;
      },
    });
    const input = inputFor('claude-sonnet-4-5-20250929');
    const root = await resolveDesktopBackendToolSurface(deps, input);
    assert.equal(root.skillHost.toolNames.has('view_agent_graph'), true);
    assert.equal(root.skillHost.toolNames.has('update_agent_graph'), true);

    const child = await resolveDesktopBackendToolSurface(deps, {
      ...input,
      tools: [readTool],
    });
    assert.deepEqual([...child.skillHost.toolNames], ['Read']);

    await resolveDesktopNewSessionSkillHost(deps, {
      projectRoot: '/tmp/project',
      workspaceRoot: '/tmp/workspace',
      readyConnection: {
        connection: connectionFor('claude-sonnet-4-5-20250929'),
        apiKey: 'preview-key',
        model: 'claude-sonnet-4-5-20250929',
      },
    });
    assert.equal(graphToolRequests, 1);
  });

  it('uses the durable child snapshot for the persisted-session Skill host', async () => {
    const header = inputFor('claude-sonnet-4-5-20250929').header;
    header.subagentParent = {} as SessionHeader['subagentParent'];
    header.subagentRuntime = {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: 'read-only-child',
      agentName: 'Read-only child',
      profile: 'local_read',
      systemPrompt: 'Read only.',
      toolNames: ['Read'],
      categoryPolicy: { read: 'allow' },
      permissionCeiling: 'ask',
    };

    const host = await resolveDesktopSessionSkillHost(makeDeps(), {
      sessionId: header.id,
      header,
      childTools: [readTool, writeTool],
    });

    assert.deepEqual([...host.toolNames], ['Read']);
    assert.equal(host.toolNames.has('Write'), false);
  });

  it('does not use the legacy permission ceiling as child admission authority', async () => {
    const header = inputFor('claude-sonnet-4-5-20250929').header;
    header.permissionMode = 'execute';
    header.subagentParent = {} as SessionHeader['subagentParent'];
    header.subagentRuntime = {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: 'implementation-child',
      agentName: 'Implementation child',
      profile: 'implementation',
      systemPrompt: 'Implement.',
      toolNames: ['Write'],
      categoryPolicy: {},
      permissionCeiling: 'ask',
    };

    const host = await resolveDesktopSessionSkillHost(makeDeps(), {
      sessionId: header.id,
      header,
      childTools: [readTool, writeTool],
    });

    assert.deepEqual([...host.toolNames], ['Write']);
  });

  it('never previews Deep Research tools — the preview stands in for a plain chat', async () => {
    // #1433: this used to branch on a `mode` the Quick Chat panel passed in
    // before its session existed. That panel is gone; the only entry point
    // that picks Deep Research creates its session up front, so by the time
    // the composer mounts there is a real header and the preview is not it.
    // A preview that could still claim Deep Research would be a second,
    // hand-written copy of `sessionModeSeed`.
    const deepResearchTool = tool('deep_research_status', 'read');
    const deps = makeDeps({ deepResearchTools: [deepResearchTool] });

    const preview = await resolveDesktopNewSessionSkillHost(deps, {
      projectRoot: '/tmp/project',
      workspaceRoot: '/tmp/workspace',
      readyConnection: {
        connection: connectionFor('claude-sonnet-4-5-20250929'),
        apiKey: 'preview-key',
        model: 'claude-sonnet-4-5-20250929',
      },
    });

    assert.equal(preview.toolNames.has('deep_research_status'), false);
  });

  it('keeps Deep Research on a read-only local tool surface without boundary expansion', async () => {
    const requestBoundary = tool('request_sandbox_boundary', 'custom_tool');
    const bash = tool('Bash', 'shell_unsafe');
    const exploreAgent = tool('ExploreAgent', 'subagent');
    const webSearch = tool('WebSearch', 'web_read');
    const deepResearchStatus = tool('deep_research_status', 'read');
    const deps = makeDeps({
      builtinTools: [
        readTool,
        writeTool,
        requestBoundary,
        bash,
        exploreAgent,
        webSearch,
      ],
      deepResearchTools: [deepResearchStatus],
      getWebSearchSettings: async () => ({
        enabled: true,
        defaultProvider: 'tavily',
        providers: {
          tavily: {
            apiKey: 'tavily-key',
            credentialSource: 'saved',
            credentialVersion: 1,
            credentialStatus: 'valid',
          },
        },
      }),
    });
    const input = inputFor('claude-sonnet-4-5-20250929');
    input.header.labels = ['mode:deep_research'];

    const surface = await resolveDesktopBackendToolSurface(deps, input);

    assert.deepEqual(
      surface.selectedTools.map((candidate) => candidate.name),
      ['Read', 'ExploreAgent', 'WebSearch', 'deep_research_status'],
    );
  });

  it('replaces client-executed WebSearch with provider-native search for DeepSeek V4', async () => {
    const clientSearch = tool('WebSearch', 'web_read');
    const deepseek: LlmConnection = {
      ...connectionFor('deepseek-v4-flash'),
      providerType: 'deepseek',
      models: [
        {
          id: 'deepseek-v4-flash',
          apiProtocol: 'openai-responses',
          capabilities: { webSearch: true },
        },
      ],
    };
    const deps = makeDeps({
      builtinTools: [readTool, clientSearch],
      getReadyConnection: async () => ({
        connection: deepseek,
        apiKey: 'deepseek-key',
        model: 'deepseek-v4-flash',
      }),
      getWebSearchSettings: async () => ({
        enabled: true,
        defaultProvider: 'model',
        providers: {
          tavily: {
            apiKey: '',
            credentialSource: 'none',
            credentialVersion: 0,
            credentialStatus: 'untested',
          },
        },
      }),
    });

    const surface = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('deepseek-v4-flash'),
    );
    const searches = surface.selectedTools.filter((candidate) => candidate.name === 'WebSearch');
    assert.equal(searches.length, 1);
    assert.deepEqual(searches[0]?.providerTool, {
      kind: 'openai-web-search',
      searchContextSize: 'medium',
    });
  });

  it('omits every WebSearch implementation while privacy mode is active', async () => {
    const clientSearch = tool('WebSearch', 'web_read');
    const deepseek: LlmConnection = {
      ...connectionFor('deepseek-v4-flash'),
      providerType: 'deepseek',
      models: [{ id: 'deepseek-v4-flash', apiProtocol: 'openai-responses' }],
    };
    const deps = makeDeps({
      builtinTools: [readTool, clientSearch],
      getReadyConnection: async () => ({
        connection: deepseek,
        apiKey: 'deepseek-key',
        model: 'deepseek-v4-flash',
      }),
      getWebSearchSettings: async () => ({
        enabled: true,
        defaultProvider: 'model',
        providers: {
          tavily: {
            apiKey: '',
            credentialSource: 'none',
            credentialVersion: 0,
            credentialStatus: 'untested',
          },
        },
      }),
      getPrivacySettings: async () => ({ incognitoActive: true }),
    });

    const surface = await resolveDesktopBackendToolSurface(
      deps,
      inputFor('deepseek-v4-flash'),
    );

    assert.equal(
      surface.selectedTools.some((candidate) => candidate.name === 'WebSearch'),
      false,
    );
  });

  it('derives Desktop parent and child agent availability from the routed search surface', async () => {
    const clientSearch = tool('WebSearch', 'web_read');
    const staticParentTools = buildParentAgentTools();
    const deepseek: LlmConnection = {
      ...connectionFor('deepseek-v4-flash'),
      providerType: 'deepseek',
      models: [{ id: 'deepseek-v4-flash', apiProtocol: 'openai-responses' }],
    };
    const childTools = [readTool, clientSearch];
    const routedProfiles = new Map<boolean, string[]>();
    const makeSearchDeps = (enabled: boolean) =>
      makeDeps({
        builtinTools: [readTool, ...staticParentTools],
        childTools,
        buildParentAgentToolsForChildSurface: (routedChildTools) => {
          const definitions = listRunnableBuiltinAgentDefinitions({ tools: routedChildTools });
          routedProfiles.set(enabled, definitions.map((definition) => definition.profile));
          return buildParentAgentTools({ definitions });
        },
        getReadyConnection: async () => ({
          connection: deepseek,
          apiKey: 'deepseek-key',
          model: 'deepseek-v4-flash',
        }),
        getWebSearchSettings: async () => ({
          enabled,
          defaultProvider: 'model',
          providers: {
            tavily: {
              apiKey: '',
              credentialSource: 'none',
              credentialVersion: 0,
              credentialStatus: 'untested',
            },
          },
        }),
      });

    const disabledDeps = makeSearchDeps(false);
    await resolveDesktopBackendToolSurface(
      disabledDeps,
      inputFor('deepseek-v4-flash'),
    );
    assert.equal(routedProfiles.get(false)?.includes('web_research'), false);
    assert.deepEqual(
      (
        await resolveDesktopChildToolSurface(disabledDeps, {
          header: inputFor('deepseek-v4-flash').header,
          tools: childTools,
        })
      ).map((tool) => tool.name),
      ['Read'],
    );

    const enabledDeps = makeSearchDeps(true);
    await resolveDesktopBackendToolSurface(
      enabledDeps,
      inputFor('deepseek-v4-flash'),
    );
    assert.equal(routedProfiles.get(true)?.includes('web_research'), true);
    const routedChildTools = await resolveDesktopChildToolSurface(enabledDeps, {
      header: inputFor('deepseek-v4-flash').header,
      tools: childTools,
    });
    assert.equal(
      routedChildTools.find((tool) => tool.name === 'WebSearch')?.providerTool?.kind,
      'openai-web-search',
    );
  });

  it('uses explicit preview inputs without reading a nonexistent session plan', async () => {
    let connectionReads = 0;
    let planReads = 0;
    const deps = makeDeps({
      getReadyConnection: async () => {
        connectionReads += 1;
        throw new Error('preview must reuse its resolved connection');
      },
      planStore: {
        readState: async () => {
          planReads += 1;
          throw new Error('preview must reuse its empty plan state');
        },
      } as unknown as PlanStore,
    });
    const input = inputFor('claude-sonnet-4-5-20250929', 'plan');
    const surface = await resolveDesktopBackendToolSurface(deps, {
      ...input,
      readyConnection: {
        connection: connectionFor('claude-sonnet-4-5-20250929'),
        apiKey: 'preview-key',
        model: 'claude-sonnet-4-5-20250929',
      },
      planState: emptyPlanSessionState(input.sessionId),
    });

    assert.equal(connectionReads, 0);
    assert.equal(planReads, 0);
    assert.equal(surface.skillHost.toolNames.has('Write'), false);
    assert.equal(surface.skillHost.toolNames.has('SubmitPlan'), true);
  });
});

function makeDeps(
  overrides: Partial<DesktopBackendToolSurfaceDeps> = {},
): DesktopBackendToolSurfaceDeps {
  const planStore = {
    readState: async (sessionId: string) => emptyPlanSessionState(sessionId),
  } as PlanStore;
  return {
    isComputerUseRealModelE2e: false,
    ensureMcpReady: async () => {},
    getReadyConnection: async (_slug, model) => ({
      connection: connectionFor(model ?? 'claude-sonnet-4-5-20250929'),
      apiKey: 'test-key',
      model: model ?? 'claude-sonnet-4-5-20250929',
    }),
    mcpManager: { tools: () => [] } as unknown as McpClientManager,
    deepResearchTools: [],
    computerUseTools: [computerTool],
    builtinTools: [readTool, writeTool, computerTool],
    toolEconomy: availability.economy,
    planStore,
    ...overrides,
  };
}

function inputFor(
  model: string,
  collaborationMode: 'agent' | 'plan' = 'agent',
) {
  return {
    sessionId: 'session-1',
    header: {
      id: 'session-1',
      cwd: '/tmp/project',
      workspaceRoot: '/tmp/workspace',
      backend: 'ai-sdk',
      llmConnectionSlug: 'connection-1',
      model,
      collaborationMode,
      permissionMode: 'ask',
      labels: [],
    } as unknown as SessionHeader,
  };
}

function connectionFor(model: string): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'Connection',
    providerType: 'anthropic',
    defaultModel: model,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tool(
  name: string,
  categoryHint: MakaTool['categoryHint'],
): MakaTool {
  return { name, categoryHint } as MakaTool;
}

const AGENT_RUNTIME_CAPABILITIES = [
  'spawnChildAgent',
  'spawnChildSession',
  'prepareChildAgentResume',
  'resumeChildAgent',
  'retryChildAgent',
  'listChildAgents',
  'readChildAgentOutput',
] as const satisfies readonly (keyof AiSdkBackendInput)[];

function makeFactoryDeps(
  overrides: Partial<DesktopBackendToolSurfaceDeps> = {},
): AiSdkBackendFactoryDeps {
  const runtime = {
    spawnChildAgent: async () => undefined,
    spawnChildSession: async () => undefined,
    prepareChildAgentResume: async () => ({}) as never,
    resumeChildAgent: async () => undefined,
    retryChildAgent: async () => undefined,
    listChildAgents: async () => [],
    readChildAgentOutput: async () => ({}),
  };
  return {
    ...makeDeps(overrides),
    buildSubscriptionModelFetch: () => undefined,
    systemPromptService: {
      buildLocalMemoryPromptFragment: async () => '',
    },
    telemetryRepo: {},
    ensureUsageReady: async () => {},
    artifactStore: {},
    desktopSessionSkillHosts: new Map(),
    sandboxDiagnosticsProvider: { resolve: async () => undefined },
    persistToolArtifacts: async () => {},
    toolResultArchive: testDesktopToolResultArchive(),
    runtimeCommitStore: undefined,
    safeSendToRenderer: () => {},
    emitSessionsChanged: () => {},
    getRuntime: () => runtime,
    getLookupPricing: () => () => null,
  } as unknown as AiSdkBackendFactoryDeps;
}

async function backendInput(
  factory: ReturnType<typeof createAiSdkBackendFactory>,
  tools: readonly MakaTool[] | undefined,
): Promise<AiSdkBackendInput> {
  const base = inputFor('claude-sonnet-4-5-20250929');
  const context: BackendFactoryContext = {
    ...base,
    workspaceRoot: base.header.workspaceRoot,
    store: {
      appendMessage: async () => {},
    } as unknown as BackendFactoryContext['store'],
    ...(tools ? { tools } : {}),
  };
  const backend = await factory(context);
  return (backend as unknown as { input: AiSdkBackendInput }).input;
}

function testDesktopToolResultArchive() {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => undefined,
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
  });
}
