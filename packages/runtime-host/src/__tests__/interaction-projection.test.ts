import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  permissionCanonicalOutcome,
  runtimePermissionOutcome,
} from '../server/interaction-projection.js';

describe('Runtime Host Interaction projection', () => {
  test('round-trips auto-review rationale through the canonical permission outcome', () => {
    const runtimeAnswer = {
      decision: 'allow',
      rememberForTurn: true,
      reviewer: 'auto_review',
      rationale: 'The requested write is limited to the approved workspace path.',
      riskLevel: 'medium',
    } as const;

    const canonical = permissionCanonicalOutcome(runtimeAnswer, 42);

    assert.deepEqual(canonical, {
      kind: 'permission_answer',
      ...runtimeAnswer,
      committedAt: 42,
    });
    assert.deepEqual(runtimePermissionOutcome(canonical), {
      kind: 'permission_answer',
      answer: runtimeAnswer,
    });
  });

  test('does not inject rationale into a user permission answer', () => {
    const canonical = permissionCanonicalOutcome(
      {
        decision: 'deny',
        reviewer: 'user',
      },
      43,
    );

    assert.deepEqual(canonical, {
      kind: 'permission_answer',
      decision: 'deny',
      rememberForTurn: false,
      reviewer: 'user',
      committedAt: 43,
    });
    assert.deepEqual(runtimePermissionOutcome(canonical), {
      kind: 'permission_answer',
      answer: {
        decision: 'deny',
        rememberForTurn: false,
        reviewer: 'user',
      },
    });
    assert.equal('rationale' in canonical, false);
  });

  test('rejects rationale from a non-auto-review runtime answer', () => {
    assert.throws(
      () =>
        permissionCanonicalOutcome(
          {
            decision: 'allow',
            reviewer: 'user',
            rationale: 'User answers must not acquire an auto-review rationale.',
          },
          44,
        ),
      /Only auto-review permission outcomes can include rationale/,
    );
  });
});
