import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  LlmConnection,
  SessionHeader,
  Task,
  TaskAgentOutcome,
  TaskLedgerStore,
  TaskOwner,
} from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import { zodSchema } from 'ai';
import { buildBuiltinTools } from '../builtin-tools.js';
import { PermissionEngine } from '../permission-engine.js';
import {
  AGENT_CONTEXT_ISOLATED,
  AGENT_INVOCATION_FOREGROUND,
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  IMPLEMENTATION_AGENT_ID,
  IMPLEMENTATION_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_PROFILE,
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_PROFILE,
  WEB_RESEARCH_AGENT_ID,
  WEB_RESEARCH_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_PROFILE,
  assertAgentDefinitionRunnable,
  evaluateAgentDefinitionAvailability,
  evaluateAgentDefinitionToolAccess,
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinitionByProfile,
} from '../agent-catalog.js';
import { AGENT_SWARM_TOOL_NAME } from '../agent-swarm-tools.js';
import {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  CHILD_AGENT_TOOL_NAMES,
  buildChildAgentTools,
  buildParentAgentTools,
  buildSubagentListTool,
  buildSubagentOutputTool,
  buildSubagentSpawnTool,
} from '../subagent-tools.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';
import { expect } from '../test-helpers.js';

describe('subagent tools', () => {
  test('parent-facing agent tools declare permission hints and names', () => {
    const spawnTool = buildSubagentSpawnTool();
    expect(spawnTool.permissionRequired).toBe(true);
    expect(spawnTool.categoryHint).toBe('subagent');
    expect(buildSubagentListTool().permissionRequired).toBe(false);
    expect(buildSubagentOutputTool().permissionRequired).toBe(false);
    expect(buildParentAgentTools().map((tool) => tool.name)).toEqual([
      AGENT_SPAWN_TOOL_NAME,
      AGENT_SWARM_TOOL_NAME,
      AGENT_LIST_TOOL_NAME,
      AGENT_OUTPUT_TOOL_NAME,
    ]);
  });

  test('agent_spawn advertises task_id only when task binding is available', async () => {
    const advertisedProperties = async (tool: MakaTool) => {
      const schema = (await zodSchema(tool.parameters as never).jsonSchema) as {
        properties?: Record<string, unknown>;
      };
      return schema.properties ?? {};
    };

    expect(Object.keys(await advertisedProperties(buildSubagentSpawnTool()))).toEqual([
      'profile',
      'task',
      'write_back',
      'isolation',
    ]);
    expect(
      Object.keys(
        await advertisedProperties(
          buildSubagentSpawnTool({ taskLedger: taskLedgerStub(undefined, []) }),
        ),
      ),
    ).toEqual(['profile', 'task', 'write_back', 'isolation', 'task_id']);
  });

  test('agent_spawn rejects task_id when task binding is unavailable', () => {
    const schema = buildSubagentSpawnTool().parameters as {
      safeParse(input: unknown): { success: boolean };
    };

    expect(
      schema.safeParse({
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        task_id: 'T1',
      }).success,
    ).toBe(false);
  });

  test('built-in catalog exposes local-read without shell, web, nested, or write tools', () => {
    expect(LOCAL_READ_AGENT_DEFINITION.id).toBe(LOCAL_READ_AGENT_ID);
    expect(LOCAL_READ_AGENT_DEFINITION.profile).toBe(LOCAL_READ_AGENT_PROFILE);
    expect(LOCAL_READ_AGENT_DEFINITION.contract).toEqual({
      capability: 'local_read',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
      defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
      supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
    });
    expect(LOCAL_READ_AGENT_DEFINITION.permissionMode).toBe('explore');
    expect([...LOCAL_READ_AGENT_DEFINITION.tools]).toEqual(['Read', 'Glob', 'Grep']);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('Bash')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('WebSearch')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('WebFetch')).toBe(false);
    expect(LOCAL_READ_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const definitions = listBuiltinAgentDefinitions({
      parentPermissionMode: 'ask',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', 'web_read'),
      ],
    });
    expect(definitions.find((definition) => definition.id === LOCAL_READ_AGENT_ID)).toEqual({
      id: LOCAL_READ_AGENT_ID,
      profile: LOCAL_READ_AGENT_PROFILE,
      name: 'Local Read',
      description: 'Read-only repository exploration with file and text search tools only.',
      permissionMode: 'explore',
      tools: ['Read', 'Glob', 'Grep'],
      contract: LOCAL_READ_AGENT_DEFINITION.contract,
      availability: { status: 'available' },
    });
  });

  test('built-in catalog exposes web-research with only WebSearch and no local or write tools', () => {
    expect(WEB_RESEARCH_AGENT_DEFINITION.id).toBe(WEB_RESEARCH_AGENT_ID);
    expect(WEB_RESEARCH_AGENT_DEFINITION.profile).toBe(WEB_RESEARCH_AGENT_PROFILE);
    expect(WEB_RESEARCH_AGENT_DEFINITION.contract).toEqual({
      capability: 'web_research',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_SAME_WORKSPACE,
      defaultWriteBack: AGENT_WRITE_BACK_SUMMARY,
      supportedWriteBack: [AGENT_WRITE_BACK_SUMMARY],
    });
    expect(WEB_RESEARCH_AGENT_DEFINITION.permissionMode).toBe('execute');
    expect([...WEB_RESEARCH_AGENT_DEFINITION.tools]).toEqual(['WebSearch']);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Read')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Bash')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('Write')).toBe(false);
    expect(WEB_RESEARCH_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const withWebSearch = listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', undefined),
      ],
    });
    expect(withWebSearch.map((definition) => definition.profile)).toEqual([
      LOCAL_READ_AGENT_PROFILE,
      WEB_RESEARCH_AGENT_PROFILE,
      IMPLEMENTATION_AGENT_PROFILE,
    ]);
    expect(withWebSearch.find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)).toEqual({
      id: WEB_RESEARCH_AGENT_ID,
      profile: WEB_RESEARCH_AGENT_PROFILE,
      name: 'Web Research',
      description: 'Network-backed web research with WebSearch only.',
      permissionMode: 'execute',
      tools: ['WebSearch'],
      contract: WEB_RESEARCH_AGENT_DEFINITION.contract,
      availability: { status: 'available' },
    });

    expect(
      listBuiltinAgentDefinitions({
        parentPermissionMode: 'execute',
        tools: [
          testCatalogTool('Read', 'read'),
          testCatalogTool('Glob', 'read'),
          testCatalogTool('Grep', 'read'),
        ],
      }).find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)?.availability,
    ).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    expect(
      listBuiltinAgentDefinitions({
        parentPermissionMode: 'ask',
        tools: [
          testCatalogTool('Read', 'read'),
          testCatalogTool('Glob', 'read'),
          testCatalogTool('Grep', 'read'),
          testCatalogTool('WebSearch', 'web_read'),
        ],
      }).find((definition) => definition.id === WEB_RESEARCH_AGENT_ID)?.availability,
    ).toEqual({
      status: 'unavailable',
      reason: 'parent_permission_mode',
      parentPermissionMode: 'ask',
      requiredPermissionMode: 'execute',
    });
  });

  test('built-in catalog exposes implementation as a worktree-only fail-closed contract', async () => {
    expect(IMPLEMENTATION_AGENT_DEFINITION.id).toBe(IMPLEMENTATION_AGENT_ID);
    expect(IMPLEMENTATION_AGENT_DEFINITION.profile).toBe(IMPLEMENTATION_AGENT_PROFILE);
    expect(IMPLEMENTATION_AGENT_DEFINITION.contract).toEqual({
      capability: 'implementation',
      invocation: AGENT_INVOCATION_FOREGROUND,
      context: AGENT_CONTEXT_ISOLATED,
      workspace: AGENT_WORKSPACE_WORKTREE,
      defaultWriteBack: AGENT_WRITE_BACK_PATCH,
      supportedWriteBack: [AGENT_WRITE_BACK_PATCH],
    });
    expect(IMPLEMENTATION_AGENT_DEFINITION.permissionMode).toBe('execute');
    expect([...IMPLEMENTATION_AGENT_DEFINITION.tools]).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'Bash',
    ]);
    expect(IMPLEMENTATION_AGENT_DEFINITION.tools.includes('WebSearch')).toBe(false);
    expect(IMPLEMENTATION_AGENT_DEFINITION.tools.includes('ExploreAgent')).toBe(false);

    const availability = listBuiltinAgentDefinitions({
      parentPermissionMode: 'execute',
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('Write', 'file_write'),
        testCatalogTool('Edit', 'file_write'),
        testCatalogTool('Bash', 'shell_unsafe'),
      ],
    }).find((definition) => definition.id === IMPLEMENTATION_AGENT_ID)?.availability;
    expect(availability).toEqual({
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });

    await expectRejects(
      Promise.resolve().then(() =>
        assertAgentDefinitionRunnable({
          parentPermissionMode: 'execute',
          definition: IMPLEMENTATION_AGENT_DEFINITION,
          tools: [
            testCatalogTool('Read', 'read'),
            testCatalogTool('Glob', 'read'),
            testCatalogTool('Grep', 'read'),
            testCatalogTool('Write', 'file_write'),
            testCatalogTool('Edit', 'file_write'),
            testCatalogTool('Bash', 'shell_unsafe'),
          ],
        }),
      ),
      /worktree child executor/,
    );
  });

  test('agent definition availability reports missing tools and parent permission mismatches without running', () => {
    expect(
      evaluateAgentDefinitionAvailability({
        parentPermissionMode: 'ask',
        definition: LOCAL_READ_AGENT_DEFINITION,
        tools: [testCatalogTool('Read', 'read')],
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['Glob', 'Grep'],
    });

    expect(
      evaluateAgentDefinitionAvailability({
        parentPermissionMode: 'explore',
        definition: {
          ...LOCAL_READ_AGENT_DEFINITION,
          id: 'writer',
          permissionMode: 'execute',
        },
        tools: [
          testCatalogTool('Read', 'read'),
          testCatalogTool('Glob', 'read'),
          testCatalogTool('Grep', 'read'),
        ],
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'parent_permission_mode',
      parentPermissionMode: 'explore',
      requiredPermissionMode: 'execute',
    });
  });

  test('agent definition policy evaluates each tool through allowlist and category policy', () => {
    expect(
      evaluateAgentDefinitionToolAccess(
        LOCAL_READ_AGENT_DEFINITION,
        testCatalogTool('Read', 'read'),
      ),
    ).toEqual({
      category: 'read',
      decision: 'allow',
    });
    expect(
      evaluateAgentDefinitionToolAccess(
        LOCAL_READ_AGENT_DEFINITION,
        testCatalogTool('Write', 'file_write'),
      ),
    ).toEqual({
      category: 'file_write',
      decision: 'block',
    });
    expect(
      evaluateAgentDefinitionToolAccess(
        {
          ...LOCAL_READ_AGENT_DEFINITION,
          id: 'web-review',
          tools: ['WebSearch'],
          categoryPolicy: { web_read: 'prompt' },
        },
        testCatalogTool('WebSearch', 'web_read'),
      ),
    ).toEqual({
      category: 'web_read',
      decision: 'prompt',
    });
  });

  test('agent definition cannot require broader permissions than the parent turn', async () => {
    await expectRejects(
      Promise.resolve().then(() =>
        assertAgentDefinitionRunnable({
          parentPermissionMode: 'explore',
          definition: {
            ...LOCAL_READ_AGENT_DEFINITION,
            id: 'writer',
            permissionMode: 'execute',
          },
          tools: [
            testCatalogTool('Read', 'read'),
            testCatalogTool('Glob', 'read'),
            testCatalogTool('Grep', 'read'),
          ],
        }),
      ),
      /cannot run in parent permission mode "explore" because it requires "execute"/,
    );
  });

  test('child agent toolset keeps only built-in profile allowlisted tools', () => {
    const tools = buildChildAgentTools([
      ...buildBuiltinTools(),
      {
        name: AGENT_SPAWN_TOOL_NAME,
        description: 'spawn',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => ({}),
      },
      {
        name: 'WebSearch',
        description: 'web',
        parameters: {},
        categoryHint: 'web_read',
        impl: async () => ({}),
      },
      {
        name: 'ExploreAgent',
        description: 'deterministic exploration',
        parameters: {},
        categoryHint: 'subagent',
        impl: async () => ({}),
      },
    ]);

    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep', 'WebSearch']);
    expect([...CHILD_AGENT_TOOL_NAMES]).toEqual(['Read', 'Glob', 'Grep', 'WebSearch']);
    expect(tools.some((tool) => tool.name === 'Bash')).toBe(false);
    expect(tools.some((tool) => tool.name === 'Write')).toBe(false);
    expect(tools.some((tool) => tool.name === 'Edit')).toBe(false);
  });

  test('keeps host-provided ArchiveRead available for child recovery', () => {
    const archiveRead = testCatalogTool('ArchiveRead', 'read');
    const tools = buildChildAgentTools([
      testCatalogTool('Read', 'read'),
      testCatalogTool('Glob', 'read'),
      testCatalogTool('Grep', 'read'),
      testCatalogTool('WebSearch', 'web_read'),
      archiveRead,
    ]);

    expect(tools.find((tool) => tool.name === 'ArchiveRead')).toBe(archiveRead);
  });

  test('child agent toolset enforces explore-mode read-only behavior without prompting', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-child-tools-'));
    try {
      await writeFile(join(cwd, 'notes.txt'), 'SUBAGENT_CHILD_TOOL_MARKER\n', 'utf8');
      const events: SessionEvent[] = [];
      const runtime = makeChildToolRuntime(cwd);
      const tools = new Map(
        buildChildAgentTools(buildBuiltinTools()).map((tool) => [tool.name, tool]),
      );

      await runTool(runtime, tools, 'Read', { path: 'notes.txt' }, events);
      await runTool(runtime, tools, 'Glob', { pattern: '*.txt' }, events);
      await runTool(runtime, tools, 'Grep', { pattern: 'SUBAGENT_CHILD_TOOL_MARKER' }, events);

      expect(events.some((event) => event.type === 'permission_request')).toBe(false);
      expect(tools.has('Bash')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('agent_spawn delegates an explicit profile and task through the narrow context capability', async () => {
    const tool = buildSubagentSpawnTool();
    const abortController = new AbortController();
    const calls: unknown[] = [];
    const output: Array<{ stream: string; chunk: string }> = [];

    const result = await tool.impl(
      {
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the runtime tests.',
      },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-1',
        abortSignal: abortController.signal,
        emitOutput: (stream, chunk) => output.push({ stream, chunk }),
        spawnChildSession: async (input) => {
          calls.push(input);
          input.onEvent?.({
            type: 'tool_start',
            id: 'child-start',
            turnId: 'child-turn',
            ts: 1,
            toolUseId: 'child-tool',
            toolName: 'Read',
            displayName: 'Read file',
            args: { path: 'secret.txt' },
          });
          input.onEvent?.({
            type: 'tool_result',
            id: 'child-result',
            turnId: 'child-turn',
            ts: 2,
            toolUseId: 'child-tool',
            isError: false,
            content: { kind: 'text', text: 'secret body' },
          });
          return {
            childSessionId: 'child-session',
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            turnId: 'child-turn',
            runId: 'child-run',
            status: 'completed',
            permissionMode: 'explore',
            summary: 'done',
            artifactIds: [],
          };
        },
      },
    );

    expect(tool.name).toBe(AGENT_SPAWN_TOOL_NAME);
    expect(tool.categoryHint).toBe('subagent');
    expect(tool.permissionRequired).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      agentProfile: string;
      prompt: string;
      onEvent?: (event: SessionEvent) => void;
    };
    expect(call.agentProfile).toBe(LOCAL_READ_AGENT_PROFILE);
    expect(call.prompt).toBe('Inspect the runtime tests.');
    expect(typeof call.onEvent).toBe('function');
    expect(output).toEqual([
      { stream: 'stdout', chunk: 'Starting child agent: Local Read\n' },
      { stream: 'stdout', chunk: 'Child tool started: Read file\n' },
      { stream: 'stdout', chunk: 'Child tool finished: Read file\n' },
      { stream: 'stdout', chunk: 'Child agent Local Read: completed\n' },
    ]);
    expect(JSON.stringify(output)).not.toContain('secret.txt');
    expect(JSON.stringify(output)).not.toContain('secret body');
    expect(result).toEqual({
      kind: 'subagent',
      childSessionId: 'child-session',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Local Read',
      turnId: 'child-turn',
      runId: 'child-run',
      status: 'completed',
      permissionMode: 'explore',
      summary: 'done',
      artifactIds: [],
    });
  });

  test('agent_spawn bounds projected child tool activity', async () => {
    const tool = buildSubagentSpawnTool();
    const output: string[] = [];

    await tool.impl(
      {
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect many files.',
      },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (_stream, chunk) => output.push(chunk),
        spawnChildSession: async (input) => {
          for (let index = 0; index < 100; index += 1) {
            input.onEvent?.({
              type: 'tool_start',
              id: `start-${index}`,
              turnId: 'child-turn',
              ts: index,
              toolUseId: `child-tool-${index}`,
              toolName: 'Read',
              args: { path: `${index}.txt` },
            });
          }
          return {
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            turnId: 'child-turn',
            status: 'completed',
            permissionMode: 'explore',
            summary: 'done',
            artifactIds: [],
          };
        },
      },
    );

    expect(output).toHaveLength(66);
    expect(output[0]).toBe('Starting child agent: Local Read\n');
    expect(output.at(-1)).toBe('Child agent Local Read: completed\n');
  });

  test('agent_spawn bounds projected startup failures', async () => {
    const tool = buildSubagentSpawnTool();
    const output: string[] = [];

    await expectRejects(
      Promise.resolve(
        tool.impl(
          {
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Fail.',
          },
          {
            sessionId: 'session-1',
            turnId: 'parent-turn',
            cwd: '/tmp',
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: (_stream, chunk) => output.push(chunk),
            spawnChildSession: async () => {
              throw new Error('x'.repeat(10_000));
            },
          },
        ),
      ),
      /^x+$/,
    );

    expect(output).toHaveLength(2);
    expect((output[1]?.length ?? Number.POSITIVE_INFINITY) < 1_100).toBe(true);
  });

  test('agent_spawn delegates web_research through the catalog definition', async () => {
    const tool = buildSubagentSpawnTool();
    const calls: unknown[] = [];

    const result = await tool.impl(
      {
        profile: WEB_RESEARCH_AGENT_PROFILE,
        task: 'Find current sources.',
        write_back: AGENT_WRITE_BACK_SUMMARY,
        isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
      },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        spawnChildSession: async (input) => {
          calls.push(input);
          return {
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            turnId: 'child-turn',
            status: 'completed',
            permissionMode: 'execute',
            summary: 'done',
            artifactIds: [],
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      agentProfile: string;
      prompt: string;
      onEvent?: (event: SessionEvent) => void;
    };
    expect(call.agentProfile).toBe(WEB_RESEARCH_AGENT_PROFILE);
    expect(call.prompt).toBe('Find current sources.');
    expect(typeof call.onEvent).toBe('function');
    expect(result).toMatchObject({
      kind: 'subagent',
      agentId: WEB_RESEARCH_AGENT_ID,
      agentName: 'Web Research',
      permissionMode: 'execute',
    });
  });

  test('agent_spawn binds a current-session task and records real child refs without auto-completing', async () => {
    const task: Task = {
      id: 'task-uuid',
      key: 'T1',
      subject: 'inspect runtime',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: string[] = [];
    const ledger = taskLedgerStub(task, calls);
    const tool = buildSubagentSpawnTool({ taskLedger: ledger });
    const result = await tool.impl(
      {
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the runtime tests.',
        task_id: 'T1',
      },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        spawnChildSession: async (input) => {
          await input.onReady?.({
            childSessionId: 'child-session',
            runId: 'child-run',
            turnId: 'child-turn',
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
          });
          return {
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            runId: 'child-run',
            turnId: 'child-turn',
            status: 'completed',
            permissionMode: 'explore',
            summary: 'inspection complete',
            artifactIds: [],
          };
        },
      },
    );
    expect(calls).toEqual(['get:session-1:T1', 'claim:child-turn', 'settle:completed:child-run']);
    expect(task.status).toBe('in_progress');
    expect(task.owner).toEqual({
      actor: 'child_agent',
      sessionId: 'child-session',
      agentId: LOCAL_READ_AGENT_ID,
      runId: 'child-run',
      turnId: 'child-turn',
    });
    expect(result).toMatchObject({ kind: 'subagent', runId: 'child-run', status: 'completed' });
  });

  test('agent_spawn permission denial leaves a bound task untouched and never starts a child', async () => {
    const task: Task = {
      id: 'task-permission-denied',
      key: 'T1',
      subject: 'inspect runtime',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: string[] = [];
    const events: SessionEvent[] = [];
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('parent-turn');
    const header = childHeader('/tmp/cwd');
    header.permissionMode = 'ask';
    let spawned = false;
    const runtime = new ToolRuntime({
      sessionId: 'session-1',
      header,
      connection: testConnection(),
      modelId: 'mock-model',
      appendMessage: async () => {},
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
      getCurrentRunId: () => 'parent-run',
      spawnChildSession: async () => {
        spawned = true;
        return {};
      },
    });
    const tool = buildSubagentSpawnTool({ taskLedger: taskLedgerStub(task, calls) });
    const pending = runtime
      .settleToolCall({
        tool,
        turnId: 'parent-turn',
        toolCallId: 'tool-agent-spawn-denied',
        input: {
          profile: LOCAL_READ_AGENT_PROFILE,
          task: 'Inspect the runtime tests.',
          task_id: task.key,
        },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => events.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            events.push(event);
          },
        },
      })
      .then((settlement) => settlement.result);
    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const request = events.find(
      (event): event is Extract<SessionEvent, { type: 'permission_request' }> =>
        event.type === 'permission_request',
    );
    expect(request).toBeDefined();
    expect(calls).toEqual([]);
    expect(spawned).toBe(false);

    permissionEngine.recordResponse('parent-turn', {
      requestId: request?.requestId ?? 'missing',
      decision: 'deny',
    });
    const result = await pending;

    expect(result).toMatchObject({ error: '用户已拒绝权限请求' });
    expect(calls).toEqual([]);
    expect(spawned).toBe(false);
    expect(task.status).toBe('pending');
    expect(task.owner).toBeUndefined();
  });

  test('agent_spawn rejects a forged task reference before starting a child', async () => {
    let spawned = false;
    const ledger = taskLedgerStub(undefined, []);
    const tool = buildSubagentSpawnTool({ taskLedger: ledger });
    await expectRejects(
      Promise.resolve(
        tool.impl(
          {
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Inspect.',
            task_id: 'T99',
          },
          {
            sessionId: 'session-1',
            turnId: 'parent-turn',
            cwd: '/tmp',
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
            spawnChildSession: async () => {
              spawned = true;
              return {};
            },
          },
        ),
      ),
      /No such task in this session/,
    );
    expect(spawned).toBe(false);
  });

  test('agent_spawn records failed and cancelled child outcomes with real refs', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const task: Task = {
        id: `task-${status}`,
        key: 'T1',
        subject: status,
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      };
      const calls: string[] = [];
      const tool = buildSubagentSpawnTool({ taskLedger: taskLedgerStub(task, calls) });
      const result = await tool.impl(
        {
          profile: LOCAL_READ_AGENT_PROFILE,
          task: `Run child that becomes ${status}.`,
          task_id: task.key,
        },
        {
          sessionId: 'session-1',
          turnId: 'parent-turn',
          cwd: '/tmp',
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
          spawnChildSession: async (input) => {
            await input.onReady?.({
              childSessionId: 'child-session',
              runId: 'child-run',
              turnId: `child-${status}`,
              agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
              agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            });
            return {
              agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
              agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
              runId: `run-${status}`,
              turnId: `child-${status}`,
              status,
              permissionMode: 'explore',
              summary: `${status} summary`,
              artifactIds: [],
            };
          },
        },
      );
      expect(calls).toEqual([
        'get:session-1:T1',
        `claim:child-${status}`,
        `settle:${status}:run-${status}`,
      ]);
      expect(task.status).toBe(status);
      expect(task.owner).toEqual({
        actor: 'child_agent',
        sessionId: 'child-session',
        agentId: LOCAL_READ_AGENT_ID,
        runId: `run-${status}`,
        turnId: `child-${status}`,
      });
      expect(result).toMatchObject({ kind: 'subagent', status, runId: `run-${status}` });
    }
  });

  test('agent_spawn marks a claimed task failed when child startup throws', async () => {
    const task: Task = {
      id: 'task-startup-failure',
      key: 'T1',
      subject: 'startup',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: string[] = [];
    const tool = buildSubagentSpawnTool({ taskLedger: taskLedgerStub(task, calls) });
    await expectRejects(
      Promise.resolve(
        tool.impl(
          {
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Fail after allocating the child turn.',
            task_id: task.key,
          },
          {
            sessionId: 'session-1',
            turnId: 'parent-turn',
            cwd: '/tmp',
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
            spawnChildSession: async (input) => {
              await input.onReady?.({
                childSessionId: 'child-session',
                runId: 'child-run',
                turnId: 'child-turn',
                agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
                agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
              });
              throw new Error('child startup failed');
            },
          },
        ),
      ),
      /child startup failed/,
    );
    expect(calls).toEqual(['get:session-1:T1', 'claim:child-turn', 'settle:failed:undefined']);
    expect(task.status).toBe('failed');
  });

  test('agent_spawn rejects a task reference that only exists in another session', async () => {
    const task: Task = {
      id: 'other-task',
      key: 'T1',
      subject: 'other',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const ledger = taskLedgerStub(task, []);
    ledger.get = async (sessionId) => (sessionId === 'session-2' ? task : undefined);
    let spawned = false;
    const tool = buildSubagentSpawnTool({ taskLedger: ledger });
    await expectRejects(
      Promise.resolve(
        tool.impl(
          {
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Inspect.',
            task_id: task.key,
          },
          {
            sessionId: 'session-1',
            turnId: 'parent-turn',
            cwd: '/tmp',
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
            spawnChildSession: async () => {
              spawned = true;
              return {};
            },
          },
        ),
      ),
      /No such task in this session/,
    );
    expect(spawned).toBe(false);
  });

  test('agent_spawn validates profile contracts and rejects unavailable worktree agents before spawning', async () => {
    const tool = buildSubagentSpawnTool();
    const schema = tool.parameters as {
      safeParse(input: unknown): { success: boolean; data?: unknown };
    };

    expect(
      schema.safeParse({ profile: LOCAL_READ_AGENT_PROFILE, task: 'Inspect the repo.' }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ profile: WEB_RESEARCH_AGENT_PROFILE, task: 'Find current sources.' })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit the repo.',
        write_back: AGENT_WRITE_BACK_PATCH,
        isolation: AGENT_WORKSPACE_WORKTREE,
      }),
    ).toEqual({
      success: true,
      data: {
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit the repo.',
        write_back: AGENT_WRITE_BACK_PATCH,
        isolation: AGENT_WORKSPACE_WORKTREE,
      },
    });
    expect(
      schema.safeParse({
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        write_back: AGENT_WRITE_BACK_SUMMARY,
        isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
      }),
    ).toEqual({
      success: true,
      data: {
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        write_back: AGENT_WRITE_BACK_SUMMARY,
        isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
      },
    });
    expect(
      schema.safeParse({
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        write_back: 'patch',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        profile: LOCAL_READ_AGENT_PROFILE,
        task: 'Inspect the repo.',
        isolation: 'worktree',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit the repo.',
        write_back: AGENT_WRITE_BACK_SUMMARY,
        isolation: AGENT_WORKSPACE_WORKTREE,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        profile: IMPLEMENTATION_AGENT_PROFILE,
        task: 'Edit the repo.',
        write_back: AGENT_WRITE_BACK_PATCH,
        isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ agent: LOCAL_READ_AGENT_ID, task: 'Inspect the repo.' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ profile: LOCAL_READ_AGENT_ID, task: 'Inspect the repo.' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ profile: WEB_RESEARCH_AGENT_ID, task: 'Find current sources.' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ agent_name: 'Researcher', instructions: 'Read only.', prompt: 'Inspect.' })
        .success,
    ).toBe(false);

    await expectRejects(
      Promise.resolve(
        tool.impl(
          {
            profile: IMPLEMENTATION_AGENT_PROFILE,
            task: 'Edit files.',
            write_back: AGENT_WRITE_BACK_PATCH,
            isolation: AGENT_WORKSPACE_WORKTREE,
          },
          {
            sessionId: 'session-1',
            turnId: 'parent-turn',
            cwd: '/tmp/cwd',
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
            spawnChildSession: async () => {
              throw new Error('spawn should not be called');
            },
          },
        ),
      ),
      /worktree child executor/,
    );
  });

  test('agent projection tools delegate through read-only context capabilities', async () => {
    const listTool = buildSubagentListTool();
    const outputTool = buildSubagentOutputTool();

    const list = await listTool.impl(
      {},
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-list',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        listChildAgents: async () => ({
          definitions: [{ id: LOCAL_READ_AGENT_ID }],
          runs: [{ runId: 'child-run', turnId: 'child-turn' }],
        }),
      },
    );
    const output = await outputTool.impl(
      { run_id: 'child-run' },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-output',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        readChildAgentOutput: async (input) => ({ requested: input }),
      },
    );
    const childSessionOutput = await outputTool.impl(
      { child_session_id: 'child-session', run_id: 'child-session-run' },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-output-child-session',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        readChildAgentOutput: async (input) => ({ requested: input }),
      },
    );

    expect(listTool.name).toBe(AGENT_LIST_TOOL_NAME);
    expect(outputTool.name).toBe(AGENT_OUTPUT_TOOL_NAME);
    expect(listTool.permissionRequired).toBe(false);
    expect(outputTool.permissionRequired).toBe(false);
    expect(list).toEqual({
      definitions: [{ id: LOCAL_READ_AGENT_ID }],
      runs: [{ runId: 'child-run', turnId: 'child-turn' }],
    });
    expect(output).toEqual({
      requested: {
        execution: {
          kind: 'legacy_child_run',
          sessionId: 'session-1',
          runId: 'child-run',
        },
      },
    });
    expect(childSessionOutput).toEqual({
      requested: {
        execution: {
          kind: 'child_session',
          sessionId: 'child-session',
          currentRunId: 'child-session-run',
        },
      },
    });
  });

  test('agent_output accepts linked child-session and legacy run locators', () => {
    const outputTool = buildSubagentOutputTool();
    const schema = outputTool.parameters as { safeParse(input: unknown): { success: boolean } };

    expect(schema.safeParse({ run_id: 'child-run' }).success).toBe(true);
    expect(schema.safeParse({ turn_id: 'child-turn' }).success).toBe(true);
    expect(schema.safeParse({ child_session_id: 'child-session' }).success).toBe(true);
    expect(
      schema.safeParse({
        child_session_id: 'child-session',
        run_id: 'child-run',
      }).success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ run_id: 'child-run', turn_id: 'child-turn' }).success).toBe(false);
    expect(
      schema.safeParse({
        child_session_id: 'child-session',
        turn_id: 'child-turn',
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ child_session_id: '' }).success).toBe(false);
    expect(schema.safeParse({ run_id: '' }).success).toBe(false);
  });
});

function makeChildToolRuntime(cwd: string): ToolRuntime {
  const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
  permissionEngine.beginTurn('child-turn');
  return new ToolRuntime({
    sessionId: 'session-1',
    header: childHeader(cwd),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    permissionEngine,
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
}

async function runTool(
  runtime: ToolRuntime,
  tools: Map<string, MakaTool>,
  name: string,
  args: unknown,
  events: SessionEvent[],
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing child tool ${name}`);
  return (
    await runtime.settleToolCall({
      tool,
      turnId: 'child-turn',
      toolCallId: `tool-${name}-${typeof args === 'object' && args && 'command' in args ? (args as { command: string }).command : 'read'}`,
      input: args,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    })
  ).result;
}

function testCatalogTool(name: string, categoryHint: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    categoryHint,
    impl: async () => ({}),
  };
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error('Expected promise to reject');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function childHeader(cwd: string): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: cwd,
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'explore',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

function taskLedgerStub(task: Task | undefined, calls: string[]): TaskLedgerStore {
  return {
    list: async () => (task ? [task] : []),
    get: async (sessionId, id) => {
      calls.push(`get:${sessionId}:${id}`);
      return task && (task.id === id || task.key === id) ? task : undefined;
    },
    create: async () => ({ created: [], total: task ? 1 : 0 }),
    update: async () => {
      if (!task) throw new Error('No such task');
      return { updated: task, total: 1 };
    },
    claim: async (_sessionId, _id, owner: TaskOwner) => {
      if (!task) throw new Error('No such task');
      calls.push(`claim:${owner.turnId}`);
      task.status = 'in_progress';
      task.owner = owner;
      return { updated: task, total: 1 };
    },
    claimAvailable: async (_sessionId, _id, owner: TaskOwner) => {
      if (!task) throw new Error('No such task');
      calls.push(`claimAvailable:${owner.turnId}`);
      task.status = 'in_progress';
      task.owner = owner;
      return { updated: task, total: 1 };
    },
    settleAgentOutcome: async (_sessionId, _id, outcome: TaskAgentOutcome) => {
      if (!task) throw new Error('No such task');
      calls.push(`settle:${outcome.status}:${outcome.owner.runId}`);
      task.owner = outcome.owner;
      if (outcome.status === 'failed') task.status = 'failed';
      if (outcome.status === 'cancelled') task.status = 'cancelled';
      return { updated: task, total: 1 };
    },
    subscribe: () => () => {},
  };
}
