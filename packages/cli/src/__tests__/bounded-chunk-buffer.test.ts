import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BoundedChunkBuffer } from '../bounded-chunk-buffer.js';

interface Chunk {
  text: string;
}

describe('BoundedChunkBuffer', () => {
  test('releases a discarded backing slot before delayed storage compaction', () => {
    const buffer = new BoundedChunkBuffer<Chunk>({
      maxChars: 3,
      maxChunks: 512,
      textOf: (chunk) => chunk.text,
      withText: (chunk, text) => ({ ...chunk, text }),
    });
    const discarded = { text: 'old' };
    buffer.append(discarded);
    buffer.append({ text: 'new' });

    // values() cannot reliably expose retained backing-slot references, so this white-box check is justified.
    const storage = buffer as unknown as { chunks: Array<Chunk | undefined>; head: number };
    assert.equal(storage.head, 1);
    assert.equal(storage.chunks[0], undefined);
  });

  test('ignores a replay of a sequence that was already discarded', () => {
    const buffer = new BoundedChunkBuffer<Chunk & { seq: number }>({
      maxChars: 1,
      maxChunks: 512,
      textOf: (chunk) => chunk.text,
      withText: (chunk, text) => ({ ...chunk, text }),
      sequence: (chunk) => chunk.seq,
    });
    buffer.append({ seq: 1, text: 'a' });
    buffer.append({ seq: 2, text: 'b' });

    assert.equal(buffer.append({ seq: 1, text: 'a' }), false);
    assert.equal(buffer.droppedChars, 1);
    assert.equal(buffer.version, 2);
    assert.deepEqual(buffer.values(), [{ seq: 2, text: 'b' }]);
  });

  test('does not split a UTF-16 surrogate pair at the character boundary', () => {
    const buffer = new BoundedChunkBuffer<string>({
      maxChars: 2,
      maxChunks: 512,
      textOf: (chunk) => chunk,
      withText: (_chunk, text) => text,
    });

    buffer.append('😀a');

    assert.deepEqual(buffer.values(), ['a']);
    assert.equal(buffer.droppedChars, 2);
  });
});
