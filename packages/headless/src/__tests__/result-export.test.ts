import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  renderTaskRunMarkdown,
  taskRunExportFromProjection,
  writeTaskRunExport,
} from '../result-export.js';
import type { HeavyTaskTodoItem, TaskEvent } from '../task-contracts.js';
import { projectTaskRun } from '../task-run-projection.js';

describe('task run export', () => {
  test('projects runtime, verifier, score, budget, isolation, inbox, and taxonomy', async () => {
    const events: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'e1',
        taskRunId: 'run-1',
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'task_run_started',
        id: 'e2',
        taskRunId: 'run-1',
        ts: 2,
        startedAt: 2,
        sessionId: 'session-1',
        agentRunId: 'agent-1',
      },
      {
        type: 'isolation_policy_recorded',
        id: 'e3',
        taskRunId: 'run-1',
        ts: 2,
        facts: {
          schemaVersion: 1,
          backendKind: 'fake',
          required: false,
          mode: 'inert_fake_backend',
          assertionSource: 'test_fixture',
          validatedAt: 2,
        },
      },
      {
        type: 'feedback_observed',
        id: 'e4',
        taskRunId: 'run-1',
        ts: 3,
        observation: {
          id: 'feedback-1',
          taskRunId: 'run-1',
          ts: 3,
          source: 'runtime',
          summary: 'runtime invocation completed',
          details: {
            runtimeRefs: { runtimeEventIds: ['runtime-1'] },
            budget: { totals: { total: 3 } },
          },
        },
      },
      {
        type: 'heavy_task_mode_recorded',
        id: 'e4a',
        taskRunId: 'run-1',
        ts: 3,
        facts: {
          schemaVersion: 1,
          enabled: true,
          triggerSource: 'config',
          triggerReason: 'long benchmark task',
          policyVersion: 'maka-heavy-task-policy.v1',
        },
      },
      {
        type: 'economy_task_mode_recorded',
        id: 'e4b',
        taskRunId: 'run-1',
        ts: 3,
        facts: {
          schemaVersion: 1,
          enabled: true,
          triggerSource: 'config',
          triggerReason: 'simple benchmark task',
          policyVersion: 'maka-economy-task-policy.v1',
        },
      },
      {
        type: 'verifier_result_recorded',
        id: 'e5',
        taskRunId: 'run-1',
        ts: 4,
        result: {
          id: 'verifier-1',
          taskRunId: 'run-1',
          ts: 4,
          kind: 'terminal_bench',
          passed: true,
          exitCode: 0,
          score: 1,
          maxScore: 1,
          authority: { source: 'official_harbor_verifier', authoritative: true },
          submittedSnapshotId: 'snapshot-1',
          details: { adapter: 'terminal-bench', instanceId: 'tb-1' },
        },
      },
      {
        type: 'task_run_artifact_recorded',
        id: 'e5a',
        taskRunId: 'run-1',
        ts: 4,
        artifact: {
          schemaVersion: 1,
          artifactId: 'artifact-workspace',
          taskRunId: 'run-1',
          ts: 4,
          kind: 'container_workspace',
          workspacePath: '/app',
          authority: { source: 'container_capture', authoritative: true },
        },
      },
      {
        type: 'task_run_artifact_recorded',
        id: 'e5b',
        taskRunId: 'run-1',
        ts: 4,
        artifact: {
          schemaVersion: 1,
          artifactId: 'artifact-diff',
          taskRunId: 'run-1',
          ts: 4,
          kind: 'workspace_diff',
          path: '/logs/artifacts/submission.diff',
          workspacePath: '/app',
          authority: { source: 'container_capture', authoritative: true },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e6',
        taskRunId: 'run-1',
        ts: 5,
        result: {
          id: 'score-1',
          taskRunId: 'run-1',
          ts: 5,
          passed: true,
          scored: true,
          eligible: true,
          score: 1,
          maxScore: 1,
          taxonomy: 'passed',
          authority: { source: 'official_harbor_verifier', authoritative: true },
          details: {
            runtimeRefs: { runtimeEventIds: ['runtime-1'] },
            budget: { totals: { total: 3 } },
            tools: {
              providerVisibleToolCount: 2,
              actualToolCalls: 2,
              actualToolNames: ['Read', 'Bash'],
              actualToolCallCounts: { Read: 1, Bash: 1 },
            },
            submittedSnapshot: { id: 'snapshot-1', manifestHash: 'sha256:abc' },
          },
        },
      },
      { type: 'task_run_completed', id: 'e7', taskRunId: 'run-1', ts: 6, finishedAt: 6 },
    ];
    const projection = projectTaskRun(events, 'run-1');
    const exported = taskRunExportFromProjection(projection, {
      exportedAt: '2026-06-19T00:00:00.000Z',
    });

    assert.equal(exported.schemaVersion, 'maka.task_run_export.v1');
    assert.equal(exported.taskRun.taskRunId, 'run-1');
    assert.deepEqual(exported.runtime.trajectoryRefs.runtimeEventIds, ['runtime-1']);
    assert.deepEqual(exported.workspace.submittedSnapshot, {
      id: 'snapshot-1',
      manifestHash: 'sha256:abc',
    });
    assert.equal(exported.workspace.primaryWorkspacePath, '/app');
    assert.equal(exported.workspace.diff.status, 'present');
    assert.equal(exported.workspace.diff.path, '/logs/artifacts/submission.diff');
    assert.equal(exported.artifacts.primaryWorkspacePath, '/app');
    assert.equal(
      exported.artifacts.byKind.workspace_diff?.[0]?.path,
      '/logs/artifacts/submission.diff',
    );
    assert.equal(exported.verifier?.benchmark?.instanceId, 'tb-1');
    assert.deepEqual(exported.budget, { totals: { total: 3 } });
    assert.deepEqual(exported.economy, {
      tokens: { total: 3 },
      tools: {
        providerVisibleToolCount: 2,
        actualToolCalls: 2,
        actualToolNames: ['Read', 'Bash'],
        actualToolCallCounts: { Read: 1, Bash: 1 },
      },
    });
    assert.equal(exported.policy?.heavyTask?.enabled, true);
    assert.equal(exported.policy?.heavyTask?.triggerReason, 'long benchmark task');
    assert.equal(exported.policy?.economyTask?.enabled, true);
    assert.equal(exported.policy?.economyTask?.triggerReason, 'simple benchmark task');
    assert.equal(exported.isolation.policy?.mode, 'inert_fake_backend');
    assert.equal(exported.taxonomy.value, 'passed');
    assert.equal(exported.legacyResultRecord.passed, true);
    const markdown = renderTaskRunMarkdown(exported);
    assert.match(markdown, /verifier_authority: official_harbor_verifier authoritative=true/);
    assert.match(markdown, /artifacts: 2/);
    assert.match(markdown, /tool_calls: 2/);
    assert.match(markdown, /tokens: 3/);
    assert.match(markdown, /workspace_diff/);
  });

  test('omits default-off task policy metadata from compact exports', () => {
    const exported = taskRunExportFromProjection(
      projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'e1',
            taskRunId: 'run-default',
            ts: 1,
            taskId: 'task-1',
            configId: 'cfg-1',
          },
          {
            type: 'heavy_task_mode_recorded',
            id: 'e2',
            taskRunId: 'run-default',
            ts: 2,
            facts: {
              schemaVersion: 1,
              enabled: false,
              triggerSource: 'default',
              triggerReason: 'heavy-task mode was not explicitly enabled',
              policyVersion: 'maka-heavy-task-policy.v1',
            },
          },
          {
            type: 'economy_task_mode_recorded',
            id: 'e3',
            taskRunId: 'run-default',
            ts: 2,
            facts: {
              schemaVersion: 1,
              enabled: false,
              triggerSource: 'default',
              triggerReason: 'economy-task mode was not explicitly enabled',
              policyVersion: 'maka-economy-task-policy.v1',
            },
          },
        ],
        'run-default',
      ),
    );

    assert.equal(exported.policy, undefined);
    assert.equal(exported.progress, undefined);
  });

  test('exports heavy-task progress snapshots and compact result progress', async () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e1',
          taskRunId: 'run-progress',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_inventory_recorded',
          id: 'e2',
          taskRunId: 'run-progress',
          ts: 2,
          inventory: {
            schemaVersion: 1,
            inventoryId: 'inventory-1',
            taskRunId: 'run-progress',
            ts: 2,
            summary: 'Inspected public files',
            items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
            source: { kind: 'model_tool', toolCallId: 'tool-1' },
          },
        },
        {
          type: 'heavy_task_todos_recorded',
          id: 'e3',
          taskRunId: 'run-progress',
          ts: 3,
          todos: {
            schemaVersion: 1,
            todoSetId: 'todos-1',
            taskRunId: 'run-progress',
            ts: 3,
            items: [
              {
                id: 'edit',
                content: 'Patch implementation',
                status: 'in_progress',
                priority: 'high',
              },
            ],
            source: { kind: 'model_tool', toolCallId: 'tool-2' },
          },
        },
        {
          type: 'heavy_task_self_check_plan_recorded',
          id: 'e3-plan',
          taskRunId: 'run-progress',
          ts: 3.5,
          plan: {
            schemaVersion: 1,
            planId: 'plan-1',
            taskRunId: 'run-progress',
            ts: 3.5,
            finalArtifacts: [
              {
                path: 'build-output.log',
                purpose: 'public self-check artifact',
                publicReason: 'visible public check creates this artifact',
              },
            ],
            selfCheckScratch: {
              root: '/tmp/maka-self-check/run-progress',
              expectedGeneratedPaths: ['/tmp/maka-self-check/run-progress/check.log'],
              publicReason: 'public check outputs stay under scratch',
            },
            workspaceGuardPlan: {
              checkedPaths: ['/app'],
              expectedAddedPaths: ['build-output.log'],
              expectedGeneratedPathsOutsideScratch: [],
              publicReason: 'public guard checks visible workspace paths',
            },
            publicReason: 'plan is derived from visible public task evidence',
            guard: {
              status: 'accepted',
              checkedAt: 3.5,
              categories: [],
              publicReason: 'Accepted as public, task-derived advisory self-check plan.',
            },
            source: { kind: 'model_tool', toolCallId: 'tool-plan' },
          },
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e4',
          taskRunId: 'run-progress',
          ts: 4,
          selfCheck: {
            schemaVersion: 1,
            selfCheckId: 'self-check-1',
            taskRunId: 'run-progress',
            ts: 4,
            status: 'pass',
            publicReason: 'npm test passed against public files.',
            commandEvidence: [
              { command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' },
            ],
            artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
            guard: {
              status: 'accepted',
              checkedAt: 4,
              categories: [],
              publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
            },
            source: { kind: 'model_tool', toolCallId: 'tool-3' },
          },
        },
        {
          type: 'heavy_task_evidence_recorded',
          id: 'e4a',
          taskRunId: 'run-progress',
          ts: 4,
          evidence: {
            schemaVersion: 1,
            evidenceId: 'evidence-bash-1',
            taskRunId: 'run-progress',
            ts: 4,
            kind: 'tool',
            public: true,
            source: { kind: 'model_tool', toolCallId: 'tool-5', toolName: 'Bash' },
            tool: {
              name: 'Bash',
              inputSummary: { command: 'npm test' },
              exitCode: 1,
              ok: false,
              outputs: [
                {
                  stream: 'stdout',
                  excerpt: 'public failure summary',
                  byteCount: 5_500,
                  lineCount: 20,
                  truncated: true,
                  truncationRef: {
                    truncated: true,
                    originalBytes: 5_500,
                    visibleBytes: 22,
                    omittedBytes: 5_478,
                    ref: 'runtime-event-1',
                    refKind: 'runtime_event',
                  },
                },
              ],
              diff: { status: 'not_applicable' },
            },
            links: { runtimeEventIds: ['runtime-event-1'] },
          },
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e5',
          taskRunId: 'run-progress',
          ts: 5,
          selfCheck: {
            schemaVersion: 1,
            selfCheckId: 'self-check-private',
            taskRunId: 'run-progress',
            ts: 5,
            status: 'fail',
            publicReason: 'hidden/tests/private_case.py revealed a failure',
            commandEvidence: [{ command: 'cat hidden/tests/private_case.py' }],
            artifactEvidence: [{ path: 'official-verifier-output.json', kind: 'file' }],
            guard: {
              status: 'accepted',
              checkedAt: 5,
              categories: [],
              publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
            },
            source: { kind: 'model_tool', toolCallId: 'tool-4' },
          },
        },
      ],
      'run-progress',
    );
    const exported = taskRunExportFromProjection(projection, {
      exportedAt: '2026-06-19T00:00:00.000Z',
    });

    assert.equal(exported.progress?.inventory?.latest.inventoryId, 'inventory-1');
    assert.equal(exported.progress?.inventory?.historyCount, 1);
    assert.equal(exported.progress?.todos?.latest.todoSetId, 'todos-1');
    assert.equal(exported.progress?.todos?.historyCount, 1);
    assert.equal(exported.progress?.selfChecks?.latest.selfCheckId, 'self-check-1');
    assert.equal(exported.progress?.selfChecks?.historyCount, 1);
    assert.equal(exported.progress?.selfCheckPlans?.latest.planId, 'plan-1');
    assert.equal(exported.progress?.selfCheckPlans?.audit?.status, 'pass');
    assert.equal(exported.progress?.evidence?.latest.evidenceId, 'evidence-bash-1');
    assert.equal(exported.progress?.evidence?.historyCount, 4);
    assert.ok(
      exported.progress?.evidence?.recent.some(
        (item) => item.check?.linkedSelfCheckId === 'self-check-1',
      ),
    );
    assert.ok(
      exported.progress?.evidence?.recent.some(
        (item) => item.artifact?.path === 'build-output.log',
      ),
    );
    const bashEvidence = exported.progress?.evidence?.recent.find(
      (item) => item.evidenceId === 'evidence-bash-1',
    );
    assert.equal(bashEvidence?.tool?.outputs[0]?.truncationRef?.ref, 'runtime-event-1');

    const outDir = await mkdtemp(join(tmpdir(), 'maka-progress-export-'));
    try {
      const written = await writeTaskRunExport(outDir, projection, {
        exportedAt: '2026-06-19T00:00:00.000Z',
        includeEvents: true,
      });
      const compact = JSON.parse(await readFile(written.files.resultJson, 'utf8')) as {
        progress?: unknown;
      };
      assert.deepEqual(compact.progress, exported.progress);
      const taskRunJson = await readFile(written.files.taskRunJson, 'utf8');
      const compactJson = await readFile(written.files.resultJson, 'utf8');
      const eventsJsonl = await readFile(written.files.eventsJsonl!, 'utf8');
      assert.doesNotMatch(taskRunJson, /private_case|official-verifier-output/);
      assert.doesNotMatch(compactJson, /private_case|official-verifier-output/);
      assert.doesNotMatch(eventsJsonl, /private_case|official-verifier-output/);
      assert.doesNotMatch(taskRunJson, /x{3000}|raw large stdout|old edit string|new edit string/);
      assert.match(compactJson, /evidence-bash-1/);
      assert.match(compactJson, /runtime-event-1/);
      assert.match(eventsJsonl, /self-check-1/);
      assert.match(eventsJsonl, /evidence-bash-1/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('exports heavy-task dual runtime and semantic completion status in full and compact views', async () => {
    const projection = projectTaskRun(heavyTaskCompletionEvents(), 'run-heavy-complete');
    const exported = taskRunExportFromProjection(projection, {
      exportedAt: '2026-06-19T00:00:00.000Z',
    });

    assert.equal(exported.taskRun.status, 'budget_exhausted');
    assert.equal(exported.taxonomy.value, 'verification_failed');
    assert.equal(exported.taxonomy.passed, false);
    assert.equal(exported.legacyResultRecord.passed, false);
    assert.equal(exported.heavyTask?.mode?.enabled, true);
    assert.equal(exported.heavyTask?.completion.runtime.taskRunStatus, 'budget_exhausted');
    assert.equal(exported.heavyTask?.completion.runtime.taxonomy, 'verification_failed');
    assert.equal(exported.heavyTask?.completion.runtime.capLike, true);
    assert.equal(exported.heavyTask?.completion.semantic.status, 'complete');
    assert.equal(exported.heavyTask?.completion.semantic.advisory, true);
    assert.equal(exported.heavyTask?.selfCheckPlan?.latest?.planId, 'plan-1');
    assert.equal(exported.heavyTask?.selfCheckPlan?.audit?.status, 'pass');
    assert.deepEqual(exported.heavyTask?.completion.semantic.unresolvedTodoIds, []);
    assert.deepEqual(exported.heavyTask?.completion.semantic.nonblockingTodoIds, [
      'optional-polish',
    ]);
    assert.equal(exported.heavyTask?.completion.finalization.eligible, true);
    assert.equal(exported.score?.taxonomy, 'verification_failed');
    assert.equal(exported.verifier?.passed, false);

    const outDir = await mkdtemp(join(tmpdir(), 'maka-heavy-task-export-'));
    try {
      const written = await writeTaskRunExport(outDir, projection, {
        exportedAt: '2026-06-19T00:00:00.000Z',
      });
      const compact = JSON.parse(await readFile(written.files.resultJson, 'utf8'));
      assert.deepEqual(compact.heavyTask, exported.heavyTask);
      assert.equal(compact.taxonomy.value, 'verification_failed');
      assert.equal(compact.legacyResultRecord.passed, false);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('exports semantic incomplete and finalization ineligible when todos are unresolved', () => {
    const events = heavyTaskCompletionEvents([
      { id: 'edit', content: 'Patch implementation', status: 'completed', priority: 'high' },
      {
        id: 'artifact',
        kind: 'runnable_artifact',
        content: 'Create first runnable artifact',
        status: 'completed',
        priority: 'high',
        evidence: 'Runnable artifact exists in public workspace.',
      },
      {
        id: 'check',
        kind: 'public_check',
        content: 'Run public check',
        status: 'completed',
        priority: 'high',
        evidence: 'Public check passed.',
      },
      { id: 'verify', content: 'Run public checks', status: 'pending', priority: 'high' },
    ]);
    const exported = taskRunExportFromProjection(projectTaskRun(events, 'run-heavy-complete'));

    assert.equal(exported.heavyTask?.completion.runtime.capLike, true);
    assert.equal(exported.heavyTask?.completion.semantic.status, 'incomplete');
    assert.deepEqual(exported.heavyTask?.completion.semantic.unresolvedTodoIds, ['verify']);
    assert.equal(exported.heavyTask?.completion.finalization.eligible, false);
    assert.equal(exported.taxonomy.value, 'verification_failed');
    assert.equal(exported.legacyResultRecord.passed, false);
  });

  test('exports latest heavy-task self-check gate state in full and compact views', async () => {
    const projection = projectTaskRun(
      [
        ...heavyTaskCompletionEvents(),
        {
          type: 'heavy_task_self_check_gate_recorded',
          id: 'gate-1',
          taskRunId: 'run-heavy-complete',
          ts: 7,
          gate: {
            schemaVersion: 1,
            action: 'allow_official_verifier_after_bounded_attempt',
            reason: 'latest self-check status is inconclusive',
            attempt: 1,
            maxAttempts: 1,
            checklist: [
              {
                id: 'check-1',
                kind: 'required_artifact',
                source: 'task_instruction',
                description: 'Visible task instruction requires artifact /app/report.jsonl',
                evidenceRequired: 'command_or_artifact',
                path: '/app/report.jsonl',
              },
            ],
          },
        } satisfies TaskEvent,
      ],
      'run-heavy-complete',
    );
    const exported = taskRunExportFromProjection(projection, {
      exportedAt: '2026-06-19T00:00:00.000Z',
    });

    assert.equal(
      exported.heavyTask?.selfCheckGate?.action,
      'allow_official_verifier_after_bounded_attempt',
    );
    assert.equal(exported.progress?.selfCheckGates?.historyCount, 1);
    assert.equal(exported.progress?.selfCheckGates?.latest.checklist[0]?.path, '/app/report.jsonl');

    const outDir = await mkdtemp(join(tmpdir(), 'maka-heavy-task-gate-export-'));
    try {
      const written = await writeTaskRunExport(outDir, projection, {
        exportedAt: '2026-06-19T00:00:00.000Z',
        includeEvents: true,
      });
      const compact = JSON.parse(await readFile(written.files.resultJson, 'utf8'));
      assert.deepEqual(compact.heavyTask.selfCheckGate, exported.heavyTask?.selfCheckGate);
      assert.match(
        await readFile(written.files.eventsJsonl!, 'utf8'),
        /heavy_task_self_check_gate_recorded/,
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('exports official verifier truth over a non-authoritative placeholder result', async () => {
    const events: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'e1',
        taskRunId: 'run-official',
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'verifier_result_recorded',
        id: 'e2',
        taskRunId: 'run-official',
        ts: 2,
        result: {
          id: 'placeholder-verifier',
          taskRunId: 'run-official',
          ts: 2,
          kind: 'terminal_bench',
          passed: false,
          exitCode: null,
          errorClass: 'unsupported_adapter',
          authority: { source: 'self_check', authoritative: false },
          details: { verificationPlaceholder: true },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e3',
        taskRunId: 'run-official',
        ts: 2,
        result: {
          id: 'placeholder-score',
          taskRunId: 'run-official',
          ts: 2,
          passed: false,
          scored: false,
          eligible: false,
          taxonomy: 'unsupported_adapter',
          errorClass: 'unsupported_adapter',
          authority: { source: 'self_check', authoritative: false },
        },
      },
      { type: 'task_run_completed', id: 'e4', taskRunId: 'run-official', ts: 3, finishedAt: 3 },
      {
        type: 'verifier_result_recorded',
        id: 'e5',
        taskRunId: 'run-official',
        ts: 4,
        result: {
          id: 'official-verifier',
          taskRunId: 'run-official',
          ts: 4,
          kind: 'terminal_bench',
          passed: true,
          exitCode: 0,
          score: 1,
          maxScore: 1,
          authority: { source: 'official_harbor_verifier', authoritative: true },
          details: { source: 'harbor', official: true },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e6',
        taskRunId: 'run-official',
        ts: 4,
        result: {
          id: 'official-score',
          taskRunId: 'run-official',
          ts: 4,
          passed: true,
          scored: true,
          eligible: true,
          score: 1,
          maxScore: 1,
          taxonomy: 'passed',
          authority: { source: 'official_harbor_verifier', authoritative: true },
        },
      },
    ];

    const exported = taskRunExportFromProjection(projectTaskRun(events, 'run-official'));

    assert.equal(exported.taxonomy.passed, true);
    assert.equal(exported.verifier?.id, 'official-verifier');
    assert.equal(exported.verifier?.authority?.source, 'official_harbor_verifier');
    assert.equal(exported.legacyResultRecord.passed, true);
    assert.equal(
      projectTaskRun(events, 'run-official').verifierResults[0]?.authority?.authoritative,
      false,
    );

    const dir = await mkdtemp(join(tmpdir(), 'maka-task-export-official-'));
    try {
      const written = await writeTaskRunExport(dir, projectTaskRun(events, 'run-official'));
      const compact = JSON.parse(await readFile(written.files.resultJson, 'utf8'));
      assert.equal(compact.verifier.authority.source, 'official_harbor_verifier');
      assert.equal(compact.verifier.authority.authoritative, true);
      const markdown = await readFile(written.files.resultMd, 'utf8');
      assert.match(markdown, /verifier_authority: official_harbor_verifier authoritative=true/);
      assert.match(markdown, /artifacts: 0/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not pair an official verifier with a stale placeholder score', () => {
    const events: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'e1',
        taskRunId: 'run-verifier-only',
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'score_result_recorded',
        id: 'e2',
        taskRunId: 'run-verifier-only',
        ts: 2,
        result: {
          id: 'placeholder-score',
          taskRunId: 'run-verifier-only',
          ts: 2,
          passed: false,
          scored: false,
          eligible: false,
          taxonomy: 'unsupported_adapter',
          errorClass: 'unsupported_adapter',
          authority: { source: 'self_check', authoritative: false },
        },
      },
      {
        type: 'task_run_completed',
        id: 'e3',
        taskRunId: 'run-verifier-only',
        ts: 3,
        finishedAt: 3,
      },
      {
        type: 'verifier_result_recorded',
        id: 'e4',
        taskRunId: 'run-verifier-only',
        ts: 4,
        result: {
          id: 'official-verifier',
          taskRunId: 'run-verifier-only',
          ts: 4,
          kind: 'terminal_bench',
          passed: true,
          exitCode: 0,
          score: 1,
          maxScore: 1,
          authority: { source: 'official_harbor_verifier', authoritative: true },
          details: { source: 'harbor', official: true },
        },
      },
    ];

    const projection = projectTaskRun(events, 'run-verifier-only');
    const exported = taskRunExportFromProjection(projection);

    assert.equal(projection.latestVerifierResult?.id, 'official-verifier');
    assert.equal(projection.latestScoreResult, undefined);
    assert.equal(exported.score, undefined);
    assert.equal(exported.taxonomy.value, 'passed');
    assert.equal(exported.taxonomy.passed, true);
    assert.equal(exported.legacyResultRecord.passed, true);
  });

  test('keeps official verifier truth when a later placeholder is recorded', () => {
    const events: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'e1',
        taskRunId: 'run-reverse',
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'verifier_result_recorded',
        id: 'e2',
        taskRunId: 'run-reverse',
        ts: 2,
        result: {
          id: 'official-verifier',
          taskRunId: 'run-reverse',
          ts: 2,
          kind: 'terminal_bench',
          passed: true,
          exitCode: 0,
          score: 1,
          maxScore: 1,
          authority: { source: 'official_harbor_verifier', authoritative: true },
          details: { source: 'harbor', official: true },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e3',
        taskRunId: 'run-reverse',
        ts: 2,
        result: {
          id: 'official-score',
          taskRunId: 'run-reverse',
          ts: 2,
          passed: true,
          scored: true,
          eligible: true,
          score: 1,
          maxScore: 1,
          taxonomy: 'passed',
          authority: { source: 'official_harbor_verifier', authoritative: true },
        },
      },
      {
        type: 'task_run_completed',
        id: 'e4',
        taskRunId: 'run-reverse',
        ts: 2,
        finishedAt: 2,
        result: {
          passed: true,
          taxonomy: 'passed',
          verifierResultId: 'official-verifier',
          scoreResultId: 'official-score',
        },
      },
      {
        type: 'verifier_result_recorded',
        id: 'e5',
        taskRunId: 'run-reverse',
        ts: 3,
        result: {
          id: 'placeholder-verifier',
          taskRunId: 'run-reverse',
          ts: 3,
          kind: 'terminal_bench',
          passed: false,
          exitCode: null,
          errorClass: 'unsupported_adapter',
          authority: { source: 'self_check', authoritative: false },
          details: { verificationPlaceholder: true },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e6',
        taskRunId: 'run-reverse',
        ts: 3,
        result: {
          id: 'placeholder-score',
          taskRunId: 'run-reverse',
          ts: 3,
          passed: false,
          scored: false,
          eligible: false,
          taxonomy: 'unsupported_adapter',
          errorClass: 'unsupported_adapter',
          authority: { source: 'self_check', authoritative: false },
        },
      },
    ];

    const projection = projectTaskRun(events, 'run-reverse');
    const exported = taskRunExportFromProjection(projection);

    assert.equal(projection.status, 'completed');
    assert.equal(projection.latestVerifierResult?.id, 'official-verifier');
    assert.equal(projection.latestScoreResult?.id, 'official-score');
    assert.equal(exported.verifier?.id, 'official-verifier');
    assert.equal(exported.taxonomy.passed, true);
    assert.equal(exported.legacyResultRecord.passed, true);
  });

  test('writes deterministic export files and optional events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-task-export-'));
    try {
      const projection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'e1',
            taskRunId: 'run-1',
            ts: 1,
            taskId: 'task-1',
            configId: 'cfg-1',
          },
        ],
        'run-1',
      );
      const result = await writeTaskRunExport(dir, projection, {
        includeEvents: true,
        exportedAt: '2026-06-19T00:00:00.000Z',
      });

      assert.match(await readFile(result.files.taskRunJson, 'utf8'), /maka.task_run_export.v1/);
      assert.match(await readFile(result.files.resultMd, 'utf8'), /# Task Run run-1/);
      assert.equal(
        await readFile(result.files.eventsJsonl!, 'utf8'),
        '{"type":"task_run_created","id":"e1","taskRunId":"run-1","ts":1,"taskId":"task-1","configId":"cfg-1"}\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function heavyTaskCompletionEvents(
  todos: HeavyTaskTodoItem[] = [
    { id: 'edit', content: 'Patch implementation', status: 'completed', priority: 'high' },
    {
      id: 'artifact',
      kind: 'runnable_artifact',
      content: 'Create first runnable artifact',
      status: 'completed',
      priority: 'high',
      evidence: 'Runnable artifact exists in public workspace.',
    },
    {
      id: 'check',
      kind: 'public_check',
      content: 'Run public check',
      status: 'completed',
      priority: 'high',
      evidence: 'Public check passed.',
    },
    {
      id: 'optional-polish',
      content: 'Optional polish',
      status: 'cancelled',
      priority: 'low',
      evidence: 'Not required by public task.',
    },
  ],
): TaskEvent[] {
  const taskRunId = 'run-heavy-complete';
  return [
    { type: 'task_run_created', id: 'hc1', taskRunId, ts: 1, taskId: 'task-1', configId: 'cfg-1' },
    {
      type: 'heavy_task_mode_recorded',
      id: 'hc2',
      taskRunId,
      ts: 2,
      facts: {
        schemaVersion: 1,
        enabled: true,
        triggerSource: 'config',
        triggerReason: 'long public task',
        policyVersion: 'maka-heavy-task-policy.v1',
      },
    },
    {
      type: 'heavy_task_todos_recorded',
      id: 'hc3',
      taskRunId,
      ts: 3,
      todos: {
        schemaVersion: 1,
        todoSetId: 'todos-2',
        taskRunId,
        ts: 3,
        items: todos,
        source: { kind: 'model_tool', toolCallId: 'tool-todos' },
      },
    },
    {
      type: 'heavy_task_self_check_plan_recorded',
      id: 'hc-plan',
      taskRunId,
      ts: 3.5,
      plan: {
        schemaVersion: 1,
        planId: 'plan-1',
        taskRunId,
        ts: 3.5,
        finalArtifacts: [
          {
            path: 'build-output.log',
            purpose: 'public self-check artifact',
            publicReason: 'visible public check creates this artifact',
          },
        ],
        selfCheckScratch: {
          root: '/tmp/maka-self-check/run-heavy-complete',
          expectedGeneratedPaths: ['/tmp/maka-self-check/run-heavy-complete/check.log'],
          publicReason: 'public checks write temporary output under scratch',
        },
        workspaceGuardPlan: {
          checkedPaths: ['/app'],
          expectedAddedPaths: ['build-output.log'],
          expectedGeneratedPathsOutsideScratch: [],
          publicReason: 'public guard checks visible workspace paths',
        },
        publicReason: 'plan is derived from visible public task evidence',
        guard: {
          status: 'accepted',
          checkedAt: 3.5,
          categories: [],
          publicReason: 'Accepted as public, task-derived advisory self-check plan.',
        },
        source: { kind: 'model_tool', toolCallId: 'tool-plan' },
      },
    },
    {
      type: 'heavy_task_self_check_recorded',
      id: 'hc4',
      taskRunId,
      ts: 4,
      selfCheck: {
        schemaVersion: 1,
        selfCheckId: 'self-check-1',
        taskRunId,
        ts: 4,
        status: 'pass',
        publicReason: 'npm test passed against public files.',
        commandEvidence: [
          { command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' },
        ],
        artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
        executionHygiene: {
          sandbox: {
            root: '/tmp/maka-self-check/run-heavy-complete',
            strategy: 'scratch_dir',
            commandCwd: '/tmp/maka-self-check/run-heavy-complete',
            outputPolicy: 'scratch_only',
          },
          scratchUsed: true,
          scratchPath: '/tmp/maka-self-check/run-heavy-complete',
          cleanupPerformed: true,
          workspaceSideEffects: 'none',
          workspaceGuard: {
            checked: true,
            checkedPaths: ['/app'],
            addedPaths: [],
            modifiedPaths: [],
            removedPaths: [],
          },
        },
        guard: {
          status: 'accepted',
          checkedAt: 4,
          categories: [],
          publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
        },
        source: { kind: 'model_tool', toolCallId: 'tool-self-check' },
      },
    },
    {
      type: 'verifier_result_recorded',
      id: 'hc5',
      taskRunId,
      ts: 5,
      result: {
        id: 'verifier-1',
        taskRunId,
        ts: 5,
        kind: 'terminal_bench',
        passed: false,
        exitCode: 1,
        errorClass: 'verification_failed',
        authority: { source: 'official_harbor_verifier', authoritative: true },
      },
    },
    {
      type: 'score_result_recorded',
      id: 'hc6',
      taskRunId,
      ts: 6,
      result: {
        id: 'score-1',
        taskRunId,
        ts: 6,
        passed: false,
        scored: true,
        eligible: true,
        taxonomy: 'verification_failed',
        errorClass: 'verification_failed',
        authority: { source: 'official_harbor_verifier', authoritative: true },
      },
    },
    {
      type: 'task_run_budget_exhausted',
      id: 'hc7',
      taskRunId,
      ts: 7,
      error: { message: 'runtime step cap reached', class: 'max_steps' },
    },
  ];
}
