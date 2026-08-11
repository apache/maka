import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { type UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type PreflightItem = {
  size: number;
  source: { type: 'approval'; approvalId: string } | { type: 'file'; file: { size: number } };
};

/**
 * Reject count/size/duplicate-token violations before a new-chat session is
 * created, so an encode/resolve-time failure does not leave an empty session
 * behind. This is a renderer-side UX guard mirroring main-side
 * resolveIngestItems pre-validation; main remains the authoritative cap.
 *
 * File blobs are sized by the browser File object; approval-token attachments
 * are sized by the pending size stamped at pick time (main re-stats).
 */
export function preflightAttachmentItems(items: readonly PreflightItem[], locale: UiLocale = 'zh'): void {
  const copy = getDesktopConversationCopy(locale).attachments;
  if (items.length > MAX_ATTACHMENT_COUNT) throw new Error(copy.tooMany);
  const seen = new Set<string>();
  for (const item of items) {
    const bytes = item.source.type === 'file' ? item.source.file.size : item.size;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(copy.tooLarge);
    if (item.source.type === 'approval') {
      if (seen.has(item.source.approvalId)) throw new Error(copy.duplicate);
      seen.add(item.source.approvalId);
    }
  }
}
