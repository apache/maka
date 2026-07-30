import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
  assertAgentGraphIntentClaimRequest,
  decodeAgentGraphIntentClaim,
} from '../agent-graph-control.js';

describe('agent graph intent claim protocol', () => {
  test('accepts an exact durable claim shape', () => {
    const claim = {
      ...request(),
      claimedAt: 42,
    };
    assert.deepEqual(decodeAgentGraphIntentClaim(claim), claim);
    assert.doesNotThrow(() => assertAgentGraphIntentClaimRequest(request()));
  });

  test('rejects malformed identities, timestamps, and unknown fields', () => {
    assert.throws(
      () => decodeAgentGraphIntentClaim({ ...request(), claimedAt: -1 }),
      /Invalid agent graph intent claim/,
    );
    assert.throws(
      () =>
        assertAgentGraphIntentClaimRequest({
          ...request(),
          targetSessionId: 'session\nother',
        }),
      /Invalid agent graph intent claim request/,
    );
    assert.throws(
      () => decodeAgentGraphIntentClaim({ ...request(), claimedAt: 1, futureField: true }),
      /Invalid agent graph intent claim/,
    );
  });
});

function request() {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'summarizer',
    targetSessionId: 'session-child',
    targetTurnId: 'turn-next',
    targetRunId: 'run-next',
  };
}
