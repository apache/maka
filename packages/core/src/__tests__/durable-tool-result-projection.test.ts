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

import {
  decodeDurableToolResultProjection,
  DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES,
  DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_DEPTH,
  DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_NODES,
} from '../durable-tool-result-projection.js';

describe('durable Tool Result projection', () => {
  it('accepts only the closed current-version schema', () => {
    const projection = { version: 1, kind: 'text', text: 'safe' } as const;

    assert.deepEqual(decodeDurableToolResultProjection(projection), projection);
    assert.throws(
      () => decodeDurableToolResultProjection({ ...projection, version: 2 }),
      /Invalid durable Tool Result projection/,
    );
    assert.throws(
      () => decodeDurableToolResultProjection({ ...projection, providerOptions: {} }),
      /Invalid durable Tool Result projection/,
    );
    assert.throws(
      () =>
        decodeDurableToolResultProjection({
          version: 1,
          kind: 'content',
          parts: [],
        }),
      /Invalid durable Tool Result projection/,
    );
  });

  it('rejects projections whose serialized JSON exceeds the durable byte bound', () => {
    assert.throws(
      () =>
        decodeDurableToolResultProjection({
          version: 1,
          kind: 'text',
          text: 'x'.repeat(DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES),
        }),
      /Invalid durable Tool Result projection/,
    );
  });

  it('accepts only content-addressed references owned by the same Session protocol', () => {
    assert.deepEqual(
      decodeDurableToolResultProjection({
        version: 1,
        kind: 'content',
        parts: [
          {
            kind: 'artifact',
            mediaType: 'image/png',
            ref: { kind: 'session_context', sessionId: 'session-1', refId: 'sha256-image' },
          },
        ],
      }).kind,
      'content',
    );
    assert.throws(
      () =>
        decodeDurableToolResultProjection({
          version: 1,
          kind: 'content',
          parts: [
            {
              kind: 'artifact',
              mediaType: 'image/png',
              ref: { kind: 'external_file', absolutePath: '/private/image.png' },
            },
          ],
        }),
      /Invalid durable Tool Result projection/,
    );
    assert.throws(
      () =>
        decodeDurableToolResultProjection({
          version: 1,
          kind: 'content',
          parts: [
            {
              kind: 'artifact',
              mediaType: 'image/png',
              ref: {
                kind: 'session_file',
                sessionId: 'session-1',
                relativePath: 'arbitrary/path.png',
              },
            },
          ],
        }),
      /Invalid durable Tool Result projection/,
    );
  });

  it('admits only canonical safe image media types', () => {
    const projection = (mediaType: string) => ({
      version: 1,
      kind: 'content',
      parts: [
        {
          kind: 'artifact',
          mediaType,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
        },
      ],
    });

    assert.equal(decodeDurableToolResultProjection(projection('image/png')).kind, 'content');
    assert.throws(
      () => decodeDurableToolResultProjection(projection('image/png; token=sk-secret')),
      /Invalid durable Tool Result projection/,
    );
    assert.throws(
      () => decodeDurableToolResultProjection(projection('image/svg+xml')),
      /Invalid durable Tool Result projection/,
    );
  });

  it('applies the same bounded JSON budget to persisted projections', () => {
    let tooDeep: unknown = 'leaf';
    for (let depth = 0; depth <= DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_DEPTH; depth += 1) {
      tooDeep = [tooDeep];
    }
    assert.throws(
      () => decodeDurableToolResultProjection({ version: 1, kind: 'json', value: tooDeep }),
      /Invalid durable Tool Result projection/,
    );
    assert.throws(
      () =>
        decodeDurableToolResultProjection({
          version: 1,
          kind: 'json',
          value: Array.from({ length: DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_NODES }, () => null),
        }),
      /Invalid durable Tool Result projection/,
    );
  });
});
