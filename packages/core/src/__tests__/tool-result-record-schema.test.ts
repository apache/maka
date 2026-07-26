import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../session.js';
import { decodeStoredMessageForRead, decodeStoredMessageForRecovery } from '../session.js';
import { decodeCanonicalToolResultContent } from '../tool-result-record-schema.js';

describe('legacy subagent tool result compatibility', () => {
  test('normalizes the exact legacy status for normal and strict persisted reads', () => {
    const legacy = legacySubagentResult();
    const expected = { ...legacy, status: 'waiting_for_user' };

    assert.deepEqual(
      toolResultContent(decodeStoredMessageForRead(storedToolResult(legacy))),
      expected,
    );
    assert.deepEqual(
      toolResultContent(decodeStoredMessageForRecovery(storedToolResult(legacy))),
      expected,
    );
  });

  test('keeps the public canonical decoder strict', () => {
    assert.throws(
      () => decodeCanonicalToolResultContent(legacySubagentResult()),
      /Invalid tool result content/,
    );
  });

  test('rejects malformed or widened legacy subagent results', () => {
    for (const value of [
      { ...legacySubagentResult(), unexpected: true },
      { ...legacySubagentResult(), permissionMode: 'always' },
      { ...legacySubagentResult(), artifactIds: [1] },
    ]) {
      assert.throws(
        () => decodeStoredMessageForRead(storedToolResult(value)),
        /Invalid tool result content/,
      );
      assert.throws(
        () => decodeStoredMessageForRecovery(storedToolResult(value)),
        /Invalid tool result content/,
      );
    }
  });

  test('does not admit legacy shell results through the recovery decoder', () => {
    assert.throws(
      () =>
        decodeStoredMessageForRecovery(
          storedToolResult({
            kind: 'terminal',
            cwd: '/workspace',
            cmd: 'printf ok',
            status: 'completed',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      /Invalid shell tool result content/,
    );
  });
});

function legacySubagentResult(): Record<string, unknown> {
  return {
    kind: 'subagent',
    childSessionId: 'child-session-1',
    agentId: 'local-read',
    agentName: 'Local Read',
    turnId: 'child-turn-1',
    runId: 'child-run-1',
    status: 'waiting_permission',
    permissionMode: 'ask',
    summary: 'Waiting for permission.',
    artifactIds: [],
    startedAt: 10,
    eventCount: 3,
  };
}

function storedToolResult(content: unknown) {
  return {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'call-1',
    isError: false,
    content,
  };
}

function toolResultContent(message: StoredMessage) {
  if (message.type !== 'tool_result') throw new Error('Expected tool result');
  return message.content;
}
