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

describe('sandbox denial tool result metadata', () => {
  test('accepts a canonical text result carrying a sandbox denial signal', () => {
    const result = {
      kind: 'text',
      text: 'Filesystem access was denied.',
      sandboxDenial: {
        likely: true,
        backend: 'macos-seatbelt',
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(
      toolResultContent(decodeStoredMessageForRecovery(storedToolResult(result))),
      result,
    );
  });

  test('rejects malformed or widened sandbox denial signals', () => {
    for (const sandboxDenial of [
      { likely: false },
      { likely: true, backend: 'none' },
      { likely: true, backend: 'macos-seatbelt', recovery: 'require_escalated' },
      { likely: true, unexpected: true },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'denied',
            sandboxDenial,
          }),
        /Invalid tool result content/,
      );
    }
  });
});

describe('sandbox boundary failure tool result metadata', () => {
  test('preserves the machine-readable reason and exact required expansion', () => {
    const result = {
      kind: 'text',
      text: 'Bash requires an approved session sandbox boundary expansion.',
      sandboxFailure: {
        reason: 'sandbox_boundary_required',
        requiredExpansion: { network: { enabled: true } },
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(
      toolResultContent(decodeStoredMessageForRecovery(storedToolResult(result))),
      result,
    );
  });

  test('rejects malformed or widened boundary failure signals', () => {
    for (const sandboxFailure of [
      { reason: 'sandbox_denial' },
      { reason: 'requires_bypass', unexpected: true },
      { reason: 'sandbox_boundary_required', requiredExpansion: {} },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'denied',
            sandboxFailure,
          }),
        /Invalid tool result content/,
      );
    }
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
