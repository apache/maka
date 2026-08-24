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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ArtifactBinaryReadResult } from '@maka/core/artifacts';
import {
  IMAGE_PAYLOAD_MAX_BYTES,
  decideImageReadOutcome,
  resolvePreviewKind,
} from '@maka/ui/artifact-preview-registry';

describe('artifact preview registry', () => {
  it('treats present MIME metadata as authoritative and rejects unsafe formats', () => {
    assert.deepEqual(
      resolvePreviewKind({ name: 'tricky.png', kind: 'image', mimeType: 'image/svg+xml' }),
      { kind: 'unsupported', reason: 'mime_disallowed' },
    );
  });

  it('enforces the inclusive metadata size boundary before loading', () => {
    const base = { name: 'image.png', kind: 'image' as const, mimeType: 'image/png' };
    assert.deepEqual(resolvePreviewKind({ ...base, sizeBytes: IMAGE_PAYLOAD_MAX_BYTES }), {
      kind: 'image',
      reason: 'mime_match',
    });
    assert.deepEqual(resolvePreviewKind({ ...base, sizeBytes: IMAGE_PAYLOAD_MAX_BYTES + 1 }), {
      kind: 'unsupported',
      reason: 'oversize',
    });
  });

  it('routes IPC failures and malformed successful payloads without retaining base64', () => {
    assert.deepEqual(decideImageReadOutcome({ ok: false, reason: 'not_found' }), {
      kind: 'unsupported',
      reason: 'read_failed',
    });

    const valid: ArtifactBinaryReadResult = { ok: true, base64: 'AAAA', mimeType: ' IMAGE/PNG ' };
    assert.deepEqual(decideImageReadOutcome(valid), {
      kind: 'image',
      safeMime: 'image/png',
      base64: 'AAAA',
    });

    const malformed = [
      { ok: true, mimeType: 'image/png' },
      { ok: true, base64: 'AAAA' },
    ] as unknown as ArtifactBinaryReadResult[];
    for (const result of malformed) {
      assert.deepEqual(decideImageReadOutcome(result), { kind: 'unsupported', reason: 'read_failed' });
    }

    const rejected: Array<[ArtifactBinaryReadResult, 'oversize' | 'mime_disallowed']> = [
      [
        {
          ok: true,
          base64: 'A'.repeat(3 * 1024 * 1024),
          mimeType: 'image/svg+xml',
        },
        'oversize',
      ],
      [{ ok: true, base64: 'AAAA', mimeType: 'image/svg+xml' }, 'mime_disallowed'],
    ];
    for (const [result, reason] of rejected) {
      const outcome = decideImageReadOutcome(result);
      assert.deepEqual(outcome, { kind: 'unsupported', reason });
      assert.equal('base64' in outcome, false);
    }
  });
});
