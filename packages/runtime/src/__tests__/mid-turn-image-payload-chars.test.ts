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
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';
import { midTurnRequestPayloadChars } from '../ai-sdk-compaction.js';
import { estimateNextRequestTokens } from '../history-compaction.js';
import { toolSchemaCharsForDiagnostics } from '../request-shape.js';
import type { ModelMessage } from '../model-protocol.js';

/**
 * The unknown-model `policy_fallback` capacity: `maxHistoryEstimatedTokens`
 * (32_000) + mid-turn `reserveTokens` (16_384). See context-budget-policy.ts
 * and context-budget-mid-turn-policy.test.ts. This is the capacity the step-0
 * verdict measures the first request against when the selected model has no
 * known context window — the exact scenario in apache/maka#4290.
 */
const POLICY_FALLBACK_CAPACITY_TOKENS = 48_384;
const CHARS_PER_TOKEN = 4;
/** Mirrors IMAGE_PART_ESTIMATED_TOKENS in ai-sdk-compaction.ts. */
const IMAGE_PART_ESTIMATED_TOKENS = 1_600;

function bytes(size: number): Uint8Array {
  // 0x89 alone is NOT a full image signature (PNG needs 0x89 0x50 0x4e 0x47),
  // so a `bytes()`-filled part is classified as an image only via its declared
  // mediaType — never by magic-byte sniffing. Content scales with `size`; the
  // estimate must not.
  return new Uint8Array(size).fill(0x89);
}

/** Bytes that begin with the real PNG signature, so magic-byte sniffing fires. */
function pngBytes(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(8, size)).fill(0);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
}

/** Bytes that begin with the `%PDF` signature — a genuine non-image document. */
function pdfBytes(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(4, size)).fill(0);
  out.set([0x25, 0x50, 0x44, 0x46]);
  return out;
}

/**
 * A first-turn user message: short prompt + one inline image attachment. The
 * `data` payload type varies by source — a session-file upload arrives as a
 * Node Buffer, a workspace/computer-use image as a Uint8Array (ai-sdk-backend).
 */
function userImageMessage(imageBytes: Uint8Array | Buffer): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图包含什么内容' },
      {
        type: 'file',
        data: { type: 'data', data: imageBytes },
        mediaType: 'image/png',
      },
    ],
  } as unknown as ModelMessage;
}

/** A tool-result image, materialized as an inline base64 string (ai-sdk-backend). */
function toolResultImageMessage(imageBase64: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'read_image',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'Image read successfully.' },
            {
              type: 'file',
              data: { type: 'data', data: imageBase64 },
              mediaType: 'image/png',
            },
          ],
        },
      },
    ],
  } as unknown as ModelMessage;
}

/** A single-part user message carrying a `file` part of the given media type. */
function fileMessage(mediaType: string, data: Uint8Array | Buffer | string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'file', data: { type: 'data', data }, mediaType }],
  } as unknown as ModelMessage;
}

/**
 * A `file` part whose `data` carries a `data:` URL — as a bare `URL` instance
 * (`data: new URL(...)`) or a tagged `{ type: 'url', url }`, the two shapes the
 * AI SDK unpacks and re-sniffs. Declared mediaType stays generic so only the
 * decoded bytes can prove it is an image.
 */
function fileDataUrlMessage(
  mediaType: string,
  data: URL | { type: 'url'; url: string | URL },
): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'file', data, mediaType }],
  } as unknown as ModelMessage;
}

/** A single-part user message carrying an `image` part with the given payload. */
function imagePartMessage(image: unknown): ModelMessage {
  return { role: 'user', content: [{ type: 'image', image }] } as unknown as ModelMessage;
}

function coldStartTokens(payloadChars: number, charsPerToken = CHARS_PER_TOKEN): number {
  return estimateNextRequestTokens({
    appendedChars: 0,
    coldStartChars: payloadChars,
    charsPerToken,
  });
}

describe('midTurnRequestPayloadChars image accounting (apache/maka#4290)', () => {
  test('a first-turn user upload (session_file Buffer) estimates under the fallback capacity', () => {
    // The reported production path: a Desktop upload is read as a Node Buffer
    // (artifact-attachments.ts) and inlined into the request. JSON.stringify
    // turns a Buffer into a {"type":"Buffer","data":[...]} digit map via its
    // toJSON, so a raw estimate blows past the window on step 0. The fix must
    // discount it structurally (Buffer is a Uint8Array before serialization).
    const messages = [userImageMessage(Buffer.from(bytes(200_000)))];
    const payloadChars = midTurnRequestPayloadChars(messages, [], [], 4_000);
    assert.ok(
      coldStartTokens(payloadChars) < POLICY_FALLBACK_CAPACITY_TOKENS,
      `a Buffer upload + short prompt must fit the fallback capacity, got ~${coldStartTokens(payloadChars)} tokens`,
    );
    // The pre-fix accounting (raw serialization of the same messages) would
    // have exceeded the window — this is what killed the turn on step 0.
    assert.ok(
      Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN) >
        POLICY_FALLBACK_CAPACITY_TOKENS,
    );
  });

  test('a Uint8Array image (workspace / computer-use path) also fits the fallback capacity', () => {
    const payloadChars = midTurnRequestPayloadChars(
      [userImageMessage(bytes(200_000))],
      [],
      [],
      4_000,
    );
    assert.ok(coldStartTokens(payloadChars) < POLICY_FALLBACK_CAPACITY_TOKENS);
  });

  test('the estimate does not scale with image byte size (Buffer, Uint8Array, base64)', () => {
    const buf = (n: number) =>
      midTurnRequestPayloadChars([userImageMessage(Buffer.from(bytes(n)))], [], [], 0);
    const u8 = (n: number) => midTurnRequestPayloadChars([userImageMessage(bytes(n))], [], [], 0);
    const b64 = (n: number) =>
      midTurnRequestPayloadChars(
        [toolResultImageMessage(Buffer.from(bytes(n)).toString('base64'))],
        [],
        [],
        0,
      );
    // A 100x larger image must not change the estimate on any inline-binary
    // representation: the provider bills the rendered image, not the bytes.
    assert.equal(buf(20_000), buf(2_000_000));
    assert.equal(u8(20_000), u8(2_000_000));
    assert.equal(b64(20_000), b64(2_000_000));
  });

  test('a non-image file (e.g. PDF) is NOT discounted — it stays fully measured', () => {
    // The per-image cost applies only to images; a PDF/text/audio file part
    // carries content the provider really bills, so it must keep full
    // measurement rather than collapse to the ~1.6K-token image estimate.
    const pdf = (n: number) =>
      midTurnRequestPayloadChars(
        [fileMessage('application/pdf', Buffer.from(pdfBytes(n)))],
        [],
        [],
        0,
      );
    assert.notEqual(pdf(1_000), pdf(200_000));
    assert.ok(
      pdf(200_000) > 200_000,
      `an inline non-image file must be counted in full, got ${pdf(200_000)} chars`,
    );
  });

  test('a bare "image" top-level mediaType is discounted (AI SDK deprecates image parts for it)', () => {
    // The AI SDK's recommended replacement for an image part is a file part
    // with mediaType `image` (top-level, no subtype). `startsWith('image/')`
    // misses it; the estimate must still treat it as an image.
    const img = (n: number) =>
      midTurnRequestPayloadChars([fileMessage('image', Buffer.from(pngBytes(n)))], [], [], 0);
    assert.equal(img(20_000), img(2_000_000));
    assert.ok(
      coldStartTokens(
        midTurnRequestPayloadChars(
          [fileMessage('image', Buffer.from(pngBytes(200_000)))],
          [],
          [],
          4_000,
        ),
      ) < POLICY_FALLBACK_CAPACITY_TOKENS,
    );
  });

  test('a generic-MIME file with image bytes is discounted (magic-byte parity with the SDK)', () => {
    // The AI SDK detects the image from the byte signature and overrides the
    // declared mediaType, so the provider bills it as an image. The estimate
    // must match, or a mislabelled screenshot trips the pre-send verdict.
    const img = (n: number) =>
      midTurnRequestPayloadChars(
        [fileMessage('application/octet-stream', Buffer.from(pngBytes(n)))],
        [],
        [],
        0,
      );
    assert.equal(img(20_000), img(2_000_000));
    assert.ok(
      coldStartTokens(
        midTurnRequestPayloadChars(
          [fileMessage('application/octet-stream', Buffer.from(pngBytes(200_000)))],
          [],
          [],
          4_000,
        ),
      ) < POLICY_FALLBACK_CAPACITY_TOKENS,
    );
  });

  test('a generic-MIME file whose data: URL decodes to image bytes is discounted', () => {
    // The reachable production combination the Buffer test above misses: a
    // `file` part with a generic declared mediaType whose `data` is a `data:`
    // URL carrying image bytes. The AI SDK splits the data URL, decodes its
    // base64 body, and re-sniffs — reclassifying it to image/png and billing it
    // as an image. The estimate must decode+sniff the SAME way, across both
    // carrier shapes (bare `URL` and tagged `{ type: 'url', url }`), or a
    // ~200 KB screenshot passed this way trips the step-0 verdict
    // (apache/maka#4290).
    const dataUrl = (n: number) =>
      `data:application/octet-stream;base64,${Buffer.from(pngBytes(n)).toString('base64')}`;
    const asBareUrl = (n: number) =>
      midTurnRequestPayloadChars(
        [fileDataUrlMessage('application/octet-stream', new URL(dataUrl(n)))],
        [],
        [],
        0,
      );
    const asTaggedUrl = (n: number) =>
      midTurnRequestPayloadChars(
        [fileDataUrlMessage('application/octet-stream', { type: 'url', url: dataUrl(n) })],
        [],
        [],
        0,
      );
    // The estimate must not scale with byte size on either carrier shape.
    assert.equal(asBareUrl(20_000), asBareUrl(2_000_000));
    assert.equal(asTaggedUrl(20_000), asTaggedUrl(2_000_000));
    // And a 200 KB image passed this way must fit the fallback capacity, not
    // trip the pre-send verdict as it did before the data-URL sniff.
    assert.ok(
      coldStartTokens(
        midTurnRequestPayloadChars(
          [fileDataUrlMessage('application/octet-stream', new URL(dataUrl(200_000)))],
          [],
          [],
          4_000,
        ),
      ) < POLICY_FALLBACK_CAPACITY_TOKENS,
    );
    assert.ok(
      coldStartTokens(
        midTurnRequestPayloadChars(
          [fileDataUrlMessage('application/octet-stream', { type: 'url', url: dataUrl(200_000) })],
          [],
          [],
          4_000,
        ),
      ) < POLICY_FALLBACK_CAPACITY_TOKENS,
    );
  });

  test('a generic-MIME file whose data: URL is NOT an image stays fully measured', () => {
    // Precision guard, matching the SDK: the byte override fires only for image
    // signatures. A PDF carried as a generic-MIME data: URL must keep full
    // measurement, never collapse to the per-image estimate.
    const pdfDataUrl = (n: number) =>
      new URL(
        `data:application/octet-stream;base64,${Buffer.from(pdfBytes(n)).toString('base64')}`,
      );
    const pdf = (n: number) =>
      midTurnRequestPayloadChars(
        [fileDataUrlMessage('application/octet-stream', pdfDataUrl(n))],
        [],
        [],
        0,
      );
    assert.notEqual(pdf(1_000), pdf(200_000));
  });

  test('a remote-URL image still costs the per-image budget (no under-count)', () => {
    // An http(s) URL / provider reference has no inline bytes to strip, but it
    // is still an image the provider fetches and bills — it must carry the
    // per-image token cost, or a URL image would be estimated at ~zero.
    const at = (cpt: number) =>
      midTurnRequestPayloadChars(
        [imagePartMessage({ type: 'url', url: new URL('https://example.com/chart.png') })],
        [],
        [],
        0,
        cpt,
      );
    assert.equal(at(4) - at(1), IMAGE_PART_ESTIMATED_TOKENS * (4 - 1));
  });

  test('a bare remote-URL string image is left verbatim, not blanked', () => {
    // A parseable bare string is a URL to the SDK; blanking it would drop a
    // long signed URL from the count. It stays verbatim (and still costs the
    // per-image budget). A data: URL string, by contrast, is inline bytes.
    const url = `https://example.com/${'a'.repeat(2_000)}.png`;
    const payloadChars = midTurnRequestPayloadChars([imagePartMessage(url)], [], [], 0);
    assert.ok(
      payloadChars >= url.length,
      `a remote URL string must be counted, not blanked, got ${payloadChars} chars`,
    );
  });

  test('a data: URL image is stripped, not counted at full base64', () => {
    // AI SDK treats a data: URL as inline data. Whether it arrives as a string
    // or a URL instance, its bytes must not drive the estimate — otherwise a
    // ~200 KB data: URL would still trip the pre-send verdict (apache/maka#4290).
    const dataUrl = (n: number) =>
      `data:image/png;base64,${Buffer.from(bytes(n)).toString('base64')}`;
    const asString = (n: number) =>
      midTurnRequestPayloadChars([imagePartMessage(dataUrl(n))], [], [], 0);
    const asUrl = (n: number) =>
      midTurnRequestPayloadChars([imagePartMessage(new URL(dataUrl(n)))], [], [], 0);
    assert.equal(asString(20_000), asString(2_000_000));
    assert.equal(asUrl(20_000), asUrl(2_000_000));
    assert.ok(
      coldStartTokens(
        midTurnRequestPayloadChars([imagePartMessage(dataUrl(200_000))], [], [], 4_000),
      ) < POLICY_FALLBACK_CAPACITY_TOKENS,
    );
  });

  test('a non-image {type:"data"} payload (e.g. a tool-call input) is NOT discounted', () => {
    // Precision guard: the discount must apply only to genuine image/file
    // parts, never to arbitrary content that happens to look like a data
    // wrapper — else a large tool-call input would silently skip the budget.
    const bigInput = 'x'.repeat(300_000);
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'run',
            input: { type: 'data', data: bigInput },
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const payloadChars = midTurnRequestPayloadChars(messages, [], [], 0);
    assert.ok(
      payloadChars >= bigInput.length,
      `a non-image data payload must be counted in full, got ${payloadChars} chars`,
    );
  });

  test('the per-image cost scales with the configured charsPerToken', () => {
    // The image is billed at a fixed TOKEN budget, so its CHAR cost must track
    // charsPerToken (the caller divides the payload back down by it). With one
    // image the only charsPerToken-dependent term is that per-image cost.
    const at = (cpt: number) =>
      midTurnRequestPayloadChars([userImageMessage(bytes(50_000))], [], [], 0, cpt);
    assert.equal(at(4) - at(1), IMAGE_PART_ESTIMATED_TOKENS * (4 - 1));
    assert.equal(at(8) - at(4), IMAGE_PART_ESTIMATED_TOKENS * (8 - 4));
  });

  test('images add a bounded, linear per-part cost', () => {
    const one = midTurnRequestPayloadChars([userImageMessage(bytes(50_000))], [], [], 0);
    const two = midTurnRequestPayloadChars(
      [userImageMessage(bytes(50_000)), userImageMessage(bytes(50_000))],
      [],
      [],
      0,
    );
    const perImageDelta = two - one;
    assert.ok(perImageDelta > 0, 'a second image must add cost');
    assert.ok(
      perImageDelta < IMAGE_PART_ESTIMATED_TOKENS * CHARS_PER_TOKEN + 2_000,
      `per-image marginal cost must stay bounded, got ${perImageDelta} chars`,
    );
  });

  test('text-only messages are unchanged (no image discount, no regression)', () => {
    const messages = [
      { role: 'user', content: 'plain text, no attachments' },
      { role: 'assistant', content: [{ type: 'text', text: 'a reply' }] },
    ] as unknown as ModelMessage[];
    const systemPromptChars = 1_234;
    // With no images the messages term must equal the original definition
    // (`JSON.stringify(messages).length`); system-prompt and tool-schema terms
    // are unchanged by this fix.
    assert.equal(
      midTurnRequestPayloadChars(messages, [], [], systemPromptChars),
      systemPromptChars + JSON.stringify(messages).length + toolSchemaCharsForDiagnostics([], []),
    );
  });
});
