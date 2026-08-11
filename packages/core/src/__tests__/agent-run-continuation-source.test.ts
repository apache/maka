import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeAgentRunHeader, type AgentRunHeader } from '../agent-run.js';

describe('AgentRun continuation source decoding', () => {
  it('rejects an empty V2 continuation claim identity', () => {
    assert.throws(
      () =>
        decodeAgentRunHeader(
          headerWithContinuation({
            ...validV2ContinuationSource(),
            claimId: '',
          }),
        ),
      /Invalid AgentRun header schema/,
    );
  });

  it('rejects a zero V2 source high-water', () => {
    assert.throws(
      () =>
        decodeAgentRunHeader(
          headerWithContinuation({
            ...validV2ContinuationSource(),
            sourceRuntimeEventHighWater: 0,
          }),
        ),
      /Invalid AgentRun header schema/,
    );
  });

  for (const field of ['sourceInvocationId', 'sourceRunId', 'sourceTurnId'] as const) {
    it(`rejects an empty V2 ${field}`, () => {
      assert.throws(
        () =>
          decodeAgentRunHeader(
            headerWithContinuation({
              ...validV2ContinuationSource(),
              [field]: '',
            }),
          ),
        /Invalid AgentRun header schema/,
      );
    });
  }

  it('rejects a V2 replay manifest that does not identify its boundary', () => {
    assert.throws(
      () =>
        decodeAgentRunHeader(
          headerWithContinuation({
            ...validV2ContinuationSource(),
            replayManifestDigest: `sha256:${'c'.repeat(64)}`,
          }),
        ),
      /Invalid AgentRun header schema/,
    );
  });
});

function headerWithContinuation(
  continuationSource: AgentRunHeader['continuationSource'],
): AgentRunHeader {
  return {
    runId: 'target-run',
    invocationId: 'target-invocation',
    sessionId: 'session-1',
    turnId: 'target-turn',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'test',
    modelId: 'test-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    continuationSource,
  };
}

function validV2ContinuationSource(): Extract<
  NonNullable<AgentRunHeader['continuationSource']>,
  { protocol: 'continuation_source_v2' }
> {
  return {
    protocol: 'continuation_source_v2',
    claimId: 'claim-1',
    boundaryDigest: `sha256:${'a'.repeat(64)}`,
    sourceInvocationId: 'source-invocation',
    sourceRunId: 'source-run',
    sourceTurnId: 'source-turn',
    sourceRuntimeEventHighWater: 1,
    sourcePrefixDigest: `sha256:${'b'.repeat(64)}`,
    replayManifestDigest: `sha256:${'a'.repeat(64)}`,
  };
}
