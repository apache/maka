import { Buffer } from 'node:buffer';
import { attachmentKindFromMimeType, guessMimeFromName, MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';

export type AttachmentPreviewResult =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; reason: 'invalid' | 'not_found' | 'not_image' | 'unreadable' };

/**
 * When the thumbnail renderer can't decode the format (nativeImage has no
 * GIF/WebP support), the original bytes ship as the preview instead — the
 * renderer's <img> decodes those natively (and keeps GIFs animated). Only up
 * to this size, so a huge original never rides the IPC as a data URL.
 */
export const INLINE_PREVIEW_FALLBACK_MAX_BYTES = 12 * 1024 * 1024;

export interface AttachmentPreviewDeps {
  readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  renderPreview: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

/**
 * Resolve a staged (not yet sent) approval attachment into thumbnail bytes
 * for the composer drawer. The approval is only PEEKED — the token must stay
 * redeemable for the eventual send — and the path never leaves main; only
 * the rendered preview does. Preview failures are soft by design: the
 * renderer falls back to the named file card and the attachment still sends.
 *
 * The read is capped at the approval's own stat size, not the global
 * attachment cap: `readFileCapped` allocates its cap up front, and a flat
 * 50MB per call turns a multi-image staging into an instant memory spike
 * (the renderer additionally serializes preview requests).
 *
 * `readFile`/`renderPreview` are injected because they depend on fs and
 * Electron's nativeImage respectively; tests pass fakes.
 */
export async function loadApprovalPreview(input: {
  senderId: number;
  approvalId: unknown;
  approvals: AttachmentApprovalRegistry;
  maxBytes?: number;
  inlineFallbackMaxBytes?: number;
} & AttachmentPreviewDeps): Promise<AttachmentPreviewResult> {
  if (typeof input.approvalId !== 'string' || input.approvalId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  const approved = input.approvals.peekApproval(input.senderId, input.approvalId);
  if (!approved) return { ok: false, reason: 'not_found' };
  const mimeType =
    approved.mimeType && approved.mimeType.length > 0
      ? approved.mimeType
      : guessMimeFromName(approved.name);
  if (attachmentKindFromMimeType(mimeType, approved.name) !== 'image') {
    return { ok: false, reason: 'not_image' };
  }
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (approved.size > maxBytes) return { ok: false, reason: 'unreadable' };
  try {
    const bytes = await input.readFile(approved.path, approved.size);
    const preview = await input.renderPreview(bytes);
    if (preview) {
      return {
        ok: true,
        base64: Buffer.from(preview.bytes).toString('base64'),
        mimeType: preview.mimeType,
      };
    }
    const fallbackCap = input.inlineFallbackMaxBytes ?? INLINE_PREVIEW_FALLBACK_MAX_BYTES;
    if (bytes.byteLength <= fallbackCap) {
      return { ok: true, base64: Buffer.from(bytes).toString('base64'), mimeType };
    }
    return { ok: false, reason: 'unreadable' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * Register the client-owned attachment preview boundary used by Runtime Host
 * Desktop. Preview admission and byte validation remain local because the
 * renderer consumes this native presentation capability directly.
 */
export function registerAttachmentPreviewIpc(input: {
  ipcMain: {
    handle(
      channel: string,
      listener: (event: { sender: { id: number } }, approvalId: unknown) => Promise<AttachmentPreviewResult>,
    ): void;
  };
  approvals: AttachmentApprovalRegistry;
} & AttachmentPreviewDeps): void {
  input.ipcMain.handle('attachments:previewApproval', (event, approvalId) =>
    loadApprovalPreview({
      senderId: event.sender.id,
      approvalId,
      approvals: input.approvals,
      readFile: input.readFile,
      renderPreview: input.renderPreview,
    }),
  );
}
