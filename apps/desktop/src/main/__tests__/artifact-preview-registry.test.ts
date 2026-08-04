import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ArtifactBinaryReadResult } from '@maka/core';
import {
  ALLOWED_IMAGE_MIMES,
  IMAGE_PAYLOAD_MAX_BASE64_LENGTH,
  IMAGE_PAYLOAD_MAX_BYTES,
  decideImagePostLoad,
  decideImageReadOutcome,
  exceedsImagePayloadCap,
  formatPreviewSize,
  normalizeAllowedImageMime,
  resolvePreviewKind,
} from '@maka/ui/artifact-preview-registry';

describe('artifact preview registry', () => {
  it('resolves kinds, MIME metadata, and extension fallback from one decision table', () => {
    const cases: Array<{
      input: Parameters<typeof resolvePreviewKind>[0];
      expected: ReturnType<typeof resolvePreviewKind>;
    }> = [
      ...(['file', 'diff', 'html', 'pdf'] as const).map((kind) => ({
        input: { name: `artifact.${kind}`, kind },
        expected: { kind: 'unsupported' as const, reason: 'kind_disallowed' as const },
      })),
      ...[...ALLOWED_IMAGE_MIMES].map((mimeType) => ({
        input: { name: 'untitled', kind: 'image' as const, mimeType },
        expected: { kind: 'image' as const, reason: 'mime_match' as const },
      })),
      { input: { name: 'shot.png', kind: 'image', mimeType: ' IMAGE/PNG ' }, expected: { kind: 'image', reason: 'mime_match' } },
      ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].map((extension) => ({
        input: { name: `image.${extension}`, kind: 'image' as const },
        expected: { kind: 'image' as const, reason: 'ext_fallback' as const },
      })),
      { input: { name: 'image.JpEg', kind: 'image' }, expected: { kind: 'image', reason: 'ext_fallback' } },
      ...['untitled', 'photo.heic', '', 'shot.', '.hidden'].map((name) => ({
        input: { name, kind: 'image' as const },
        expected: { kind: 'unsupported' as const, reason: 'no_mime_no_ext' as const },
      })),
    ];

    for (const { input, expected } of cases) {
      assert.deepEqual(resolvePreviewKind(input), expected, JSON.stringify(input));
    }
  });

  it('treats present MIME metadata as authoritative and rejects unsafe formats', () => {
    for (const mimeType of ['image/svg+xml', 'image/heic', 'image/bmp']) {
      assert.deepEqual(
        resolvePreviewKind({ name: 'tricky.png', kind: 'image', mimeType }),
        { kind: 'unsupported', reason: 'mime_disallowed' },
      );
    }
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

  it('fails closed at the post-load payload cap', () => {
    assert.equal(exceedsImagePayloadCap('A'.repeat(IMAGE_PAYLOAD_MAX_BASE64_LENGTH)), false);
    assert.equal(exceedsImagePayloadCap('A'.repeat(IMAGE_PAYLOAD_MAX_BASE64_LENGTH + 1)), true);
    for (const value of [null, undefined, 42]) {
      assert.equal(exceedsImagePayloadCap(value as never), true);
    }
  });

  it('formats representative sizes and invalid metadata', () => {
    const cases: Array<[number | undefined, string]> = [
      [0, '0 B'],
      [1023, '1023 B'],
      [1024, '1.0 KB'],
      [IMAGE_PAYLOAD_MAX_BYTES, '2.0 MB'],
      [undefined, '未知大小'],
      [-1, '未知大小'],
      [NaN, '未知大小'],
      [Infinity, '未知大小'],
    ];
    for (const [size, expected] of cases) assert.equal(formatPreviewSize(size), expected);
  });

  it('normalizes only allowlisted image MIME values', () => {
    for (const mimeType of ALLOWED_IMAGE_MIMES) {
      assert.equal(normalizeAllowedImageMime(` ${mimeType.toUpperCase()} `), mimeType);
    }
    for (const mimeType of ['image/svg+xml', 'image/heic', 'application/octet-stream', '', '   ']) {
      assert.equal(normalizeAllowedImageMime(mimeType), null);
    }
    for (const value of [undefined, null, 42]) {
      assert.equal(normalizeAllowedImageMime(value as never), null);
    }
  });

  it('uses sniffed MIME and checks size before MIME after loading', () => {
    const base64 = 'AAAA';
    assert.deepEqual(decideImagePostLoad({ base64, mimeType: ' IMAGE/PNG ' }), {
      kind: 'image',
      safeMime: 'image/png',
      base64,
    });
    for (const mimeType of ['image/svg+xml', 'application/octet-stream']) {
      assert.deepEqual(decideImagePostLoad({ base64, mimeType }), {
        kind: 'unsupported',
        reason: 'mime_disallowed',
      });
    }
    assert.deepEqual(
      decideImagePostLoad({
        base64: 'A'.repeat(IMAGE_PAYLOAD_MAX_BASE64_LENGTH + 1),
        mimeType: 'image/svg+xml',
      }),
      { kind: 'unsupported', reason: 'oversize' },
    );
  });

  it('routes IPC failures and malformed successful payloads without retaining base64', () => {
    for (const reason of ['not_found', 'too_large', 'read_failed', 'not_allowed', 'deleted', 'unsupported_mime'] as const) {
      assert.deepEqual(decideImageReadOutcome({ ok: false, reason }), {
        kind: 'unsupported',
        reason: 'read_failed',
      });
    }

    const valid: ArtifactBinaryReadResult = { ok: true, base64: 'AAAA', mimeType: 'image/png' };
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
          base64: 'A'.repeat(IMAGE_PAYLOAD_MAX_BASE64_LENGTH + 1),
          mimeType: 'image/png',
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
