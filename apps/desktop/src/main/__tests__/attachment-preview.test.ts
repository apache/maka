import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import {
  loadApprovalPreview,
  registerAttachmentPreviewIpc,
  type AttachmentPreviewResult,
} from '../attachment-preview.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeRenderPreview(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  return Promise.resolve({ bytes, mimeType: 'image/png' });
}

describe('staged attachment preview (approval source)', () => {
  it('returns thumbnail bytes for an approved image without consuming the approval', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [
      { path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png', size: PNG.byteLength },
    ]);
    let readCap = -1;
    const result = await loadApprovalPreview({
      senderId: 1,
      approvalId: issued.approvalId,
      approvals,
      readFile: async (_path, maxBytes) => {
        readCap = maxBytes;
        return PNG;
      },
      renderPreview: fakeRenderPreview,
    });
    assert.deepEqual(result, {
      ok: true,
      base64: Buffer.from(PNG).toString('base64'),
      mimeType: 'image/png',
    });
    // The read allocates by the approval's own stat size, never the global
    // 50MB cap — a staged batch must not multiply flat 50MB buffers.
    assert.equal(readCap, PNG.byteLength);
    // The send must still be able to redeem the token afterwards.
    assert.ok(approvals.consumeApproval(1, issued.approvalId));
  });

  it('refuses an approval whose stat size exceeds the cap without reading', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [
      { path: '/tmp/huge.png', name: 'huge.png', mimeType: 'image/png', size: 100 },
    ]);
    let read = 0;
    const result = await loadApprovalPreview({
      senderId: 1,
      approvalId: issued.approvalId,
      approvals,
      maxBytes: 99,
      readFile: async () => {
        read += 1;
        return PNG;
      },
      renderPreview: fakeRenderPreview,
    });
    assert.deepEqual(result, { ok: false, reason: 'unreadable' });
    assert.equal(read, 0);
  });

  it('refuses non-image approvals without touching the file', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/notes.md', name: 'notes.md', size: 4 }]);
    let read = 0;
    const result = await loadApprovalPreview({
      senderId: 1,
      approvalId: issued.approvalId,
      approvals,
      readFile: async () => {
        read += 1;
        return PNG;
      },
      renderPreview: fakeRenderPreview,
    });
    assert.deepEqual(result, { ok: false, reason: 'not_image' });
    assert.equal(read, 0);
  });

  it('registers the client-owned attachment preview IPC boundary', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(7, [
      { path: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png', size: PNG.byteLength },
    ]);
    const handlers = new Map<
      string,
      (event: { sender: { id: number } }, approvalId: unknown) => Promise<AttachmentPreviewResult>
    >();
    registerAttachmentPreviewIpc({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      approvals,
      readFile: async () => PNG,
      renderPreview: fakeRenderPreview,
    });
    const handler = handlers.get('attachments:previewApproval');
    assert.ok(handler, 'handler registered on the expected channel');
    const result = await handler({ sender: { id: 7 } }, issued.approvalId);
    assert.equal(result.ok, true);
    const foreign = await handler({ sender: { id: 8 } }, issued.approvalId);
    assert.deepEqual(foreign, { ok: false, reason: 'not_found' });
  });

  it('rejects unknown, foreign-sender, and malformed approval ids', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/shot.png', name: 'shot.png', size: 4 }]);
    const deps = { approvals, readFile: async () => PNG, renderPreview: fakeRenderPreview };
    assert.deepEqual(
      await loadApprovalPreview({ senderId: 1, approvalId: 42, ...deps }),
      { ok: false, reason: 'invalid' },
    );
    assert.deepEqual(
      await loadApprovalPreview({ senderId: 1, approvalId: 'nope', ...deps }),
      { ok: false, reason: 'not_found' },
    );
    assert.deepEqual(
      await loadApprovalPreview({ senderId: 2, approvalId: issued.approvalId, ...deps }),
      { ok: false, reason: 'not_found' },
    );
  });

  it('soft-fails when the bytes cannot be read, or cannot decode and exceed the inline cap', async () => {
    const approvals = createAttachmentApprovalRegistry();
    const issue = () => approvals.issueApprovals(1, [{ path: '/tmp/shot.png', name: 'shot.png', size: 4 }])[0];
    assert.deepEqual(
      await loadApprovalPreview({
        senderId: 1,
        approvalId: issue().approvalId,
        approvals,
        readFile: async () => {
          throw new Error('too large');
        },
        renderPreview: fakeRenderPreview,
      }),
      { ok: false, reason: 'unreadable' },
    );
    assert.deepEqual(
      await loadApprovalPreview({
        senderId: 1,
        approvalId: issue().approvalId,
        approvals,
        readFile: async () => PNG,
        renderPreview: async () => null,
        inlineFallbackMaxBytes: 2,
      }),
      { ok: false, reason: 'unreadable' },
    );
  });
});
