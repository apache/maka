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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  type AttachmentSnapshotInput,
  resolveAttachmentRefs,
  resolveIngestItems,
} from '../attachment-ingest.js';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';

describe('resolveIngestItems (pre-read validation)', () => {
  test('rejects more than 8 items before touching approvals or stat', async () => {
    const approvals = createAttachmentApprovalRegistry();
    let statCalls = 0;
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: Array.from({ length: 9 }, (_, i) => ({ approvalId: `bogus-${i}`, name: `f${i}` })),
          approvals,
          stat: async () => (statCalls++, { size: 1 }),
        }),
      /最多/,
    );
    assert.equal(statCalls, 0);
  });

  test('rejects an unapproved approvalId without stat-ing or reading the file', async () => {
    const approvals = createAttachmentApprovalRegistry();
    let statCalls = 0;
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: [{ approvalId: 'never-issued', name: 'a.txt' }],
          approvals,
          stat: async () => (statCalls++, { size: 1 }),
        }),
      /过期|无效/,
    );
    assert.equal(statCalls, 0);
  });

  test('rejects an approval issued to a different sender', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 1 }]);
    let statCalls = 0;
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 2,
          items: [{ approvalId: issued.approvalId, name: 'a.txt' }],
          approvals,
          stat: async () => (statCalls++, { size: 1 }),
        }),
      /过期|无效/,
    );
    assert.equal(statCalls, 0);
  });

  test('rejects an oversized path attachment after stat, before readFile or artifact create', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/big.bin', name: 'big.bin', size: 200 }]);
    let statCalls = 0;
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: [{ approvalId: issued.approvalId, name: 'big.bin' }],
          approvals,
          stat: async () => (statCalls++, { size: 200 }),
          maxBytes: 100,
        }),
      /超出大小限制/,
    );
    assert.equal(statCalls, 1);
  });

  test('rejects an oversized blob attachment before decoding it', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const oversized = Buffer.alloc(200).toString('base64');
    let statCalls = 0;
    let decodeCalls = 0;
    const realFrom = Buffer.from;
    Buffer.from = ((...args: unknown[]) => {
      decodeCalls += 1;
      return realFrom(args[0] as string, args[1] as BufferEncoding);
    }) as typeof Buffer.from;
    try {
      await assert.rejects(
        () =>
          resolveIngestItems({
            senderId: 1,
            items: [{ name: 'big.bin', base64: oversized }],
            approvals,
            stat: async () => (statCalls++, { size: 1 }),
            maxBytes: 100,
          }),
        /超出大小限制/,
      );
      assert.equal(statCalls, 0);
      assert.equal(decodeCalls, 0, 'must reject by base64 string length before Buffer.from');
    } finally {
      Buffer.from = realFrom;
    }
  });

  test('consumes each approval token exactly once', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 10 }]);
    const first = await resolveIngestItems({
      senderId: 1,
      items: [{ approvalId: issued.approvalId, name: 'a.txt' }],
      approvals,
      stat: async () => ({ size: 10 }),
    });
    assert.equal(first.length, 1);
    // token is one-shot: redeeming it again fails
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: [{ approvalId: issued.approvalId, name: 'a.txt' }],
          approvals,
          stat: async () => ({ size: 10 }),
        }),
      /过期|无效/,
    );
  });

  test('resolves a mix of approved paths and blobs into ingest files', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 10 }]);
    const blob = Buffer.from('hello');
    const files = await resolveIngestItems({
      senderId: 1,
      items: [
        { approvalId: issued.approvalId, name: 'a.txt' },
        { name: 'clip.png', mimeType: 'image/png', base64: blob.toString('base64') },
      ],
      approvals,
      stat: async () => ({ size: 10 }),
    });
    assert.equal(files.length, 2);
    assert.equal('path' in files[0], true);
    assert.equal('content' in files[1], true);
  });

  test('a later invalid item does not burn earlier approval tokens', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 10 }]);
    let statCalls = 0;
    await assert.rejects(
      resolveIngestItems({
        senderId: 1,
        items: [
          { approvalId: issued.approvalId, name: 'a.txt' },
          { wat: 'nope' },
        ],
        approvals,
        stat: async () => (statCalls++, { size: 10 }),
      }),
      /无效/,
    );
    assert.notEqual(
      approvals.consumeApproval(1, issued.approvalId),
      null,
      'earlier approval token must survive a later item failure so the user can retry',
    );
  });

  test('rejects a duplicate approvalId without consuming either token', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 10 }]);
    let statCalls = 0;
    await assert.rejects(
      resolveIngestItems({
        senderId: 1,
        items: [
          { approvalId: issued.approvalId, name: 'a.txt' },
          { approvalId: issued.approvalId, name: 'a.txt' },
        ],
        approvals,
        stat: async () => (statCalls++, { size: 10 }),
      }),
      /重复/,
    );
    assert.notEqual(
      approvals.consumeApproval(1, issued.approvalId),
      null,
      'a duplicate approvalId must be rejected before any token is consumed',
    );
  });

  test('rejects malformed items', async () => {
    const approvals = createAttachmentApprovalRegistry();
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: 'not-array',
          approvals,
          stat: async () => ({ size: 1 }),
        }),
      /无效/,
    );
    await assert.rejects(
      () =>
        resolveIngestItems({
          senderId: 1,
          items: [{ wat: 'nope' }],
          approvals,
          stat: async () => ({ size: 1 }),
        }),
      /无效/,
    );
  });
});

describe('resolveAttachmentRefs', () => {
  test('uses PDF magic bytes instead of a spoofed PNG extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-sniff-'));
    const path = join(dir, 'report.png');
    await writeFile(path, Buffer.from('%PDF-1.4\nfixture'));
    let resizeCalls = 0;
    let captured: AttachmentSnapshotInput | undefined;
    try {
      await resolveAttachmentRefs({
        files: [{ path, size: 16 }],
        resizeImage: async (bytes) => {
          resizeCalls += 1;
          return bytes;
        },
        snapshot: async (input) => {
          captured = input;
          return {
            kind: input.attachmentKind,
            name: input.name,
            mimeType: input.mimeType,
            bytes: input.content.byteLength,
            ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
          };
        },
      });
      assert.equal(resizeCalls, 0);
      assert.equal(captured?.mimeType, 'application/pdf');
      assert.equal(captured?.attachmentKind, 'pdf');
      assert.equal(captured?.artifactKind, 'pdf');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses PNG magic bytes instead of conflicting renderer metadata', async () => {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let resizeCalls = 0;
    let captured: AttachmentSnapshotInput | undefined;

    await resolveAttachmentRefs({
      files: [{ name: 'report.pdf', mimeType: 'application/pdf', size: content.byteLength, content }],
      resizeImage: async (bytes) => {
        resizeCalls += 1;
        return bytes;
      },
      snapshot: async (input) => {
        captured = input;
        return {
          kind: input.attachmentKind,
          name: input.name,
          mimeType: input.mimeType,
          bytes: input.content.byteLength,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
        };
      },
    });

    assert.equal(resizeCalls, 1);
    assert.equal(captured?.mimeType, 'image/png');
    assert.equal(captured?.attachmentKind, 'image');
    assert.equal(captured?.artifactKind, 'image');
  });

  test('recognises an image with no extension from its bytes', async () => {
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    let captured: AttachmentSnapshotInput | undefined;

    await resolveAttachmentRefs({
      files: [{ name: 'clipboard-image', size: content.byteLength, content }],
      snapshot: async (input) => {
        captured = input;
        return {
          kind: input.attachmentKind,
          name: input.name,
          mimeType: input.mimeType,
          bytes: input.content.byteLength,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
        };
      },
    });

    assert.equal(captured?.mimeType, 'image/jpeg');
    assert.equal(captured?.attachmentKind, 'image');
  });

  test('updates the MIME when image resizing changes the encoded format', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const resizedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let captured: AttachmentSnapshotInput | undefined;

    await resolveAttachmentRefs({
      files: [{ name: 'photo.jpg', size: jpeg.byteLength, content: jpeg }],
      resizeImage: async () => resizedPng,
      snapshot: async (input) => {
        captured = input;
        return {
          kind: input.attachmentKind,
          name: input.name,
          mimeType: input.mimeType,
          bytes: input.content.byteLength,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
        };
      },
    });

    assert.equal(captured?.mimeType, 'image/png');
    assert.deepEqual(captured?.content, resizedPng);
  });

  test('does not decode unknown bytes merely because the renderer calls them an image', async () => {
    const content = Buffer.from('not an image');
    let resizeCalls = 0;
    let captured: AttachmentSnapshotInput | undefined;

    await resolveAttachmentRefs({
      files: [{ name: 'payload.svg', mimeType: 'image/svg+xml', size: content.byteLength, content }],
      resizeImage: async (bytes) => {
        resizeCalls += 1;
        return bytes;
      },
      snapshot: async (input) => {
        captured = input;
        return {
          kind: input.attachmentKind,
          name: input.name,
          mimeType: input.mimeType,
          bytes: input.content.byteLength,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
        };
      },
    });

    assert.equal(resizeCalls, 0);
    assert.equal(captured?.mimeType, 'application/octet-stream');
    assert.equal(captured?.attachmentKind, 'other');
    assert.equal(captured?.artifactKind, 'file');
  });

  test('rejects a path grown beyond the cap before creating a Host artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-cap-'));
    const path = join(dir, 'grew.bin');
    await writeFile(path, Buffer.alloc(11));
    let snapshots = 0;
    try {
      await assert.rejects(
        resolveAttachmentRefs({
          files: [{ path, mimeType: 'application/octet-stream', size: 5 }],
          maxBytes: 10,
          snapshot: async () => {
            snapshots += 1;
            throw new Error('snapshot must not run');
          },
        }),
        /超出大小限制/,
      );
      assert.equal(snapshots, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
