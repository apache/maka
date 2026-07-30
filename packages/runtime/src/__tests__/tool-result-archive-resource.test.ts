import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  buildToolResultArchiveResourceRef,
  parseToolResultArchiveResourceRef,
  readToolResultArchiveResource,
  TOOL_RESULT_ARCHIVE_MAX_LIMIT,
  TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS,
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
    assert.deepEqual(parseToolResultArchiveResourceRef(ref), identity);
    assert.equal(parseToolResultArchiveResourceRef('tool-result-archive-abc'), null);
    assert.equal(parseToolResultArchiveResourceRef('maka://runtime/background-tasks/1'), null);
    assert.equal(parseToolResultArchiveResourceRef(`${ref}&unexpected=true`), null);
    assert.equal(
      parseToolResultArchiveResourceRef('maka://archive/%E0%A4%A?sha256=0&bytes=1'),
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
