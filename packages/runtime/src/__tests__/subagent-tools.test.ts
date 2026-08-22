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

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { Task, TaskAgentOutcome, TaskLedgerStore, TaskOwner } from '@maka/core/task-ledger';
import type { SessionEvent } from '@maka/core/events';
import { zodSchema } from 'ai';
import { buildBuiltinTools } from '../builtin-tools.js';
import {
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
    expect(spawnTool.categoryHint).toBe('subagent');
    expect(buildParentAgentTools().map((tool) => tool.name)).toEqual([
      AGENT_SPAWN_TOOL_NAME,
      AGENT_LIST_TOOL_NAME,
      AGENT_OUTPUT_TOOL_NAME,
    ]);
  });

  test('parent tools advertise only definitions runnable in their composition', () => {
    const tools = buildParentAgentTools({ definitions: [LOCAL_READ_AGENT_DEFINITION] });
    const spawn = tools.find((tool) => tool.name === AGENT_SPAWN_TOOL_NAME);
    expect(spawn).toBeDefined();
    const spawnSchema = spawn!.parameters as {
      safeParse(input: unknown): { success: boolean };
    };
    expect(
      spawnSchema.safeParse({ profile: LOCAL_READ_AGENT_PROFILE, task: 'Inspect the repo.' })
        .success,
    ).toBe(true);
    expect(
      spawnSchema.safeParse({ profile: WEB_RESEARCH_AGENT_PROFILE, task: 'Search the web.' })
        .success,
    ).toBe(false);
    expect(
      spawnSchema.safeParse({ profile: IMPLEMENTATION_AGENT_PROFILE, task: 'Change a file.' })
        .success,
    ).toBe(false);
    expect(buildParentAgentTools({ definitions: [] }).map((tool) => tool.name)).toEqual([
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
      'subagent_id',
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
    ).toEqual(['profile', 'subagent_id', 'task', 'write_back', 'isolation', 'task_id']);
  });

  test('agent_spawn strips task_id when task binding is unavailable', () => {
    const schema = buildSubagentSpawnTool().parameters as {
      safeParse(input: unknown): { success: boolean; data?: Record<string, unknown> };
    };

    const parsed = schema.safeParse({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the repo.',
      task_id: 'T1',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      profile: LOCAL_READ_AGENT_PROFILE,
      task: 'Inspect the repo.',
    });

    const presetParsed = schema.safeParse({
      profile: 'not-a-real-profile',
      subagent_id: 'fast-reader',
      task: 'Inspect the repo.',
      task_id: { malformed: true },
      ignored: true,
    });
    expect(presetParsed.success).toBe(true);
    expect(presetParsed.data).toEqual({
      subagent_id: 'fast-reader',
      task: 'Inspect the repo.',
    });
  });

  test('agent_spawn names both recovery routes when no child selector is provided', () => {
    const schema = buildSubagentSpawnTool({
      definitions: [LOCAL_READ_AGENT_DEFINITION, WEB_RESEARCH_AGENT_DEFINITION],
    }).parameters as {
      safeParse(input: unknown): {
        success: boolean;
        error?: { issues: Array<{ message: string }> };
      };
    };

    const parsed = schema.safeParse({ task: 'Inspect the repo.' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      'No child selector was provided. Call agent_list and pass a returned subagent_id to agent_spawn, or pass one legacy profile: local_read, web_research.',
    );
  });

  test('built-in catalog exposes local-read without shell, web, nested, or write tools', () => {
    const definitions = listBuiltinAgentDefinitions({
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', 'web_read'),
      ],
    });
    const localRead = definitions.find((definition) => definition.id === LOCAL_READ_AGENT_ID);
    expect(localRead?.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(localRead?.availability).toEqual({ status: 'available' });
  });

  test('built-in catalog exposes web-research with only WebSearch and no local or write tools', () => {
    const withWebSearch = listBuiltinAgentDefinitions({
      tools: [
        testCatalogTool('Read', 'read'),
        testCatalogTool('Glob', 'read'),
        testCatalogTool('Grep', 'read'),
        testCatalogTool('WebSearch', undefined),
      ],
    });
    const webResearch = withWebSearch.find((definition) => definition.id === WEB_RESEARCH_AGENT_ID);
    expect(webResearch?.tools).toEqual(['WebSearch']);
    expect(webResearch?.availability).toEqual({ status: 'available' });

    expect(
      listBuiltinAgentDefinitions({
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
  });

  test('built-in catalog exposes implementation only when a worktree executor is available', async () => {
    const availability = listBuiltinAgentDefinitions({
      tools: implementationCatalogTools(),
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
          definition: IMPLEMENTATION_AGENT_DEFINITION,
          tools: implementationCatalogTools(),
        }),
      ),
      /worktree child executor/,
    );

    const runnableAvailability = listBuiltinAgentDefinitions({
      worktreeChildExecutorAvailable: true,
      tools: implementationCatalogTools(),
    }).find((definition) => definition.id === IMPLEMENTATION_AGENT_ID)?.availability;
    expect(runnableAvailability).toEqual({ status: 'available' });
    assertAgentDefinitionRunnable({
      worktreeChildExecutorAvailable: true,
      definition: IMPLEMENTATION_AGENT_DEFINITION,
      tools: implementationCatalogTools(),
    });
  });

  test('agent definition policy uses the explicit tool allowlist', () => {
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
        },
        testCatalogTool('WebSearch', 'web_read'),
      ),
    ).toEqual({
      category: 'web_read',
      decision: 'allow',
    });
  });

  test('implementation remains available with the Write and Edit fallback', () => {
    const tools = implementationCatalogTools().filter((tool) => tool.name !== 'apply_patch');
    expect(
      evaluateAgentDefinitionAvailability({
        definition: IMPLEMENTATION_AGENT_DEFINITION,
        tools,
        worktreeChildExecutorAvailable: true,
      }),
    ).toEqual({ status: 'available' });
  });

  test('implementation remains available with the ApplyPatch alternative', () => {
    const tools = implementationCatalogTools().filter(
      (tool) => tool.name !== 'Write' && tool.name !== 'Edit',
    );
    expect(
      evaluateAgentDefinitionAvailability({
        definition: IMPLEMENTATION_AGENT_DEFINITION,
        tools,
        worktreeChildExecutorAvailable: true,
      }),
    ).toEqual({ status: 'available' });
  });

  test('child agent toolset keeps only built-in profile allowlisted tools', () => {
    const tools = buildChildAgentTools([
      ...buildBuiltinTools(),
      testCatalogTool('WriteStdin', 'shell_unsafe'),
      testCatalogTool('StopBackgroundTask', 'shell_unsafe'),
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

    expect(tools.map((tool) => tool.name)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'Write',
      'Edit',
      'apply_patch',
      'Bash',
      'WriteStdin',
      'StopBackgroundTask',
    ]);
    expect([...CHILD_AGENT_TOOL_NAMES]).toEqual([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'Write',
      'Edit',
      'apply_patch',
      'Bash',
      'WriteStdin',
      'StopBackgroundTask',
    ]);
  });

  test('does not smuggle ArchiveRead through the child allowlist', () => {
    // The pool-level pass-through this replaces never worked: every child
    // surface is re-narrowed against `definition.tools`, and no definition
    // lists ArchiveRead. The decoder now reaches a child from its own backend's
    // archive capability, so the allowlist stays exactly what it says it is.
    const tools = buildChildAgentTools([
      testCatalogTool('Read', 'read'),
      testCatalogTool('Glob', 'read'),
      testCatalogTool('Grep', 'read'),
      testCatalogTool('WebSearch', 'web_read'),
      testCatalogTool('ArchiveRead', 'read'),
    ]);

    expect(tools.find((tool) => tool.name === 'ArchiveRead')).toBeUndefined();
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
      expect(tools.has('Bash')).toBe(true);
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
        task_id: 'ignored-without-task-binding',
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
            profile: input.agentProfile,
            childSessionId: 'child-session',
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            turnId: 'child-turn',
            runId: 'child-run',
            status: 'completed',
            permissionMode: 'explore',
            summary: 'done',
            artifactIds: [],
            internalField: 'must not cross the tool result boundary',
          };
        },
      },
    );

    expect(tool.name).toBe(AGENT_SPAWN_TOOL_NAME);
    expect(tool.categoryHint).toBe('subagent');
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
            permissionMode: 'explore',
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
              permissionMode: 'explore',
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
                permissionMode: 'explore',
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

  test('agent_spawn validates profile contracts and delegates worktree availability to runtime', async () => {
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

    const calls: unknown[] = [];
    await tool.impl(
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
        spawnChildSession: async (input) => {
          calls.push(input);
          return {
            childSessionId: 'child-session',
            agentId: IMPLEMENTATION_AGENT_ID,
            agentName: 'Implementation',
            turnId: 'child-turn',
            runId: 'child-run',
            status: 'completed',
            permissionMode: 'execute',
            summary: 'done',
            artifactIds: [],
          };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentProfile: IMPLEMENTATION_AGENT_PROFILE,
      prompt: 'Edit files.',
    });
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
          definitions: [
            {
              id: LOCAL_READ_AGENT_ID,
              profile: LOCAL_READ_AGENT_PROFILE,
              name: 'Local Read',
              description: 'Read-only repository exploration.',
              contract: { workspace: 'same_workspace', defaultWriteBack: 'summary' },
              availability: { status: 'available' },
            },
          ],
          presets: [
            {
              id: 'fast-reader',
              name: 'Fast reader',
              description: 'Cheap repository inspection.',
              profile: LOCAL_READ_AGENT_PROFILE,
              model: 'deepseek-v4-flash',
              thinkingLevel: 'low',
              availability: { status: 'available' },
            },
          ],
          executions: [{ execution: { kind: 'legacy_child_run', runId: 'child-run' } }],
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
    expect(list).toEqual({
      presets: [
        {
          subagent_id: 'fast-reader',
          name: 'Fast reader',
          description: 'Cheap repository inspection.',
          profile: LOCAL_READ_AGENT_PROFILE,
          model: 'deepseek-v4-flash',
          thinking_level: 'low',
          status: 'available',
        },
      ],
      legacy_profiles: [
        {
          agent_id: LOCAL_READ_AGENT_ID,
          profile: LOCAL_READ_AGENT_PROFILE,
          name: 'Local Read',
          description: 'Read-only repository exploration.',
          workspace: 'same_workspace',
          write_back: 'summary',
          status: 'available',
        },
      ],
      page: { returned: 1, total: 1 },
      view: 'selection',
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

  test('agent_list keeps discovery compact, paginated, and free of execution history', async () => {
    const listTool = buildSubagentListTool();
    const schema = listTool.parameters as {
      safeParse(input: unknown): {
        success: boolean;
        data?: { view?: string; cursor?: string };
      };
    };
    expect(schema.safeParse({ ignored: true }).data).toEqual({ view: 'selection' });
    expect(schema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);

    const catalog = {
      definitions: [
        {
          id: LOCAL_READ_AGENT_ID,
          profile: LOCAL_READ_AGENT_PROFILE,
          name: 'Local Read',
          description: 'Read-only repository exploration.',
          contract: { workspace: 'same_workspace', defaultWriteBack: 'summary' },
          availability: { status: 'available' },
        },
      ],
      presets: Array.from({ length: 11 }, (_, index) => ({
        id: `reader-${index}`,
        name: `Reader ${index}`,
        description: 'x'.repeat(1_000),
        profile: LOCAL_READ_AGENT_PROFILE,
        model: 'deepseek-v4-flash',
        availability:
          index === 10
            ? { status: 'unavailable', reason: 'connection_disabled' }
            : { status: 'available' },
      })),
      executions: Array.from({ length: 100 }, (_, index) => ({ runId: `run-${index}` })),
      runs: Array.from({ length: 100 }, (_, index) => ({ runId: `legacy-run-${index}` })),
    };
    const call = async (
      input: { view?: 'selection' | 'catalog'; cursor?: string },
      source = catalog,
    ) =>
      (await listTool.impl(input, {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-list-compact',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        listChildAgents: async () => source,
      })) as Record<string, unknown>;

    const first = await call({});
    expect((first.presets as unknown[]).length).toBe(8);
    expect(first.page).toEqual({ returned: 8, total: 10, next_cursor: '8' });
    expect('definitions' in first).toBe(false);
    expect('executions' in first).toBe(false);
    expect('runs' in first).toBe(false);
    expect(JSON.stringify(first).length < 8_192).toBe(true);

    const second = await call({ cursor: '8' });
    expect((second.presets as unknown[]).length).toBe(2);
    expect(second.page).toEqual({ returned: 2, total: 10 });

    const diagnosticTail = await call({ view: 'catalog', cursor: '8' });
    expect(diagnosticTail.page).toEqual({ returned: 3, total: 11 });
    expect((diagnosticTail.presets as Array<Record<string, unknown>>)[2]).toMatchObject({
      subagent_id: 'reader-10',
      status: 'unavailable',
      reason: 'connection_disabled',
    });

    const worstCase = await call(
      {},
      {
        ...catalog,
        definitions: catalog.definitions.map((definition) => ({
          ...definition,
          name: 'n'.repeat(128),
          description: 'd'.repeat(1_000),
        })),
        presets: catalog.presets.map((preset, index) => ({
          ...preset,
          id: `reader-${index}`.padEnd(128, 'x'),
          name: 'n'.repeat(128),
          model: 'm'.repeat(500),
        })),
      },
    );
    expect(JSON.stringify(worstCase).length <= 7_000).toBe(true);
  });

  test('agent_output uses an explicit locator when a provider fills unrelated fields', async () => {
    const outputTool = buildSubagentOutputTool();
    const parsed = (
      outputTool.parameters as {
        safeParse(input: unknown): { success: boolean; data?: Record<string, unknown> };
      }
    ).safeParse({
      locator: 'child_session_run',
      child_session_id: 'child-session',
      run_id: 'child-run',
      turn_id: { malformed: true },
      ignored: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      locator: 'child_session_run',
      child_session_id: 'child-session',
      run_id: 'child-run',
    });

    const output = await outputTool.impl(
      {
        locator: 'child_session_run',
        child_session_id: 'child-session',
        run_id: 'child-run',
        turn_id: 'provider-placeholder',
        max_events: 100,
        max_bytes: 32_768,
        view: 'runtime_events',
      },
      {
        sessionId: 'session-1',
        turnId: 'parent-turn',
        cwd: '/tmp/cwd',
        toolCallId: 'tool-output-provider-filled',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        readChildAgentOutput: async (input) => ({ requested: input }),
      },
    );

    expect(output).toEqual({
      requested: {
        execution: {
          kind: 'child_session',
          sessionId: 'child-session',
          currentRunId: 'child-run',
        },
        maxEvents: 100,
        maxBytes: 32_768,
        view: 'runtime_events',
      },
    });
  });
});

function makeChildToolRuntime(cwd: string): ToolRuntime {
  return createTestToolRuntime({
    sessionId: 'session-1',
    header: childHeader(cwd),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
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

function implementationCatalogTools(): MakaTool[] {
  return IMPLEMENTATION_AGENT_DEFINITION.tools.map((name) => testCatalogTool(name, undefined));
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
