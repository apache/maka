import { X } from './icons.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { formatBytes } from './tool-activity/preview-utils.js';
import { cn } from './utils.js';
import type { AttachmentRef } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/**
 * File attachment card shown inside the composer (removable) and inside a
 * sent user message (read-only). Follows the neutral-file-card pattern used
 * by ChatGPT/Claude/Creative-Tim's ai-file-attachment block: a neutral
 * surface, an icon tile, a truncated filename, and a mono file size.
 * Images are handled separately by AttachmentImage (thumbnail + lightbox);
 * this card is for non-image kinds (pdf/doc/code/other).
 */
export function AttachmentFileCard(props: {
  name: string;
  kind: AttachmentRef['kind'];
  size?: number;
  onRemove?: () => void;
  className?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  return (
    <div
      className={cn(
        'maka-attachment-file-card',
        props.className,
      )}
    >
      <span className="maka-attachment-file-icon">
        <AttachmentKindIcon kind={props.kind} />
      </span>
      <span className="maka-attachment-file-content">
        <span className="maka-attachment-file-name">{props.name}</span>
        {props.size !== undefined && (
          <span className="maka-attachment-file-size">
            {formatBytes(props.size)}
          </span>
        )}
      </span>
      {props.onRemove && (
        <button
          type="button"
          onClick={props.onRemove}
          className="maka-attachment-file-remove"
          aria-label={copy.removeAttachmentAriaLabel(props.name)}
        >
          <X />
        </button>
      )}
    </div>
  );
}
