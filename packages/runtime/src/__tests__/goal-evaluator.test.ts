import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalEvaluation, evaluateGoal } from '../goal-evaluator.js';

describe('parseGoalEvaluation', () => {
  test('ignores a stray wait_seconds field in evaluator output', () => {
    const r = parseGoalEvaluation(
      '{"met": false, "waiting": true, "wait_seconds": 999999, "reason": "x"}',
    );
    assert.equal(r.waiting, true);
    assert.equal('waitSeconds' in r, false);
  });

  test('extracts JSON from surrounding prose', () => {
    const r = parseGoalEvaluation(
      'Here is my judgment:\n{"met": true, "impossible": false, "progress": true, "waiting": false, "reason": "all pass"}\nDone.',
    );
    assert.equal(r.met, true);
  });

  test('missing fields default to false', () => {
    const r = parseGoalEvaluation('{"met": true}');
    assert.equal(r.met, true);
    assert.equal(r.impossible, false);
    assert.equal(r.progress, false);
    assert.equal(r.waiting, false);
    assert.equal(r.reason, 'No reason provided');
  });

  test('unparseable output → neutral evaluator failure (not real no-progress)', () => {
    const r = parseGoalEvaluation('I cannot determine this');
    assert.equal(r.met, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('unparseable'));
  });

  test('malformed JSON → neutral evaluator failure', () => {
    const r = parseGoalEvaluation('{met: true, broken}');
    assert.equal(r.met, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('parse failed'));
  });

  test('braces inside reason → treated as neutral, not false no-progress', () => {
    // A coding-goal judge whose reason references code can defeat the flat regex.
    const r = parseGoalEvaluation(
      '{"met":false,"progress":true,"reason":"add return {} to handler"}',
    );
    // Either it parses (progress true) or it fails neutrally — never a real
    // progress=false that would count toward stall.
    if (r.evaluatorFailed) {
      assert.equal(r.progress, false);
    } else {
      assert.equal(r.progress, true);
    }
  });

  test('truncates long reason', () => {
    const long = 'x'.repeat(300);
    const r = parseGoalEvaluation(`{"met": false, "reason": "${long}"}`);
    assert.ok(r.reason.length <= 200);
  });
});

describe('evaluateGoal', () => {
  test('fails open on evaluator error (evaluatorFailed=true, continue)', async () => {
    const r = await evaluateGoal(
      {
        evaluate: async () => {
          throw new Error('network');
        },
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.met, false);
    assert.equal(r.impossible, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('failed'));
  });

  test('fails open on timeout (evaluatorFailed=true, continue)', async () => {
    let signal: AbortSignal | undefined;
    const r = await evaluateGoal(
      {
        // Never resolves — force the timeout branch.
        evaluate: (_prompt, _sessionId, receivedSignal) => {
          signal = receivedSignal;
          return new Promise<string>(() => {});
        },
        timeoutMs: 10,
        // Injected timer fires immediately so the race resolves to timeout.
        setTimeout: (fn) => {
          fn();
          return 1;
        },
        clearTimeout: () => {},
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(r.met, false);
    assert.equal(r.progress, false);
    assert.equal(r.evaluatorFailed, true);
    assert.ok(r.reason.includes('timed out'));
    assert.equal(signal?.aborted, true);
  });

  test('aborts the physical evaluator call when its owner is invalidated', async () => {
    const owner = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = evaluateGoal(
      {
        evaluate: (_prompt, _sessionId, receivedSignal) => {
          signal = receivedSignal;
          return new Promise<string>(() => {});
        },
      },
      'finish',
      'ctx',
      'sess-1',
      owner.signal,
    );

    owner.abort(new Error('lane invalidated'));
    const result = await pending;
    assert.equal(result.evaluatorFailed, true);
    assert.ok(result.reason.includes('cancelled'));
    assert.equal(signal?.aborted, true);
  });

  test('clears the timeout timer on success', async () => {
    let cleared = false;
    await evaluateGoal(
      {
        evaluate: async () => '{"met": true, "reason": "ok"}',
        setTimeout: () => 42,
        clearTimeout: (h) => {
          cleared = h === 42;
        },
      },
      'finish',
      'ctx',
      'sess-1',
    );
    assert.equal(cleared, true);
  });

  test('threads the sessionId into the evaluator (session-model routing)', async () => {
    let seenSessionId: string | undefined;
    await evaluateGoal(
      {
        evaluate: async (_prompt, sessionId) => {
          seenSessionId = sessionId;
          return '{"met": true, "reason": "ok"}';
        },
      },
      'finish',
      'ctx',
      'sess-42',
    );
    assert.equal(seenSessionId, 'sess-42');
  });
});
