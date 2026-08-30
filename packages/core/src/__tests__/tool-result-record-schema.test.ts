/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../session.js';
import { decodeCanonicalMessage, decodeStoredMessage } from '../session.js';
import { markPersisted } from '../persisted-value.js';
import {
  decodeCanonicalToolResultContent,
  decodePersistedToolResultContent,
} from '../tool-result-record-schema.js';
import type { ToolResultContent } from '../events.js';

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
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(result))), result);
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
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(result))), result);
  });

  test('preserves the client capability source for actionable bypass recovery', () => {
    const result = {
      kind: 'text',
      text: 'Client Capability tools require the Bypass execution boundary.',
      sandboxFailure: {
        reason: 'requires_bypass',
        source: 'client_capability',
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(result))), result);
  });

  test('rejects malformed or widened boundary failure signals', () => {
    for (const sandboxFailure of [
      { reason: 'sandbox_denial' },
      { reason: 'requires_bypass', unexpected: true },
      { reason: 'requires_bypass', source: 'filesystem' },
      { reason: 'sandbox_boundary_required', source: 'client_capability' },
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

describe('uncertain tool outcome metadata', () => {
  test('preserves a non-retryable outcome_unknown signal', () => {
    const result = {
      kind: 'text',
      text: 'outcome_unknown: the provider accepted the action but did not return a result.',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    } as const;

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(result))), result);
  });

  test('rejects widened or retryable uncertain outcome signals', () => {
    for (const uncertainOutcome of [
      { code: 'outcome_unknown', retrySafe: true },
      { code: 'provider_failed', retrySafe: false },
      { code: 'outcome_unknown', retrySafe: false, unexpected: true },
    ]) {
      assert.throws(
        () =>
          decodeCanonicalToolResultContent({
            kind: 'text',
            text: 'uncertain',
            uncertainOutcome,
          }),
        /Invalid tool result content/,
      );
    }
  });
});

describe('retired permission modes in stored subagent results', () => {
  const stored = {
    kind: 'subagent',
    childSessionId: 'child-1',
    agentName: 'Explore',
    turnId: 'turn-1',
    status: 'completed',
    permissionMode: 'execute',
    summary: 'done',
    artifactIds: [],
  } as const;

  test('folds a legacy mode to its live equivalent instead of returning it verbatim', () => {
    const decoded = decodePersistedToolResultContent(markPersisted<ToolResultContent>(stored));
    assert.equal(decoded.kind === 'subagent' ? decoded.permissionMode : undefined, 'ask');
    assert.deepEqual(decoded, { ...stored, permissionMode: 'ask' });
  });

  test('folds through the stored-message decoder as well', () => {
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(stored))), {
      ...stored,
      permissionMode: 'ask',
    });
  });

  test('rejects retired values at canonical tool-result and message boundaries', () => {
    assert.throws(() => decodeCanonicalToolResultContent(stored), /Invalid tool result content/);
    assert.throws(
      () => decodeCanonicalMessage(storedToolResult(stored)),
      /Invalid tool result content/,
    );
  });

  test('leaves a live mode untouched', () => {
    const live = { ...stored, permissionMode: 'bypass' } as const;
    assert.deepEqual(decodeCanonicalToolResultContent(live), live);
  });

  test('still rejects a mode that never existed', () => {
    assert.throws(
      () => decodeCanonicalToolResultContent({ ...stored, permissionMode: 'nonsense' }),
      /Invalid tool result content/,
    );
  });
});

describe('retired ExploreAgent results in stored transcripts', () => {
  const stored = {
    kind: 'explore_agent',
    ok: true,
    mode: 'read_only',
    objective: 'Trace the session lifecycle.',
    roots: ['packages/runtime'],
    queries: ['SessionManager'],
    filesInspected: 3,
    filesSkipped: 1,
    bytesRead: 512,
    progress: ['Inspected the runtime entry point.'],
    candidateFiles: [],
    matches: [],
    notes: [],
    report: 'SessionManager owns the lifecycle.',
  } as const;

  test('folds the legacy result to ordinary historical text at every persisted read boundary', () => {
    const expected = { kind: 'text', text: 'SessionManager owns the lifecycle.' };

    assert.deepEqual(
      decodePersistedToolResultContent(
        markPersisted<ToolResultContent>(stored as unknown as ToolResultContent),
      ),
      expected,
    );
    assert.deepEqual(toolResultContent(decodePersistedMessage(storedToolResult(stored))), expected);
  });

  test('accepts the earliest persisted shape before progress was added', () => {
    const earliest = {
      kind: 'explore_agent',
      ok: true,
      mode: 'read_only',
      objective: 'Trace the session lifecycle.',
      roots: ['packages/runtime'],
      queries: ['SessionManager'],
      filesInspected: 3,
      filesSkipped: 1,
      bytesRead: 512,
      candidateFiles: [],
      matches: [],
      notes: [],
    } as const;
    const expected = { kind: 'text', text: 'Inspected 3 files' };

    assert.deepEqual(
      decodePersistedToolResultContent(
        markPersisted<ToolResultContent>(earliest as unknown as ToolResultContent),
      ),
      expected,
    );
    assert.deepEqual(
      toolResultContent(decodePersistedMessage(storedToolResult(earliest))),
      expected,
    );
  });

  test('uses a non-empty failure summary when the legacy report is empty', () => {
    const failed = {
      ...stored,
      ok: false,
      terminalStatus: 'failed',
      report: '',
      summary: '未完成：目标无效。',
      reason: 'invalid_objective',
      message: '目标无效。',
    } as const;

    assert.deepEqual(
      decodePersistedToolResultContent(
        markPersisted<ToolResultContent>(failed as unknown as ToolResultContent),
      ),
      { kind: 'text', text: '未完成：目标无效。' },
    );
  });

  test('ignores retired structured detail after establishing legacy provenance', () => {
    const malformedDetails = {
      ...stored,
      report: undefined,
      progress: { invalid: true },
      matches: 'not an array',
      filesInspected: undefined,
      removedInLaterVersions: true,
    };

    assert.deepEqual(
      decodePersistedToolResultContent(
        markPersisted<ToolResultContent>(malformedDetails as unknown as ToolResultContent),
      ),
      { kind: 'text', text: 'Historical repository scan result' },
    );
  });

  test('requires stable legacy provenance at persisted read boundaries', () => {
    assert.throws(
      () =>
        decodePersistedToolResultContent(
          markPersisted<ToolResultContent>({
            kind: 'explore_agent',
            ok: true,
            mode: 'write_enabled',
          } as unknown as ToolResultContent),
        ),
      /Invalid tool result content/,
    );
  });

  test('rejects the retired result kind at canonical live boundaries', () => {
    assert.throws(() => decodeCanonicalToolResultContent(stored), /Invalid tool result content/);
    assert.throws(
      () => decodeCanonicalMessage(storedToolResult(stored)),
      /Invalid tool result content/,
    );
  });
});

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

function decodePersistedMessage(value: unknown): StoredMessage {
  return decodeStoredMessage(markPersisted<StoredMessage>(value));
}

function toolResultContent(message: StoredMessage) {
  if (message.type !== 'tool_result') throw new Error('Expected tool result');
  return message.content;
}
