import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { hashSystemPrompt } from '../fixed-prompt-controller.js';
import {
  createCliPromptCandidateGit,
  createScriptedMetaAgent,
  extractTrajectoryDigest,
  renderMetaAgentPrompt,
  runPromptCandidateRound,
  scanRuntimeEventsForRewardHack,
  type CandidateRationale,
  type MetaAgentPromptInput,
  type MetaAgentPromptResult,
} from '../prompt-candidate-loop.js';

const execFileAsync = promisify(execFile);

describe('prompt candidate loop', () => {
  test('passes only program, results TSV, and held-in digests to the meta-agent', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(
        resultsTsvPath,
        'task_id\tpassed\ntask-a\tfalse\nheld-out-secret\ttrue\n',
        'utf8',
      );
      const candidateRationale = validCandidateRationale({
        predictedFixes: ['task-a'],
        riskTasks: ['task-a'],
        heldInTaskSetHash: 'sha256:model-supplied-held-in',
        candidateRationaleHash: 'sha256:model-supplied-rationale',
      });
      const committedCandidateRationale = validCandidateRationale({
        predictedFixes: ['task-a'],
        riskTasks: ['task-a'],
      });

      let seenInput: MetaAgentPromptInput | undefined;
      await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath,
        heldInTaskIds: ['task-a'],
        heldInDigests: [
          {
            taskId: 'task-a',
            errorClass: 'verification_failed',
            summary: 'last command missed the requested output',
          },
        ],
        heldOutDigests: [
          {
            taskId: 'held-out-secret',
            errorClass: 'verification_failed',
            summary: 'do not leak this held-out trajectory',
          },
        ],
        metaAgent: async (input): Promise<MetaAgentPromptResult> => {
          seenInput = input;
          return candidatePromptResult({
            summary: 'tightened output instruction',
            candidateRationale,
          });
        },
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      });

      assert.ok(seenInput);
      assert.equal(seenInput.program, 'Improve the prompt conservatively.\n');
      assert.equal(seenInput.resultsTsv, 'task_id\tpassed\ntask-a\tfalse\n');
      assert.equal(seenInput.currentSystemPrompt, 'original prompt\n');
      assert.deepEqual(
        seenInput.heldInDigests.map((digest) => digest.taskId),
        ['task-a'],
      );
      assert.equal(JSON.stringify(seenInput).includes('held-out-secret'), false);
      assert.equal(JSON.stringify(seenInput).includes('do not leak'), false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'candidate prompt\n');

      const events = (await readFile(resultsJsonlPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(events, [
        {
          schemaVersion: 1,
          type: 'prompt_candidate_committed',
          id: 'id-1',
          ts: 100,
          runId: 'run-1',
          roundId: 'round-1',
          commitSha: 'commit-1',
          summary: 'tightened output instruction',
          promptHash: hashSystemPrompt('candidate prompt\n'),
          heldInTaskSetHash: expectedHeldInTaskSetHash(['task-a']),
          heldInTaskIds: ['task-a'],
          candidateRationaleHash: expectedCandidateRationaleHash(committedCandidateRationale),
          candidateRationale: committedCandidateRationale,
        },
      ]);
    });
  });

  test('hashes the held-in task set independent of input order', async () => {
    const firstHash = await runCandidateRoundHeldInTaskSetHash(['task-b', 'task-a']);
    const secondHash = await runCandidateRoundHeldInTaskSetHash(['task-a', 'task-b']);
    const differentHash = await runCandidateRoundHeldInTaskSetHash(['task-a']);

    assert.equal(firstHash, secondHash);
    assert.notEqual(firstHash, differentHash);
    assert.equal(firstHash, expectedHeldInTaskSetHash(['task-a', 'task-b']));
  });

  test('filters results TSV by held-in tasks independently from trajectory digests', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(
        resultsTsvPath,
        'task_id\tpassed\npassed-task\ttrue\nfailed-task\tfalse\nheld-out-secret\ttrue\n',
        'utf8',
      );

      let seenInput: MetaAgentPromptInput | undefined;
      await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: ['passed-task', 'failed-task'],
        heldInDigests: [
          {
            taskId: 'failed-task',
            errorClass: 'verification_failed',
            summary: 'missing expected line',
          },
        ],
        heldOutDigests: [
          {
            taskId: 'held-out-secret',
            errorClass: 'verification_failed',
            summary: 'do not leak this held-out trajectory',
          },
        ],
        metaAgent: async (input): Promise<MetaAgentPromptResult> => {
          seenInput = input;
          return candidatePromptResult();
        },
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      });

      assert.ok(seenInput);
      assert.equal(
        seenInput.resultsTsv,
        'task_id\tpassed\npassed-task\ttrue\nfailed-task\tfalse\n',
      );
      assert.deepEqual(
        seenInput.heldInDigests.map((digest) => digest.taskId),
        ['failed-task'],
      );
      assert.equal(JSON.stringify(seenInput).includes('held-out-secret'), false);
      assert.equal(JSON.stringify(seenInput).includes('do not leak'), false);
    });
  });

  test('projects prompt attribution before exposing it to the meta-agent or rendered prompt', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      const unsafePromptAttribution = {
        candidateCommitSha: 'commit-secret',
        predictedFixes: [
          { taskId: 'task-a', outcome: 'improved', candidateCommitSha: 'nested-commit-secret' },
        ],
        riskTasks: [{ taskId: 'task-a', outcome: 'safe', threshold: 'nested-threshold-secret' }],
        unexpectedHeldInFlips: [
          { taskId: 'task-a', from: 'fail', to: 'pass', heldOutMetric: 'nested-held-out-secret' },
        ],
        decision: { decision: 'discard', reason: 'held_out_regressed' },
        decisionReason: 'coverage_regressed',
        rootCauseSignalMatch: 'matched',
      };

      let seenInput: MetaAgentPromptInput | undefined;
      await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: ['task-a'],
        heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
        promptAttribution:
          unsafePromptAttribution as unknown as MetaAgentPromptInput['promptAttribution'],
        metaAgent: async (input): Promise<MetaAgentPromptResult> => {
          seenInput = input;
          return candidatePromptResult();
        },
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      });

      assert.ok(seenInput);
      assert.deepEqual(seenInput.promptAttribution, {
        predictedFixes: [{ taskId: 'task-a', outcome: 'improved' }],
        riskTasks: [{ taskId: 'task-a', outcome: 'safe' }],
        unexpectedHeldInFlips: [{ taskId: 'task-a', from: 'fail', to: 'pass' }],
        rootCauseSignalMatch: 'matched',
      });

      const rendered = renderMetaAgentPrompt(seenInput);
      assert.equal(rendered.includes('commit-secret'), false);
      assert.equal(rendered.includes('candidateCommitSha'), false);
      assert.equal(rendered.includes('held_out_regressed'), false);
      assert.equal(rendered.includes('coverage_regressed'), false);
      assert.equal(rendered.includes('decisionReason'), false);
      assert.equal(rendered.includes('nested-commit-secret'), false);
      assert.equal(rendered.includes('nested-threshold-secret'), false);
      assert.equal(rendered.includes('nested-held-out-secret'), false);
      assert.equal(rendered.includes('heldOutMetric'), false);
      assert.equal(rendered.includes('threshold'), false);
      assert.equal(rendered.includes('"decision"'), false);
      assert.match(rendered, /"predictedFixes"/);
      assert.match(rendered, /"rootCauseSignalMatch"/);
    });
  });

  test('does not summarize recovered tool failures from passed held-in tasks', () => {
    const rendered = renderMetaAgentPrompt({
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve the prompt conservatively.\n',
      currentSystemPrompt: 'original prompt\n',
      resultsTsv: 'task_id\tpassed\npassed-task\ttrue\nfailed-task\tfalse\n',
      heldInDigests: [
        {
          taskId: 'passed-task',
          summary: 'passed after retry',
          toolFailures: [
            { name: 'Write', count: 1, errorClass: 'Validation', argsPreview: 'path' },
          ],
        },
        {
          taskId: 'failed-task',
          errorClass: 'verification_failed',
          summary: 'failed verification',
          toolFailures: [
            { name: 'Bash', count: 1, errorClass: 'RuntimeError', argsPreview: 'command' },
          ],
        },
      ],
    });

    assert.match(rendered, /Bash x1 error=RuntimeError args=command tasks=failed-task/);
    assert.equal(rendered.includes('passed-task'), true);
    assert.equal(rendered.includes('Write x1'), false);
    assert.equal(rendered.includes('tasks=passed-task'), false);
  });

  test('rejects meta-agent output without candidateRationale before writing or committing', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let committed = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          metaAgent: async () =>
            ({
              systemPrompt: 'candidate prompt\n',
              summary: 'changed prompt',
            }) as MetaAgentPromptResult,
          git: {
            ...gitNoop(dir),
            commit: async () => {
              committed = true;
              return 'commit-1';
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /candidateRationale must be a JSON object/,
      );

      assert.equal(committed, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('rejects candidateRationale with an invalid failurePattern before writing', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({ failurePattern: 'held_out_regressed' }),
            }),
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /candidateRationale.failurePattern must be one of:/,
      );

      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('rejects candidateRationale task ids outside the held-in set before writing', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({ predictedFixes: ['held-out-secret'] }),
            }),
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /candidateRationale.predictedFixes contains non-held-in task id: held-out-secret/,
      );

      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });

    await assertRejectsCandidateRationale(
      validCandidateRationale({ riskTasks: ['held-out-secret'] }),
      /candidateRationale.riskTasks contains non-held-in task id: held-out-secret/,
    );
  });

  test('rejects candidateRationale for a non-prompt edited surface', async () => {
    await assertRejectsCandidateRationale(
      validCandidateRationale({ editedSurface: 'tool_contract' }),
      /candidateRationale.editedSurface must be "system_prompt"/,
    );
  });

  test('rejects candidateRationale evidence refs outside the current RSI analysis', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          rsiAnalysis: {
            heldInTaskSetHash: 'sha256:held-in',
            transitionVsLastKept: [],
            transitionVsPreviousCandidate: [],
            coverageRegressionTaskIds: [],
            errorClassDistribution: [],
            toolFailureClusters: [],
            signals: [{ id: 'rsi-sig:known', kind: 'coverage_regression', taskIds: ['task-a'] }],
          },
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({
                evidenceRefs: ['rsi-sig:unknown'],
                failurePattern: undefined,
              }),
            }),
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /candidateRationale.evidenceRefs contains unknown analysis signal id: rsi-sig:unknown/,
      );

      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('requires direct evidence when signals exist and otherwise requires a coarse fallback', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      const baseInput = {
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: ['task-a'],
        heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      };

      await assert.rejects(
        runPromptCandidateRound({
          ...baseInput,
          rsiAnalysis: {
            heldInTaskSetHash: 'sha256:held-in',
            transitionVsLastKept: [],
            transitionVsPreviousCandidate: [],
            coverageRegressionTaskIds: [],
            errorClassDistribution: [],
            toolFailureClusters: [],
            signals: [{ id: 'rsi-sig:known', kind: 'coverage_regression', taskIds: ['task-a'] }],
          },
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({ evidenceRefs: [] }),
            }),
        }),
        /candidateRationale.evidenceRefs must cite at least one current analysis signal/,
      );

      await runPromptCandidateRound({
        ...baseInput,
        resultsJsonlPath: join(dir, 'signal-ref-without-fallback.jsonl'),
        rsiAnalysis: {
          heldInTaskSetHash: 'sha256:held-in',
          transitionVsLastKept: [],
          transitionVsPreviousCandidate: [],
          coverageRegressionTaskIds: [],
          errorClassDistribution: [],
          toolFailureClusters: [],
          signals: [{ id: 'rsi-sig:known', kind: 'coverage_regression', taskIds: ['task-a'] }],
        },
        metaAgent: async () =>
          candidatePromptResult({
            candidateRationale: validCandidateRationale({
              evidenceRefs: ['rsi-sig:known'],
              failurePattern: undefined,
            }),
          }),
      });

      await assert.rejects(
        runPromptCandidateRound({
          ...baseInput,
          resultsJsonlPath: join(dir, 'redundant-fallback.jsonl'),
          rsiAnalysis: {
            heldInTaskSetHash: 'sha256:held-in',
            transitionVsLastKept: [],
            transitionVsPreviousCandidate: [],
            coverageRegressionTaskIds: [],
            errorClassDistribution: [],
            toolFailureClusters: [],
            signals: [{ id: 'rsi-sig:known', kind: 'coverage_regression', taskIds: ['task-a'] }],
          },
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({ evidenceRefs: ['rsi-sig:known'] }),
            }),
        }),
        /candidateRationale.failurePattern must be omitted when evidenceRefs cites current analysis/,
      );

      await runPromptCandidateRound({
        ...baseInput,
        resultsJsonlPath: join(dir, 'allowed-empty-refs.jsonl'),
        rsiAnalysis: {
          heldInTaskSetHash: 'sha256:held-in',
          transitionVsLastKept: [],
          transitionVsPreviousCandidate: [],
          coverageRegressionTaskIds: [],
          errorClassDistribution: [],
          toolFailureClusters: [],
          signals: [],
        },
        metaAgent: async () =>
          candidatePromptResult({
            candidateRationale: validCandidateRationale({ evidenceRefs: [] }),
          }),
      });

      await assert.rejects(
        runPromptCandidateRound({
          ...baseInput,
          resultsJsonlPath: join(dir, 'missing-fallback.jsonl'),
          metaAgent: async () =>
            candidatePromptResult({
              candidateRationale: validCandidateRationale({
                evidenceRefs: [],
                failurePattern: undefined,
              }),
            }),
        }),
        /candidateRationale.failurePattern fallback is required when evidenceRefs is empty/,
      );
    });
  });

  test('rejects unsafe or oversized candidateRationale text before writing', async () => {
    await assertRejectsCandidateRationale(
      validCandidateRationale({ hypothesis: 'held-out regressed after reading tests/test.sh' }),
      /candidateRationale.hypothesis contains forbidden prompt-memory content/,
    );
    await assertRejectsCandidateRationale(
      validCandidateRationale({ targetedFix: '```\nraw trace chunk\n```' }),
      /candidateRationale.targetedFix contains forbidden prompt-memory content/,
    );
  });

  test('rejects trajectory digests outside the held-in task set before calling the meta-agent', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'held-out-secret', summary: 'do not leak this trajectory' }],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /held-in digests must belong to held-in task set: held-out-secret/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('rejects overlapping held-in and held-out task digests', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'held-in summary' }],
          heldOutDigests: [{ taskId: 'task-a', summary: 'held-out summary' }],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /held-in and held-out task sets must be disjoint/,
      );

      assert.equal(called, false);
    });
  });

  test('requires an agent cwd when held-out artifact paths are provided', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const heldOutEventsPath = join(dir, 'held-out-runtime-events.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await writeFile(heldOutEventsPath, '', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          heldOutArtifactPaths: [heldOutEventsPath],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: gitNoop(dir),
        } as unknown as Parameters<typeof runPromptCandidateRound>[0]),
        /agentCwdPath is required before exposing controller artifacts/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('allows controller artifacts outside agent cwd with unrelated symlinks present', async () => {
    await withDir(async (dir) => {
      const agentDir = join(dir, 'agent-cwd');
      const controllerDir = join(dir, 'controller');
      const sharedDir = join(dir, 'shared');
      await mkdir(agentDir, { recursive: true });
      await mkdir(controllerDir, { recursive: true });
      await mkdir(sharedDir, { recursive: true });
      const programPath = join(agentDir, 'program.md');
      const systemPromptPath = join(agentDir, 'system_prompt.md');
      const resultsTsvPath = join(controllerDir, 'results.tsv');
      const resultsJsonlPath = join(controllerDir, 'results.jsonl');
      const heldOutEventsPath = join(controllerDir, 'held-out-runtime-events.jsonl');
      const sharedNotePath = join(sharedDir, 'note.md');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(
        resultsTsvPath,
        'task_id\tpassed\ntask-a\tfalse\nheld-out-task\ttrue\n',
        'utf8',
      );
      await writeFile(heldOutEventsPath, '', 'utf8');
      await writeFile(sharedNotePath, 'unrelated shared note\n', 'utf8');
      await symlink(sharedNotePath, join(agentDir, 'shared-note.md'));

      let seenInput: MetaAgentPromptInput | undefined;
      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: agentDir,
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath,
        heldInTaskIds: ['task-a'],
        heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
        heldOutArtifactPaths: [heldOutEventsPath],
        metaAgent: async (input): Promise<MetaAgentPromptResult> => {
          seenInput = input;
          return candidatePromptResult();
        },
        git: gitNoop(agentDir),
        now: () => 100,
        newId: idFactory(),
      });

      assert.equal(result.commitSha, 'commit-1');
      assert.equal(seenInput?.resultsTsv, 'task_id\tpassed\ntask-a\tfalse\n');
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'candidate prompt\n');
      const events = (await readFile(resultsJsonlPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events[0]?.type, 'prompt_candidate_committed');
    });
  });

  test('rejects physically visible held-out artifacts before calling the meta-agent', async () => {
    await withDir(async (dir) => {
      const agentDir = join(dir, 'agent-cwd');
      const controllerDir = join(dir, 'controller');
      await mkdir(agentDir, { recursive: true });
      await mkdir(controllerDir, { recursive: true });
      const programPath = join(agentDir, 'program.md');
      const systemPromptPath = join(agentDir, 'system_prompt.md');
      const resultsTsvPath = join(agentDir, 'results.tsv');
      const heldOutEventsPath = join(controllerDir, 'held-out-runtime-events.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await writeFile(heldOutEventsPath, '', 'utf8');

      let metaAgentCalled = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: agentDir,
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(controllerDir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          heldOutDigests: [{ taskId: 'held-out-task', summary: 'hidden held-out task' }],
          heldOutArtifactPaths: [heldOutEventsPath],
          metaAgent: async () => {
            metaAgentCalled = true;
            return candidatePromptResult();
          },
          git: gitNoop(agentDir),
        }),
        /controller-only artifacts must stay outside agent cwd: results\.tsv/,
      );
      assert.equal(metaAgentCalled, false);
    });
  });

  test('rejects symlinked held-out artifacts visible from the agent cwd', async () => {
    await withDir(async (dir) => {
      const agentDir = join(dir, 'agent-cwd');
      const controllerDir = join(dir, 'controller');
      await mkdir(agentDir, { recursive: true });
      await mkdir(controllerDir, { recursive: true });
      const programPath = join(agentDir, 'program.md');
      const systemPromptPath = join(agentDir, 'system_prompt.md');
      const resultsTsvPath = join(controllerDir, 'results.tsv');
      const heldOutEventsPath = join(controllerDir, 'held-out-runtime-events.jsonl');
      const visibleHeldOutLinkPath = join(agentDir, 'held-out-link.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await writeFile(heldOutEventsPath, '', 'utf8');
      await symlink(heldOutEventsPath, visibleHeldOutLinkPath);

      let metaAgentCalled = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: agentDir,
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(controllerDir, 'results.jsonl'),
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          heldOutArtifactPaths: [visibleHeldOutLinkPath],
          metaAgent: async () => {
            metaAgentCalled = true;
            return candidatePromptResult();
          },
          git: gitNoop(agentDir),
        }),
        /controller-only artifacts must stay outside agent cwd: held-out-link\.jsonl/,
      );
      assert.equal(metaAgentCalled, false);
    });
  });

  test('rejects agent-cwd directory symlinks that contain controller artifacts', async () => {
    await withDir(async (dir) => {
      const agentDir = join(dir, 'agent-cwd');
      const controllerDir = join(dir, 'controller');
      await mkdir(agentDir, { recursive: true });
      await mkdir(controllerDir, { recursive: true });
      const programPath = join(agentDir, 'program.md');
      const systemPromptPath = join(agentDir, 'system_prompt.md');
      const resultsTsvPath = join(controllerDir, 'results.tsv');
      const resultsJsonlPath = join(controllerDir, 'results.jsonl');
      const visibleControllerLinkPath = join(agentDir, 'controller-link');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await writeFile(resultsJsonlPath, '', 'utf8');
      await symlink(controllerDir, visibleControllerLinkPath);

      let metaAgentCalled = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: agentDir,
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath,
          heldInTaskIds: ['task-a'],
          heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
          metaAgent: async () => {
            metaAgentCalled = true;
            return candidatePromptResult();
          },
          git: gitNoop(agentDir),
        }),
        /controller-only artifacts must stay outside agent cwd: controller-link/,
      );
      assert.equal(metaAgentCalled, false);
    });
  });

  test('fails closed when the prompt edit changes files outside system_prompt.md', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let committed = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          heldOutDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md', 'program.md'],
            commit: async () => {
              committed = true;
              return 'commit-1';
            },
            rollbackCommit: async () => {},
            restoreSystemPrompt: async () => {
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /only system_prompt.md may change/,
      );

      assert.equal(committed, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('rejects a symlinked system prompt before writing outside the repo', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const outsidePath = join(dir, '..', 'outside-system-prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(outsidePath, 'outside prompt\n', 'utf8');
      await symlink(outsidePath, systemPromptPath);
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: gitNoop(dir),
          now: () => 100,
          newId: idFactory(),
        }),
        /system_prompt.md must be a regular file/,
      );

      assert.equal(await readFile(outsidePath, 'utf8'), 'outside prompt\n');
    });
  });

  test('rejects a system prompt through a symlinked parent before writing outside the repo', async () => {
    await withDir(async (dir) => {
      await withDir(async (outsideDir) => {
        const programPath = join(dir, 'program.md');
        const promptLinkPath = join(dir, 'prompts');
        const outsidePath = join(outsideDir, 'system_prompt.md');
        const systemPromptPath = join(promptLinkPath, 'system_prompt.md');
        const resultsTsvPath = join(dir, 'results.tsv');
        await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
        await writeFile(outsidePath, 'outside prompt\n', 'utf8');
        await symlink(outsideDir, promptLinkPath);
        await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

        await assert.rejects(
          runPromptCandidateRound({
            runId: 'run-1',
            roundId: 'round-1',
            agentCwdPath: await testAgentCwd(dir),
            programPath,
            systemPromptPath,
            resultsTsvPath,
            resultsJsonlPath: join(dir, 'results.jsonl'),
            heldInTaskIds: [],
            heldInDigests: [],
            metaAgent: async () => candidatePromptResult(),
            git: {
              gitRootPath: dir,
              systemPromptGitPath: 'prompts/system_prompt.md',
              assertSystemPromptClean: async () => {},
              changedFiles: async () => ['prompts/system_prompt.md'],
              commit: async () => 'commit-1',
              rollbackCommit: async () => {},
              restoreSystemPrompt: async () => {
                await writeFile(systemPromptPath, 'outside prompt\n', 'utf8');
              },
            },
            now: () => 100,
            newId: idFactory(),
          }),
          /system_prompt.md must stay inside the git cwd/,
        );

        assert.equal(await readFile(outsidePath, 'utf8'), 'outside prompt\n');
      });
    });
  });

  test('rejects changes to a different system_prompt.md path', async () => {
    await withDir(async (dir) => {
      const promptDir = join(dir, 'prompts');
      await mkdir(promptDir);
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(promptDir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let committed = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'prompts/system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md'],
            commit: async () => {
              committed = true;
              return 'commit-1';
            },
            rollbackCommit: async () => {},
            restoreSystemPrompt: async () => {
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /only prompts\/system_prompt.md may change/,
      );

      assert.equal(committed, false);
    });
  });

  test('rejects mismatched input and git system prompt paths before writing', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath: programPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /system prompt path must match git prompt path/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(programPath, 'utf8'), 'Improve the prompt conservatively.\n');
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('restores the original prompt when committing the candidate fails', async () => {
    await withDir(async (dir) => {
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

      let restored = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: {
            gitRootPath: dir,
            systemPromptGitPath: 'system_prompt.md',
            assertSystemPromptClean: async () => {},
            changedFiles: async () => ['system_prompt.md'],
            commit: async () => {
              throw new Error('commit rejected');
            },
            rollbackCommit: async () => {},
            restoreSystemPrompt: async () => {
              restored = true;
              await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
            },
          },
          now: () => 100,
          newId: idFactory(),
        }),
        /commit rejected/,
      );

      assert.equal(restored, true);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('extracts a bounded digest from raw runtime events', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(runtimeEvent('call-1', 'Read', { path: '/app/first.txt' })),
          JSON.stringify(runtimeEvent('call-2', 'Bash', { command: 'pytest -q' })),
          JSON.stringify(
            runtimeEvent('call-3', 'Write', {
              path: '/app/out.txt',
              content: 'long raw content that should not appear',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const digest = await extractTrajectoryDigest({
        taskId: 'task-a',
        errorClass: 'verification_failed',
        runtimeEventsPath,
        verifierSummary: 'expected output missing',
      });

      assert.deepEqual(digest, {
        taskId: 'task-a',
        errorClass: 'verification_failed',
        summary: 'expected output missing',
        recentToolCalls: [
          { name: 'Bash', argsPreview: 'command' },
          { name: 'Write', argsPreview: 'content,path' },
        ],
      });
      assert.equal(JSON.stringify(digest).includes('long raw content'), false);
    });
  });

  test('feeds aggregated tool failure trace signal into the meta-agent prompt', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      const traceEventsPath = join(dir, 'events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(runtimeEvent('call-1', 'Bash', { command: 'pytest -q' })),
          JSON.stringify(
            runtimeEvent('call-2', 'Edit', {
              file: '/app/main.py',
              old_string: 'x',
              new_string: 'y',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        traceEventsPath,
        [
          JSON.stringify(
            traceToolFailedEvent('call-1', 'Bash', 'Tool execution failed', 'RuntimeError'),
          ),
          JSON.stringify(
            traceToolFailedEvent('call-2', 'Edit', 'Tool execution failed', 'Validation'),
          ),
          JSON.stringify(
            traceToolFailedEvent('call-2', 'Edit', 'Tool execution failed', 'Validation'),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const digest = await extractTrajectoryDigest({
        taskId: 'task-a',
        errorClass: 'runtime_error',
        runtimeEventsPath,
        traceEventsPath,
        verifierSummary: 'status=failed',
      });

      assert.deepEqual(digest.toolFailures, [
        {
          name: 'Edit',
          count: 2,
          errorClass: 'Validation',
          argsPreview: 'file,new_string,old_string',
        },
        { name: 'Bash', count: 1, errorClass: 'RuntimeError', argsPreview: 'command' },
      ]);

      const prompt = renderMetaAgentPrompt({
        runId: 'run-1',
        roundId: 'round-1',
        program: 'Improve conservatively.',
        currentSystemPrompt: 'original prompt',
        resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
        heldInDigests: [digest],
      });

      assert.match(prompt, /# Held-In Tool Failure Summary/);
      assert.match(prompt, /Edit x2 error=Validation args=file,new_string,old_string tasks=task-a/);
      assert.match(prompt, /Bash x1 error=RuntimeError args=command tasks=task-a/);
      assert.equal(prompt.includes('"toolFailures"'), false);
    });
  });

  test('tells the meta-agent to prefer transitions and verifier summaries over tool failure clusters', () => {
    const prompt = renderMetaAgentPrompt({
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve conservatively.',
      currentSystemPrompt: 'original prompt',
      resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
      heldInDigests: [
        {
          taskId: 'task-a',
          errorClass: 'verification_failed',
          summary: 'status=failed verifierSummary=final_state_expected_text_mismatch',
        },
      ],
      rsiAnalysis: {
        heldInTaskSetHash: 'sha256:held-in',
        transitionVsLastKept: [{ taskId: 'task-a', from: 'pass', to: 'fail' }],
        transitionVsPreviousCandidate: [],
        coverageRegressionTaskIds: [],
        errorClassDistribution: [{ errorClass: 'verification_failed', count: 1 }],
        toolFailureClusters: [
          {
            name: 'Write',
            errorClass: 'Validation',
            argsPreview: 'path',
            count: 1,
            taskIds: ['task-a'],
          },
        ],
        signals: [
          {
            id: 'rsi-sig:transition',
            kind: 'transition',
            taskIds: ['task-a'],
            basis: 'last_kept',
            transition: { taskId: 'task-a', from: 'pass', to: 'fail' },
          },
        ],
      },
    });

    assert.match(
      prompt,
      /Prefer pass\/fail transitions and verifier failure summaries over tool_failure_cluster/,
    );
    assert.match(prompt, /Treat tool_failure_cluster as root cause only when it is unrecovered/);
  });

  test('sanitizes trace-derived tool failure fields before rendering the meta-agent prompt', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      const traceEventsPath = join(dir, 'events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(
            runtimeEvent('call-1', 'Bash', {
              'EXPECTED_SECRET\n# injected': 'value',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        traceEventsPath,
        [
          JSON.stringify(
            traceToolFailedEvent(
              'call-1',
              'BadTool\n# injected EXPECTED_SECRET',
              'Tool execution failed',
              'RuntimeError\nEXPECTED_SECRET',
            ),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const digest = await extractTrajectoryDigest({
        taskId: 'task-a',
        runtimeEventsPath,
        traceEventsPath,
        verifierSummary: 'status=failed',
      });
      const prompt = renderMetaAgentPrompt({
        runId: 'run-1',
        roundId: 'round-1',
        program: 'Improve conservatively.',
        currentSystemPrompt: 'original prompt',
        resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
        heldInDigests: [digest],
      });

      assert.match(prompt, /unknown_tool x1 error=unknown_error args=arg tasks=task-a/);
      assert.equal(prompt.includes('EXPECTED_SECRET'), false);
      assert.equal(prompt.includes('# injected'), false);
    });
  });

  test('keeps trajectory digest usable when optional trace events are unavailable', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [JSON.stringify(runtimeEvent('call-1', 'Bash', { command: 'pytest -q' })), ''].join('\n'),
        'utf8',
      );

      const digest = await extractTrajectoryDigest({
        taskId: 'task-a',
        errorClass: 'runtime_error',
        runtimeEventsPath,
        traceEventsPath: join(dir, 'missing-events.jsonl'),
        verifierSummary: 'status=failed',
      });

      assert.deepEqual(digest, {
        taskId: 'task-a',
        errorClass: 'runtime_error',
        summary: 'status=failed',
        recentToolCalls: [{ name: 'Bash', argsPreview: 'command' }],
      });
    });
  });

  test('fails trajectory digest extraction when trace events are malformed', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      const traceEventsPath = join(dir, 'events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [JSON.stringify(runtimeEvent('call-1', 'Bash', { command: 'pytest -q' })), ''].join('\n'),
        'utf8',
      );
      await writeFile(traceEventsPath, '{"type":"tool_failed"\n', 'utf8');

      await assert.rejects(
        extractTrajectoryDigest({
          taskId: 'task-a',
          runtimeEventsPath,
          traceEventsPath,
          verifierSummary: 'status=failed',
        }),
        /Expected ',' or '}'/,
      );
    });
  });

  test('quarantines function calls containing verifier expected output', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(
            runtimeEvent('call-1', 'Bash', { command: 'echo EXPECTED_SECRET > /tmp/out' }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
    });
  });

  test('quarantines model-visible tool results containing verifier expected output', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(
            functionResponseRuntimeEvent('call-1', 'Bash', {
              stdout: 'EXPECTED_SECRET\n',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
    });
  });

  test('quarantines model-visible text containing verifier expected output', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [JSON.stringify(textRuntimeEvent('The expected answer is EXPECTED_SECRET.')), ''].join(
          '\n',
        ),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
    });
  });

  test('quarantines replayed thinking containing verifier expected output', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(thinkingRuntimeEvent('Remember EXPECTED_SECRET for the next answer.')),
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
    });
  });

  test('quarantines model-visible errors containing verifier expected output', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(
            errorRuntimeEvent('Tool error mentioned EXPECTED_SECRET.', {
              stdout: 'EXPECTED_SECRET',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['EXPECTED_SECRET'],
      });
    });
  });

  test('quarantines when raw runtime events are unavailable', async () => {
    await withDir(async (dir) => {
      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath: join(dir, 'missing-runtime-events.jsonl'),
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'runtime_events_unreadable',
      });
    });
  });

  test('quarantines when runtime events are empty', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(runtimeEventsPath, '', 'utf8');

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'runtime_events_empty',
      });
    });
  });

  test('quarantines when verifier patterns are empty', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [JSON.stringify(runtimeEvent('call-1', 'Bash', { command: 'echo hello' })), ''].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['', '   '],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'no_verifier_patterns',
      });
    });
  });

  test('quarantines when runtime events contain no model-visible content', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [JSON.stringify({ id: 'event-1', content: { kind: 'metrics', costUsd: 0.01 } }), ''].join(
          '\n',
        ),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, {
        decision: 'quarantine',
        reason: 'no_model_visible_events',
      });
    });
  });

  test('keeps clean function calls that only reference verifier filenames', async () => {
    await withDir(async (dir) => {
      const runtimeEventsPath = join(dir, 'runtime-events.jsonl');
      await writeFile(
        runtimeEventsPath,
        [
          JSON.stringify(runtimeEvent('call-1', 'Bash', { command: 'cat tests/test_outputs.py' })),
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath,
        verifierPatterns: ['EXPECTED_SECRET'],
      });

      assert.deepEqual(result, { decision: 'clean' });
    });
  });

  test('scripted meta-agent renders a fixed prompt and parses JSON output', async () => {
    const input: MetaAgentPromptInput = {
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve conservatively.',
      currentSystemPrompt: 'original prompt',
      resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
      heldInDigests: [
        {
          taskId: 'task-a',
          errorClass: 'verification_failed',
          summary: 'missing expected line',
          recentToolCalls: [{ name: 'Bash', argsPreview: 'command' }],
        },
      ],
    };
    const prompt = renderMetaAgentPrompt(input);
    assert.match(prompt, /Improve conservatively/);
    assert.match(prompt, /task-a/);
    assert.match(prompt, /original prompt/);
    assert.match(prompt, /candidateRationale/);
    assert.match(prompt, /evidenceRefs/);

    const metaAgent = createScriptedMetaAgent({
      complete: async ({ prompt: renderedPrompt }) => {
        assert.equal(renderedPrompt, prompt);
        return JSON.stringify({
          systemPrompt: 'candidate prompt\n',
          summary: 'ask for exact output line',
          candidateRationale: validCandidateRationale(),
        });
      },
    });

    assert.deepEqual(await metaAgent(input), {
      systemPrompt: 'candidate prompt\n',
      summary: 'ask for exact output line',
      candidateRationale: validCandidateRationale(),
    });
  });

  test('retries scripted meta-agent after candidateRationale schema errors', async () => {
    const input: MetaAgentPromptInput = {
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve conservatively.',
      currentSystemPrompt: 'original prompt',
      resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
      heldInDigests: [
        {
          taskId: 'task-a',
          errorClass: 'verification_failed',
          summary: 'missing expected line',
        },
      ],
    };
    const prompts: string[] = [];
    const expected = candidatePromptResult({
      systemPrompt: 'candidate prompt after retry\n',
      summary: 'ask for exact output line after retry',
      candidateRationale: validCandidateRationale(),
    });
    const metaAgent = createScriptedMetaAgent({
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify(
            candidatePromptResult({
              candidateRationale: validCandidateRationale({ evidenceRefs: 'rsi-sig:not-an-array' }),
            }),
          );
        }
        return JSON.stringify(expected);
      },
    });

    assert.deepEqual(await metaAgent(input), expected);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /previous meta-agent response was invalid/i);
    assert.match(prompts[1], /candidateRationale\.evidenceRefs must be an array/);
  });

  test('does not echo invalid JSON text into the meta-agent retry prompt', async () => {
    const input: MetaAgentPromptInput = {
      runId: 'run-1',
      roundId: 'round-1',
      program: 'Improve conservatively.',
      currentSystemPrompt: 'original prompt',
      resultsTsv: 'task_id\tpassed\ntask-a\tfalse\n',
      heldInDigests: [{ taskId: 'task-a', summary: 'failed verification' }],
    };
    const prompts: string[] = [];
    const expected = candidatePromptResult({
      systemPrompt: 'candidate prompt after retry\n',
      summary: 'valid JSON after retry',
    });
    const metaAgent = createScriptedMetaAgent({
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) return 'SECRET_CANARY not json';
        return JSON.stringify(expected);
      },
    });

    assert.deepEqual(await metaAgent(input), expected);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /meta-agent output was not valid JSON/);
    assert.equal(prompts[1].includes('SECRET_CAN'), false);
  });

  test('CLI git adapter commits only system_prompt.md with the round message', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      await writeFile(join(dir, 'notes.md'), 'staged unrelated note\n', 'utf8');
      await execFileAsync('git', ['add', 'notes.md'], { cwd: dir });
      await writeFile(join(dir, 'scratch.tmp'), 'untracked unrelated output\n', 'utf8');

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: [],
        heldInDigests: [],
        metaAgent: async () => candidatePromptResult(),
        git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      const committedFiles = await execFileAsync(
        'git',
        ['show', '--name-only', '--format=', 'HEAD'],
        { cwd: dir },
      );
      const stagedFiles = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
        cwd: dir,
      });
      const status = await execFileAsync(
        'git',
        ['status', '--porcelain', '--untracked-files=all'],
        { cwd: dir },
      );
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.deepEqual(committedFiles.stdout.trim().split('\n').filter(Boolean), [
        'system_prompt.md',
      ]);
      assert.deepEqual(stagedFiles.stdout.trim().split('\n').filter(Boolean), ['notes.md']);
      assert.match(status.stdout, /^A  notes\.md$/m);
      assert.match(status.stdout, /^\?\? scratch\.tmp$/m);
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter rejects edits to pre-existing dirty files during a candidate round', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const scratchPath = join(dir, 'scratch.tmp');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      await writeFile(scratchPath, 'pre-existing scratch\n', 'utf8');

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => {
            await writeFile(scratchPath, 'candidate side edit\n', 'utf8');
            return candidatePromptResult();
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /only system_prompt.md may change/,
      );

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'initial');
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('CLI git adapter rejects HEAD movement during a candidate round', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const notesPath = join(dir, 'notes.md');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => {
            await writeFile(notesPath, 'side commit\n', 'utf8');
            await execFileAsync('git', ['add', 'notes.md'], { cwd: dir });
            await execFileAsync('git', ['commit', '-m', 'side edit'], { cwd: dir });
            return candidatePromptResult();
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /candidate round HEAD moved before prompt commit/,
      );

      const subjects = await execFileAsync('git', ['log', '--format=%s', '--max-count=2'], {
        cwd: dir,
      });
      assert.deepEqual(subjects.stdout.trim().split('\n'), ['side edit', 'initial']);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
    });
  });

  test('CLI git adapter rolls back the prompt commit when WAL append fails', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      const resultsJsonlPath = join(dir, 'results.jsonl');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await mkdir(resultsJsonlPath);
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath,
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
      );

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      const cached = await execFileAsync('git', ['diff', '--cached', '--', 'system_prompt.md'], {
        cwd: dir,
      });
      const worktree = await execFileAsync('git', ['diff', '--', 'system_prompt.md'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'initial');
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
      assert.equal(cached.stdout, '');
      assert.equal(worktree.stdout, '');
    });
  });

  test('CLI git adapter resolves a relative system prompt path from cwd', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(join(dir, 'system_prompt.md'), 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath: join(dir, 'system_prompt.md'),
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: [],
        heldInDigests: [],
        metaAgent: async () => candidatePromptResult(),
        git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath: 'system_prompt.md' }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter uses repo-root paths when cwd is a subdirectory', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const packageDir = join(dir, 'packages', 'headless');
      await mkdir(packageDir, { recursive: true });
      const programPath = join(packageDir, 'program.md');
      const systemPromptPath = join(packageDir, 'system_prompt.md');
      const resultsTsvPath = join(packageDir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });

      const result = await runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(packageDir, 'results.jsonl'),
        heldInTaskIds: [],
        heldInDigests: [],
        metaAgent: async () => candidatePromptResult(),
        git: createCliPromptCandidateGit({ cwd: packageDir, systemPromptPath: 'system_prompt.md' }),
        now: () => 100,
        newId: idFactory(),
      });

      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: dir });
      assert.equal(subject.stdout.trim(), 'candidate prompt round-1');
      assert.equal(result.commitSha.length, 40);
    });
  });

  test('CLI git adapter restores worktree and index when commit fails', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
      await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
      await chmod(hookPath, 0o755);

      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => candidatePromptResult(),
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
      );

      const cached = await execFileAsync('git', ['diff', '--cached', '--', 'system_prompt.md'], {
        cwd: dir,
      });
      const worktree = await execFileAsync('git', ['diff', '--', 'system_prompt.md'], { cwd: dir });
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
      assert.equal(cached.stdout, '');
      assert.equal(worktree.stdout, '');
    });
  });

  test('CLI git adapter rejects a dirty system prompt before candidate writes', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      await writeFile(systemPromptPath, 'manual prompt edit\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /system_prompt.md must be clean before candidate round/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'manual prompt edit\n');
    });
  });

  test('CLI git adapter rejects an untracked system prompt before candidate writes', async () => {
    await withDir(async (dir) => {
      await execFileAsync('git', ['init'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
      const programPath = join(dir, 'program.md');
      const systemPromptPath = join(dir, 'system_prompt.md');
      const resultsTsvPath = join(dir, 'results.tsv');
      await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
      await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
      await writeFile(systemPromptPath, 'untracked prompt draft\n', 'utf8');

      let called = false;
      await assert.rejects(
        runPromptCandidateRound({
          runId: 'run-1',
          roundId: 'round-1',
          agentCwdPath: await testAgentCwd(dir),
          programPath,
          systemPromptPath,
          resultsTsvPath,
          resultsJsonlPath: join(dir, 'results.jsonl'),
          heldInTaskIds: [],
          heldInDigests: [],
          metaAgent: async () => {
            called = true;
            return candidatePromptResult();
          },
          git: createCliPromptCandidateGit({ cwd: dir, systemPromptPath }),
          now: () => 100,
          newId: idFactory(),
        }),
        /system_prompt.md must be tracked before candidate round/,
      );

      assert.equal(called, false);
      assert.equal(await readFile(systemPromptPath, 'utf8'), 'untracked prompt draft\n');
    });
  });
});

function candidatePromptResult(
  input: {
    systemPrompt?: string;
    summary?: string;
    candidateRationale?: Record<string, unknown>;
  } = {},
): MetaAgentPromptResult {
  return {
    systemPrompt: input.systemPrompt ?? 'candidate prompt\n',
    summary: input.summary ?? 'changed prompt',
    candidateRationale: (input.candidateRationale ??
      validCandidateRationale()) as unknown as CandidateRationale,
  };
}

function validCandidateRationale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    editedSurface: 'system_prompt',
    evidenceRefs: [],
    hypothesis: 'coverage fell after the previous prompt change',
    targetedFix: 'keep the completion criteria explicit and conservative',
    predictedFixes: [],
    riskTasks: [],
    failurePattern: 'coverage_regression',
    ...overrides,
  };
}

async function assertRejectsCandidateRationale(
  candidateRationale: Record<string, unknown>,
  expected: RegExp,
): Promise<void> {
  await withDir(async (dir) => {
    const programPath = join(dir, 'program.md');
    const systemPromptPath = join(dir, 'system_prompt.md');
    const resultsTsvPath = join(dir, 'results.tsv');
    await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
    await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
    await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\n', 'utf8');

    await assert.rejects(
      runPromptCandidateRound({
        runId: 'run-1',
        roundId: 'round-1',
        agentCwdPath: await testAgentCwd(dir),
        programPath,
        systemPromptPath,
        resultsTsvPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        heldInTaskIds: ['task-a'],
        heldInDigests: [{ taskId: 'task-a', summary: 'failed held-in task' }],
        metaAgent: async () => candidatePromptResult({ candidateRationale }),
        git: gitNoop(dir),
        now: () => 100,
        newId: idFactory(),
      }),
      expected,
    );

    assert.equal(await readFile(systemPromptPath, 'utf8'), 'original prompt\n');
  });
}

async function runCandidateRoundHeldInTaskSetHash(
  heldInTaskIds: readonly string[],
): Promise<string> {
  let heldInTaskSetHash = '';
  await withDir(async (dir) => {
    const programPath = join(dir, 'program.md');
    const systemPromptPath = join(dir, 'system_prompt.md');
    const resultsTsvPath = join(dir, 'results.tsv');
    const resultsJsonlPath = join(dir, 'results.jsonl');
    await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
    await writeFile(systemPromptPath, 'original prompt\n', 'utf8');
    await writeFile(resultsTsvPath, 'task_id\tpassed\ntask-a\tfalse\ntask-b\tfalse\n', 'utf8');

    await runPromptCandidateRound({
      runId: 'run-1',
      roundId: 'round-1',
      agentCwdPath: await testAgentCwd(dir),
      programPath,
      systemPromptPath,
      resultsTsvPath,
      resultsJsonlPath,
      heldInTaskIds,
      heldInDigests: heldInTaskIds.map((taskId) => ({ taskId, summary: 'failed held-in task' })),
      metaAgent: async () => candidatePromptResult(),
      git: gitNoop(dir),
      now: () => 100,
      newId: idFactory(),
    });

    const [event] = (await readFile(resultsJsonlPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    heldInTaskSetHash = event.heldInTaskSetHash;
  });
  return heldInTaskSetHash;
}

function expectedHeldInTaskSetHash(heldInTaskIds: readonly string[]): string {
  return sha256Json([...new Set(heldInTaskIds)].sort((a, b) => a.localeCompare(b)));
}

function expectedCandidateRationaleHash(candidateRationale: Record<string, unknown>): string {
  return sha256Json(candidateRationale);
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function gitNoop(gitRootPath = process.cwd()) {
  return {
    gitRootPath,
    systemPromptGitPath: 'system_prompt.md',
    assertSystemPromptClean: async () => {},
    changedFiles: async () => ['system_prompt.md'],
    commit: async () => 'commit-1',
    rollbackCommit: async () => {},
    restoreSystemPrompt: async () => {},
  };
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

function runtimeEvent(id: string, name: string, args: unknown) {
  return {
    id,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id, name, args },
  };
}

function traceToolFailedEvent(
  toolUseId: string,
  toolName: string,
  message: string,
  errorClass: string,
) {
  return {
    id: `trace-${toolUseId}-${errorClass}`,
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    type: 'tool_failed',
    phase: 'tool',
    message,
    data: {
      toolUseId,
      toolName,
      status: 'error',
      errorClass,
    },
  };
}

function functionResponseRuntimeEvent(id: string, name: string, result: unknown) {
  return {
    id: `response-${id}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: { kind: 'function_response', id, name, result },
  };
}

function textRuntimeEvent(text: string) {
  return {
    id: 'text-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text },
  };
}

function thinkingRuntimeEvent(text: string) {
  return {
    id: 'thinking-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'thinking', text },
  };
}

function errorRuntimeEvent(message: string, details?: unknown) {
  return {
    id: 'error-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: { kind: 'error', message, details },
  };
}

async function testAgentCwd(dir: string): Promise<string> {
  const agentCwdPath = join(dir, 'agent-cwd');
  await mkdir(agentCwdPath, { recursive: true });
  return agentCwdPath;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-prompt-candidate-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
