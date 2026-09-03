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
import { describe, it } from 'node:test';
import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import { DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES } from '@maka/core/durable-tool-result-projection';
import { serializedByteLength } from '@maka/core/serialized-byte-length';

import {
  decodeEffectiveToolResultProjection,
  encodeDefaultDurableToolResultOutput,
  encodeDurableToolResultOutput,
  encodeDurableToolResultOutputWithArtifacts,
} from '../durable-tool-result-projection.js';

describe('durable Tool Result projection codec', () => {
  it('preserves arbitrary text and JSON content faithfully', () => {
    assert.deepEqual(
      encodeDurableToolResultOutput(
        { type: 'text', value: 'Authorization: Bearer sk-live-secret-token-value' },
        'session-1',
      ),
      {
        version: 1,
        kind: 'text',
        text: 'Authorization: Bearer sk-live-secret-token-value',
      },
    );
    assert.deepEqual(
      encodeDurableToolResultOutput(
        {
          type: 'json',
          value: { password: 'correct-horse-battery-staple', keep: 'visible' },
        },
        'session-1',
      ),
      {
        version: 1,
        kind: 'json',
        value: { password: 'correct-horse-battery-staple', keep: 'visible' },
      },
    );
  });

  it('never persists inline binary or provider options', () => {
    const projection = encodeDurableToolResultOutput(
      {
        type: 'content',
        value: [
          { type: 'text', text: 'visible', providerOptions: { provider: { opaque: true } } },
          {
            type: 'file',
            data: { type: 'data', data: 'unbounded-base64-payload' },
            mediaType: 'image/png',
            providerOptions: { provider: { opaque: true } },
          },
        ],
      },
      'session-1',
    );

    assert.doesNotMatch(JSON.stringify(projection), /unbounded-base64-payload|providerOptions/);
    assert.deepEqual(projection, {
      version: 1,
      kind: 'content',
      parts: [
        { kind: 'text', text: 'visible' },
        {
          kind: 'text',
          text: '[Binary tool output omitted from the durable model projection; repeat the tool call if it is still needed.]',
        },
      ],
    });
  });

  it('maps opaque and oversized JSON to the same deterministic failure sentinel', () => {
    const opaque = encodeDurableToolResultOutput(
      { type: 'json', value: new URL('https://example.test') as never },
      'session-1',
    );
    const oversized = encodeDurableToolResultOutput(
      { type: 'json', value: { body: 'x'.repeat(300_000) } },
      'session-1',
    );

    assert.deepEqual(opaque, oversized);
    assert.deepEqual(opaque, {
      version: 1,
      kind: 'failure',
      reason: 'projection_failed',
      message: 'The tool completed, but its model-visible result could not be projected safely.',
    });
  });

  it('fails deterministically instead of silently dropping excess content parts', () => {
    const projection = encodeDurableToolResultOutput(
      {
        type: 'content',
        value: Array.from({ length: 65 }, (_, index) => ({
          type: 'text' as const,
          text: `part-${index}`,
        })),
      },
      'session-1',
    );

    assert.equal(projection.kind, 'failure');
  });

  it('validates every inline image before persisting any projection artifact', async () => {
    let writes = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: Buffer.from('valid').toString('base64') },
            mediaType: 'image/png',
          },
          {
            type: 'file',
            data: { type: 'data', data: 'not-canonical-base64' },
            mediaType: 'image/png',
          },
        ],
      },
      'session-1',
      artifactPlanner(() => {
        writes += 1;
      }),
    );

    assert.equal(projection.kind, 'failure');
    assert.equal(writes, 0);
  });

  it('rejects an oversized ArrayBuffer before copying its bytes', async () => {
    class ObservableArrayBuffer extends ArrayBuffer {
      copies = 0;

      override slice(begin?: number, end?: number): ArrayBuffer {
        this.copies += 1;
        return super.slice(begin, end);
      }
    }
    const data = new ObservableArrayBuffer(MAX_READ_IMAGE_BYTES + 1);
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data },
            mediaType: 'image/png',
          },
        ],
      },
      'session-1',
      () => {
        throw new Error('oversized bytes must not reach artifact planning');
      },
    );

    assert.equal(projection.kind, 'failure');
    assert.equal(data.copies, 0);
  });

  it('validates the complete projection before persisting any artifact', async () => {
    let writes = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      {
        type: 'content',
        value: [
          ...Array.from({ length: 64 }, (_, index) => ({
            type: 'text' as const,
            text: `part-${index}`,
          })),
          {
            type: 'file',
            data: { type: 'data' as const, data: Buffer.from('valid').toString('base64') },
            mediaType: 'image/png',
          },
        ],
      },
      'session-1',
      artifactPlanner(() => {
        writes += 1;
      }),
    );

    assert.equal(projection.kind, 'failure');
    assert.equal(writes, 0);
  });

  it('uses the exact planned artifact ref as the projection size authority', async () => {
    const ref = {
      kind: 'session_file' as const,
      sessionId: 'session-1',
      relativePath: 'artifact-1',
    };
    const emptyProjection = {
      version: 1 as const,
      kind: 'content' as const,
      parts: [
        { kind: 'text' as const, text: '' },
        { kind: 'artifact' as const, mediaType: 'image/png', ref },
      ],
    };
    const textLength =
      DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES - serializedByteLength(emptyProjection);
    let writes = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      {
        type: 'content',
        value: [
          { type: 'text', text: 'x'.repeat(textLength) },
          {
            type: 'file',
            data: { type: 'data', data: Buffer.from('valid').toString('base64') },
            mediaType: 'image/png',
          },
        ],
      },
      'session-1',
      () => ({
        ref,
        persist: async () => {
          writes += 1;
        },
      }),
    );

    assert.equal(projection.kind, 'content');
    assert.equal(writes, 1);
  });

  it('rejects unsafe image metadata before persisting it', async () => {
    let writes = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: Buffer.from('valid').toString('base64') },
            mediaType: 'image/png; token=sk-secret',
          },
        ],
      },
      'session-1',
      artifactPlanner(() => {
        writes += 1;
      }),
    );

    assert.equal(projection.kind, 'failure');
    assert.equal(writes, 0);
  });

  it('retracts already-published artifacts when a later one cannot be published', async () => {
    const published: string[] = [];
    const retracted: string[] = [];
    let nextId = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      twoInlineImages(),
      'session-1',
      () => {
        const relativePath = `artifact-${++nextId}`;
        return {
          ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath },
          persist: async () => {
            if (relativePath === 'artifact-2') throw new Error('artifact store is unavailable');
            published.push(relativePath);
          },
          retract: async () => {
            retracted.push(relativePath);
          },
        };
      },
    );

    assert.equal(projection.kind, 'failure');
    assert.deepEqual(published, ['artifact-1']);
    assert.deepEqual(retracted, ['artifact-1']);
  });

  it('still refuses the projection when the retraction itself fails', async () => {
    let nextId = 0;
    const projection = await encodeDurableToolResultOutputWithArtifacts(
      twoInlineImages(),
      'session-1',
      () => {
        const relativePath = `artifact-${++nextId}`;
        return {
          ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath },
          persist: async () => {
            if (relativePath === 'artifact-2') throw new Error('artifact store is unavailable');
          },
          // Reclamation may be delayed; admitting a partially published
          // projection may not happen at all.
          retract: async () => {
            throw new Error('cleanup is unavailable too');
          },
        };
      },
    );

    assert.equal(projection.kind, 'failure');
  });

  it('validates default image refs through the same closed schema', () => {
    const legacyImage = {
      kind: 'image',
      mimeType: 'image/png',
      ref: {
        kind: 'session_file',
        sessionId: 'session-1',
        relativePath: 'legacy/path.png',
      },
    } as const;
    assert.equal(encodeDefaultDurableToolResultOutput(legacyImage, 'session-1').kind, 'failure');
    assert.deepEqual(
      decodeEffectiveToolResultProjection(
        {
          kind: 'function_response',
          id: 'legacy-image-1',
          name: 'Read',
          result: legacyImage,
        },
        'session-1',
      ),
      { kind: 'legacy_output', output: legacyImage },
    );
  });
});

function twoInlineImages() {
  return {
    type: 'content' as const,
    value: [
      {
        type: 'file' as const,
        data: { type: 'data' as const, data: Buffer.from('first').toString('base64') },
        mediaType: 'image/png',
      },
      {
        type: 'file' as const,
        data: { type: 'data' as const, data: Buffer.from('second').toString('base64') },
        mediaType: 'image/png',
      },
    ],
  };
}

function artifactPlanner(onPersist: () => void) {
  let nextId = 0;
  return () => {
    const relativePath = `artifact-${++nextId}`;
    return {
      ref: { kind: 'session_file' as const, sessionId: 'session-1', relativePath },
      persist: async () => {
        onPersist();
      },
    };
  };
}
