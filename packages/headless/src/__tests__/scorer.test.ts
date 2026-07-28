import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Config, SubmittedSnapshot, Task } from '../contracts.js';
import { defaultFinalScorer } from '../scorer.js';
import type { VerifierResult } from '../task-contracts.js';

const config: Config = { id: 'cfg', backend: 'fake', llmConnectionSlug: 'fake' };
const task: Task = { id: 'task', instruction: 'solve', workspaceDir: '/tmp/workspace' };
const submittedSnapshot: SubmittedSnapshot = {
  id: 'snapshot',
  workspaceRoot: '/tmp/workspace',
  snapshotPath: '/tmp/snapshot',
  artifactRefs: [],
  createdAt: 1,
};

describe('defaultFinalScorer', () => {
  test('classifies sandbox boundary failures as non-retryable policy denials', () => {
    for (const failureClass of ['requires_bypass', 'sandbox_boundary_required']) {
      const score = defaultFinalScorer({
        config,
        task,
        runnerCompleted: false,
        runnerStatus: 'failed',
        invocationFailure: { class: failureClass },
        submittedSnapshot,
      });

      assert.equal(score.taxonomy, 'policy_denied');
      assert.equal(score.errorClass, failureClass);
    }
  });

  test('does not let a non-authoritative placeholder mask runner failure taxonomy', () => {
    const verifierResult: VerifierResult = {
      id: 'verifier',
      taskRunId: 'run',
      ts: 1,
      kind: 'terminal_bench',
      passed: false,
      exitCode: 1,
      errorClass: 'verification_failed',
      authority: { source: 'self_check', authoritative: false },
      details: { verificationPlaceholder: true },
    };

    const score = defaultFinalScorer({
      config,
      task,
      runnerCompleted: false,
      runnerStatus: 'failed',
      invocationFailure: { class: 'incomplete_tool_calls', message: 'model stopped mid-tool-call' },
      submittedSnapshot,
      verifierResult,
    });

    assert.equal(score.taxonomy, 'agent_incomplete');
    assert.equal(score.errorClass, 'incomplete_tool_calls');
  });

  test('keeps official verifier failure authoritative over advisory semantic completion', () => {
    const verifierResult: VerifierResult = {
      id: 'verifier',
      taskRunId: 'run',
      ts: 1,
      kind: 'terminal_bench',
      passed: false,
      exitCode: 1,
      errorClass: 'verification_failed',
      authority: { source: 'official_harbor_verifier', authoritative: true },
    };

    const score = defaultFinalScorer({
      config,
      task,
      runnerCompleted: true,
      runnerStatus: 'completed',
      submittedSnapshot,
      verifierResult,
    });

    assert.equal(score.passed, false);
    assert.equal(score.scored, true);
    assert.equal(score.eligible, true);
    assert.equal(score.taxonomy, 'verification_failed');
    assert.equal(score.errorClass, 'verification_failed');
  });

  test('does not treat compact evidence as verifier authority', () => {
    const verifierResult: VerifierResult = {
      id: 'verifier',
      taskRunId: 'run',
      ts: 1,
      kind: 'command',
      passed: false,
      exitCode: 1,
      errorClass: 'verification_failed',
      authority: { source: 'official_harbor_verifier', authoritative: true },
      details: {
        compactEvidence: {
          latest: {
            schemaVersion: 1,
            evidenceId: 'evidence-pass-like',
            taskRunId: 'run',
            ts: 1,
            kind: 'check',
            public: true,
            source: { kind: 'model_tool', toolCallId: 'tool-1' },
            check: { status: 'pass', linkedSelfCheckId: 'self-check-1' },
          },
        },
      },
    };

    const score = defaultFinalScorer({
      config,
      task,
      runnerCompleted: true,
      runnerStatus: 'completed',
      submittedSnapshot,
      verifierResult,
    });

    assert.equal(score.passed, false);
    assert.equal(score.scored, true);
    assert.equal(score.eligible, true);
    assert.equal(score.taxonomy, 'verification_failed');
    assert.equal(score.errorClass, 'verification_failed');
  });
});
