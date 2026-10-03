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
import { test } from 'node:test';
import type { AttachmentRef } from '@maka/core/events';
import type { ModelAdapter } from '../model-adapter.js';
import type { ProviderAttachmentBudget } from '../ai-sdk-compaction.js';
import { AiSdkMessageProjection } from '../ai-sdk-message-projection.js';

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf: AttachmentRef = {
  kind: 'pdf',
  name: 'brief.pdf',
  mimeType: 'application/pdf',
  bytes: pdfBytes.length,
  ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'brief' },
};

function budget(): ProviderAttachmentBudget {
  return {
    used: { image: 0, pdf: 0, total: 0 },
    decisions: new Map(),
    invalidMediaTypes: new Map(),
  };
}

function projection(input: Partial<ConstructorParameters<typeof AiSdkMessageProjection>[0]>) {
  return new AiSdkMessageProjection({
    modelAdapter: {} as ModelAdapter,
    applyPatchProfile: null,
    ...input,
  });
}

test('authorized PDF materializes as a named file and consumes actual bytes', async () => {
  const currentBudget = budget();
  const content = await projection({
    supportsNativePdfInput: true,
    readAttachmentBytes: async () => ({ ok: true, bytes: pdfBytes }),
  }).appendAttachmentParts(currentBudget, 'inspect', [pdf], 'runtime-event:1');
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[1], {
    type: 'file',
    data: { type: 'data', data: pdfBytes },
    mediaType: 'application/pdf',
    filename: 'brief.pdf',
  });
  assert.deepEqual(currentBudget.used, { image: 0, pdf: pdfBytes.length, total: pdfBytes.length });
});

test('unsupported PDF routes never read durable bytes', async () => {
  let reads = 0;
  const content = await projection({
    readAttachmentBytes: async () => {
      reads += 1;
      return { ok: true, bytes: pdfBytes, mimeType: 'application/pdf' };
    },
  }).appendAttachmentParts(budget(), 'inspect', [pdf], 'runtime-event:1');
  assert.equal(content, 'inspect');
  assert.equal(reads, 0);
});

test('declared image with PDF bytes cannot bypass the PDF gate', async () => {
  const image = { ...pdf, kind: 'image' as const, name: 'brief.png', mimeType: 'image/png' };
  const currentBudget = budget();
  const content = await projection({
    supportsVision: true,
    supportsNativePdfInput: false,
    readAttachmentBytes: async () => ({ ok: true, bytes: pdfBytes }),
  }).appendAttachmentParts(currentBudget, 'inspect', [image], 'runtime-event:1');
  assert.ok(Array.isArray(content));
  assert.equal(
    content.some((part) => part.type === 'file'),
    false,
  );
  assert.equal(currentBudget.used.total, 0);
});

test('declared PDF with image bytes is omitted locally', async () => {
  const content = await projection({
    supportsNativePdfInput: true,
    readAttachmentBytes: async () => ({ ok: true, bytes: pngBytes, mimeType: 'image/png' }),
  }).appendAttachmentParts(budget(), 'inspect', [pdf], 'runtime-event:1');
  assert.ok(Array.isArray(content));
  assert.equal(
    content.some((part) => part.type === 'file'),
    false,
  );
});

test('a PDF without a verified loaded MIME is omitted and not reread on the next step', async () => {
  let reads = 0;
  const project = projection({
    supportsNativePdfInput: true,
    readAttachmentBytes: async () => {
      reads += 1;
      return { ok: true, bytes: new Uint8Array([1, 2, 3]) };
    },
  });
  const currentBudget = budget();
  for (let step = 0; step < 2; step += 1) {
    const content = await project.appendAttachmentParts(
      currentBudget,
      'inspect',
      [pdf],
      'runtime-event:1',
    );
    assert.ok(Array.isArray(content));
    assert.equal(
      content.some((part) => part.type === 'file'),
      false,
    );
    assert.match(
      content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
      /unknown/,
    );
  }
  assert.equal(reads, 1);
  assert.equal(currentBudget.used.total, 0);
});

test('a throwing PDF reader degrades to a read failure without charging bytes', async () => {
  const currentBudget = budget();
  const content = await projection({
    supportsNativePdfInput: true,
    readAttachmentBytes: async () => {
      throw new Error('private storage detail');
    },
  }).appendAttachmentParts(currentBudget, 'inspect', [pdf], 'runtime-event:1');
  assert.ok(Array.isArray(content));
  assert.equal(
    content.some((part) => part.type === 'file'),
    false,
  );
  assert.match(
    content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
    /read_failed/,
  );
  assert.equal(currentBudget.used.total, 0);
});

test('cached budget omissions skip later durable reads', async () => {
  let reads = 0;
  const project = projection({
    supportsNativePdfInput: true,
    maxProviderPdfRequestBytes: 4,
    readAttachmentBytes: async () => {
      reads += 1;
      return { ok: true, bytes: pdfBytes, mimeType: 'application/pdf' };
    },
  });
  const currentBudget = budget();
  for (let step = 0; step < 3; step += 1) {
    const content = await project.appendAttachmentParts(
      currentBudget,
      'inspect',
      [pdf],
      'runtime-event:1',
    );
    assert.ok(Array.isArray(content));
    assert.equal(
      content.some((part) => part.type === 'file'),
      false,
    );
  }
  assert.equal(reads, 1);
  assert.equal(currentBudget.used.total, 0);
});

test('image and PDF share one binary request ceiling', async () => {
  const image: AttachmentRef = {
    ...pdf,
    kind: 'image',
    name: 'photo.png',
    mimeType: 'image/png',
    ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'photo' },
  };
  const currentBudget = budget();
  const content = await projection({
    supportsVision: true,
    supportsNativePdfInput: true,
    maxProviderBinaryRequestBytes: 12,
    readAttachmentBytes: async (ref) => ({
      ok: true,
      bytes: ref.kind === 'session_file' && ref.relativePath === 'photo' ? pngBytes : pdfBytes,
      mimeType:
        ref.kind === 'session_file' && ref.relativePath === 'photo'
          ? 'image/png'
          : 'application/pdf',
    }),
  }).appendAttachmentParts(currentBudget, 'inspect', [image, pdf], 'runtime-event:1');
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((part) => part.type === 'file').length, 1);
  assert.deepEqual(currentBudget.used, { image: 8, pdf: 0, total: 8 });
});
