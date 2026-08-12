import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';

describe('semantic compaction policy env plumbing (issue #882 PR 3)', () => {
  test('defaults off: the #986 experiment is opt-in, not part of the runtime default', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), { env: {} });
    // The rest of the default budget still exists (history compaction stays on),
    // proving the policy is built but simply omits the experiment.
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.equal(policy?.semanticCompact, undefined);
  });

  test('honors an explicit MAKA_CONTEXT_SEMANTIC_COMPACT=on opt-in', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: { MAKA_CONTEXT_SEMANTIC_COMPACT: 'on' },
    });
    assert.equal(policy?.semanticCompact?.enabled, true);
    assert.equal(policy?.semanticCompact?.mode, 'replace');
    assert.equal(policy?.semanticCompact?.maxActiveEstimatedTokens, 131_072);
    assert.equal(policy?.semanticCompact?.highWaterRatio, 1);
    assert.equal(policy?.semanticCompact?.minSafePrefixEstimatedTokens, 4_096);
  });

  test('honors an explicit mode as an opt-in even without the boolean flag', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: { MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'validate_only' },
    });
    assert.equal(policy?.semanticCompact?.enabled, true);
    assert.equal(policy?.semanticCompact?.mode, 'validate_only');
  });

  test('an explicit mode of off keeps it disabled', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: { MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'off' },
    });
    assert.equal(policy?.semanticCompact, undefined);
  });
});

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
