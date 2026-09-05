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
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  buildToolResultArchiveResourceRef,
  parseToolResultArchiveResourceRef,
  readToolResultArchiveResource,
  TOOL_RESULT_ARCHIVE_MAX_LIMIT,
  TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS,
  TOOL_RESULT_ARCHIVE_MAX_SEARCH_MATCHES,
  type ToolResultArchiveResourceReader,
} from '../tool-result-archive-resource.js';

describe('tool-result archive resources', () => {
  test('round-trips a first-class archive URI with integrity metadata', () => {
    const body = JSON.stringify({ ok: true });
    const identity = {
      artifactId: 'tool-result-archive-abc',
      bodySha256: sha256(body),
      originalBytes: Buffer.byteLength(body),
    };
    const ref = buildToolResultArchiveResourceRef(identity);

    assert.match(ref, /^maka:\/\/archive\//);
    assert.doesNotMatch(ref, /[?&]/);
    assert.deepEqual(parseToolResultArchiveResourceRef(ref), identity);
    assert.equal(parseToolResultArchiveResourceRef('tool-result-archive-abc'), null);
    assert.equal(parseToolResultArchiveResourceRef('maka://runtime/background-tasks/1'), null);
    assert.equal(parseToolResultArchiveResourceRef(`${ref}?unexpected=true`), null);
    assert.equal(
      parseToolResultArchiveResourceRef(`maka://archive/%E0%A4%A/${'0'.repeat(64)}/1`),
      null,
    );
  });

  test('inspect exposes a bounded swarm manifest without embedding summaries', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      status: 'completed',
      items: [
        {
          itemId: 'core',
          status: 'completed',
          childSessionId: 'child-1',
          summary: 'S'.repeat(20_000),
        },
        {
          itemId: 'runtime',
          status: 'completed',
          childSessionId: 'child-2',
          summary: 'R'.repeat(10_000),
        },
      ],
    });
    const { ref, reader } = fixture(body);
    const result = await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    });
    const serialized = JSON.stringify(result);

    assert.match(serialized, /"itemCount":2/);
    assert.match(serialized, /"itemId":"core"/);
    assert.match(serialized, /"summaryChars":20000/);
    assert.doesNotMatch(serialized, /SSSSSSSSSS/);
    assert.ok(serialized.length < TOOL_RESULT_ARCHIVE_MAX_LIMIT);
  });

  test('keeps an adversarial inspect manifest below the response budget', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      items: Array.from({ length: 100 }, (_, index) => ({
        itemId: `worker-${index}-${'I'.repeat(2_000)}`,
        profile: 'P'.repeat(2_000),
        agentName: 'N'.repeat(2_000),
        summary: 'S'.repeat(2_000),
      })),
    });
    const { ref, reader } = fixture(body);
    const result = await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    });
    const serialized = JSON.stringify(result);

    assert.ok(serialized.length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS);
    assert.equal((result as { itemsTruncated: boolean }).itemsTruncated, true);
  });

  test('keeps mixed keys and manifest metadata below the response budget', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      status: 'completed',
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => ['key_' + index + '_' + 'K'.repeat(120), 'v']),
      ),
      items: Array.from({ length: 20 }, (_, index) => ({
        itemId: 'worker-' + index + '-' + 'I'.repeat(120),
        profile: 'P'.repeat(120),
        agentName: 'N'.repeat(120),
        summary: 'S'.repeat(120),
      })),
    });
    const { ref, reader } = fixture(body);
    const result = await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    });

    assert.ok(JSON.stringify(result).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS);
  });

  test('keeps empty manifests with escaped keys below the response budget', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      status: 'completed',
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => ['key_' + index + '_' + '\\'.repeat(120), 'v']),
      ),
      items: [],
    });
    const { ref, reader } = fixture(body);
    const result = await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    });

    assert.ok(JSON.stringify(result).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS);
  });

  test('keeps a queryable item after trimming escaped manifest keys', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      status: 'completed',
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => ['key_' + index + '_' + '\\'.repeat(160), 'v']),
      ),
      items: [{ itemId: 'core', summary: 'complete' }],
    });
    const { ref, reader } = fixture(body);
    const inspected = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    })) as { items: Array<{ itemId?: string }> };

    assert.ok(JSON.stringify(inspected).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS);
    assert.equal(inspected.items[0]?.itemId, 'core');

    const queried = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'query',
      itemId: inspected.items[0]?.itemId,
    })) as { ok: boolean; itemId: string };
    assert.equal(queried.ok, true);
    assert.equal(queried.itemId, 'core');
  });

  test('query selects one swarm item and paginates below the prune threshold', async () => {
    const body = JSON.stringify({
      kind: 'agent_swarm',
      items: [
        { itemId: 'core', summary: 'A'.repeat(20_000) },
        { itemId: 'runtime', summary: 'B'.repeat(20_000) },
      ],
    });
    const { ref, reader } = fixture(body);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'query',
      itemId: 'runtime',
      offset: 100,
      limit: 2_000,
    })) as Record<string, unknown>;

    assert.equal(result.itemId, 'runtime');
    assert.equal(result.offset, 100);
    assert.equal(result.nextOffset, 2_100);
    assert.equal(result.hasMore, true);
    assert.equal((result.content as string).length, 2_000);
    assert.doesNotMatch(result.content as string, /A/);
  });

  test('delegates session, size, and checksum authority to the host reader', async () => {
    const body = JSON.stringify({ value: 'hello' });
    const seen: unknown[] = [];
    const { ref } = fixture(body);
    const reader: ToolResultArchiveResourceReader = {
      readArchivedToolResultResource(input) {
        seen.push(input);
        return { ok: false, reason: 'session_mismatch' };
      },
    };

    const result = await readToolResultArchiveResource(reader, 'wrong-session', {
      ref,
      operation: 'inspect',
    });

    assert.equal((result as { reason: string }).reason, 'session_mismatch');
    assert.equal((seen[0] as { sessionId: string }).sessionId, 'wrong-session');
    assert.equal((seen[0] as { bodySha256: string }).bodySha256, sha256(body));
  });
});

describe('ArchiveRead retrieval ergonomics', () => {
  test('inspect surfaces a positional index and preview for text payloads', async () => {
    const text = ['line one', 'line two', 'line three'].join('\n');
    const { ref, reader } = textFixture(text);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    })) as Record<string, unknown>;

    assert.equal(result.valueType, 'text');
    assert.equal(result.totalChars, text.length);
    assert.equal(result.totalLines, 3);
    assert.match(result.preview as string, /line one/);
  });

  test('read pages the decoded string for text payloads, not the escaped JSON', async () => {
    const text = 'line1\nline2"quote';
    const { ref, reader } = textFixture(text);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      offset: 0,
      limit: 100,
    })) as Record<string, unknown>;

    // Decoded: starts with the real first char and carries a literal newline,
    // rather than the JSON serialization that would begin with a quote and \n.
    assert.equal((result.content as string).startsWith('line1'), true);
    assert.equal((result.content as string).includes('\n'), true);
    assert.equal((result.content as string).includes('\\n'), false);
  });

  test('read and search project terminal streams instead of JSON-escaped output', async () => {
    const { ref, reader } = fixture(
      JSON.stringify({
        kind: 'terminal',
        output: { mode: 'pipes', stdout: 'out\nNEEDLE', stderr: 'err' },
      }),
    );
    const inspected = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    })) as Record<string, unknown>;
    assert.equal(inspected.valueType, 'terminal');
    assert.equal(inspected.totalLines, 3);

    const page = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 1,
      limit: 1,
    })) as Record<string, unknown>;
    assert.equal(page.content, 'NEEDLE');

    const searched = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'needle',
    })) as Record<string, unknown>;
    assert.equal((searched.matches as Array<Record<string, unknown>>)[0]!.line, 2);
  });

  test('read and search stderr-only shell output when stdout is empty', async () => {
    const { ref, reader } = fixture(
      JSON.stringify({
        kind: 'shell_run',
        output: { mode: 'pipes', stdout: '', stderr: 'boom: NEEDLE failed' },
      }),
    );
    const inspected = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'inspect',
    })) as Record<string, unknown>;
    assert.equal(inspected.valueType, 'terminal');
    assert.equal(inspected.totalChars, 'boom: NEEDLE failed'.length);

    const page = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 0,
      limit: 1,
    })) as Record<string, unknown>;
    assert.equal(page.content, 'boom: NEEDLE failed');

    const searched = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'needle',
    })) as Record<string, unknown>;
    assert.equal((searched.matches as Array<Record<string, unknown>>)[0]!.line, 1);
  });

  test('read and search project PTY terminal streams', async () => {
    const { ref, reader } = fixture(
      JSON.stringify({
        kind: 'terminal',
        output: { mode: 'pty', scrollback: 'history', screen: 'NEEDLE', lastAlternateScreen: '' },
      }),
    );
    const page = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 1,
      limit: 1,
    })) as Record<string, unknown>;
    assert.equal(page.content, 'NEEDLE');

    const searched = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'needle',
    })) as Record<string, unknown>;
    assert.equal((searched.matches as Array<Record<string, unknown>>)[0]!.line, 2);
  });

  test('line paging reports an oversized line instead of returning a stuck empty page', async () => {
    const { ref, reader } = textFixture('x'.repeat(8_000));
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 0,
      limit: 1,
    })) as Record<string, unknown>;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'line_too_large');
    assert.equal(result.lineOffset, 0);
    assert.equal(result.lineChars, 8_000);
  });

  test('empty text has no phantom line in line pagination', async () => {
    const { ref, reader } = textFixture('');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 0,
      limit: 1,
    })) as Record<string, unknown>;

    assert.equal(result.totalLines, 0);
    assert.equal(result.lineLimit, 0);
    assert.equal(result.nextLineOffset, null);
    assert.equal(result.content, '');
  });

  test('read by line range returns whole lines and resumes with nextLineOffset', async () => {
    const text = Array.from({ length: 10 }, (_, index) => `L${index}`).join('\n');
    const { ref, reader } = textFixture(text);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'read',
      unit: 'line',
      offset: 2,
      limit: 3,
    })) as Record<string, unknown>;

    assert.equal(result.unit, 'line');
    assert.equal(result.lineOffset, 2);
    assert.equal(result.lineLimit, 3);
    assert.equal(result.totalLines, 10);
    assert.equal(result.content, 'L2\nL3\nL4');
    assert.equal(result.nextLineOffset, 5);
    assert.equal(result.hasMore, true);
  });

  test('search locates a case-insensitive substring with offsets, lines, and snippets', async () => {
    const text = 'alpha\nbravo NEEDLE charlie\nNEEDLE delta';
    const { ref, reader } = textFixture(text);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'needle',
    })) as Record<string, unknown>;

    const matches = result.matches as Array<Record<string, unknown>>;
    assert.equal(result.matchCount, 2);
    assert.equal(matches[0]!.line, 2);
    assert.equal(matches[1]!.line, 3);
    assert.ok((matches[0]!.offset as number) < (matches[1]!.offset as number));
    assert.match(matches[0]!.snippet as string, /NEEDLE/);
    assert.equal(result.hasMore, false);
  });

  test('search stays within the response budget and resumes for pathological match counts', async () => {
    const text = 'x'.repeat(200_000).replace(/x/g, 'ab'); // dense, overlapping-free hits of "ab"
    const { ref, reader } = textFixture(text);
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'ab',
    })) as Record<string, unknown>;

    assert.ok(JSON.stringify(result).length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS);
    assert.ok((result.matchCount as number) <= TOOL_RESULT_ARCHIVE_MAX_SEARCH_MATCHES);
    assert.equal(result.hasMore, true);
    assert.equal(typeof result.nextOffset, 'number');
  });

  test('search without a pattern fails closed', async () => {
    const { ref, reader } = textFixture('anything');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
    })) as Record<string, unknown>;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pattern_required');
  });

  test('search preserves source offsets when Unicode lowercasing expands a character', async () => {
    const { ref, reader } = textFixture('İA');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'A',
    })) as Record<string, unknown>;
    const match = (result.matches as Array<Record<string, unknown>>)[0]!;

    assert.equal(match.offset, 1);
    assert.equal(match.snippet, 'İA');
  });

  test('search folds Greek final sigma across case in original coordinates', async () => {
    // "ΟΔΟΣ" ends in a capital sigma whose lowercase form is the contextual
    // final sigma "ς", not the medial "σ". Case-insensitive search must fold the
    // complete string (so a lowercase final-sigma pattern still matches) and must
    // report offsets in the original text coordinate space. A per-code-point or
    // text-lowercasing implementation regresses this: it either misses the match
    // or reports a shifted offset whose follow-up read returns empty content.
    const { ref, reader } = textFixture('ΟΔΟΣ');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: 'οδος',
    })) as Record<string, unknown>;
    const matches = result.matches as Array<Record<string, unknown>>;

    assert.equal(result.matchCount, 1);
    assert.equal(matches[0]!.offset, 0);
    assert.equal(matches[0]!.snippet, 'ΟΔΟΣ');
  });

  test('search never resumes before a requested mid-surrogate offset', async () => {
    const { ref, reader } = textFixture('a😀b😀z');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern: '😀',
      offset: 2,
    })) as Record<string, unknown>;
    const match = (result.matches as Array<Record<string, unknown>>)[0]!;

    assert.equal(match.offset, 4);
    assert.ok((match.offset as number) >= 2);
  });

  test('preserves accepted long search patterns and complete matching snippets', async () => {
    const pattern = 'A'.repeat(256);
    const { ref, reader } = textFixture('prefix ' + pattern + ' suffix');
    const result = (await readToolResultArchiveResource(reader, 'session-1', {
      ref,
      operation: 'search',
      pattern,
    })) as Record<string, unknown>;
    const match = (result.matches as Array<Record<string, unknown>>)[0]!;

    assert.equal(result.pattern, pattern);
    assert.match(match.snippet as string, new RegExp(pattern));
  });
});

function textFixture(text: string): { ref: string; reader: ToolResultArchiveResourceReader } {
  return fixture(JSON.stringify(text));
}

function fixture(body: string): { ref: string; reader: ToolResultArchiveResourceReader } {
  const identity = {
    artifactId: `tool-result-archive-${'a'.repeat(32)}`,
    bodySha256: sha256(body),
    originalBytes: Buffer.byteLength(body),
  };
  return {
    ref: buildToolResultArchiveResourceRef(identity),
    reader: {
      readArchivedToolResultResource(input) {
        assert.equal(input.artifactId, identity.artifactId);
        assert.equal(input.bodySha256, identity.bodySha256);
        assert.equal(input.originalBytes, identity.originalBytes);
        assert.equal(input.sessionId, 'session-1');
        return { ok: true, serializedResult: body };
      },
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
