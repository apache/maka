import { FileCode, FileImage, FileText, FileType, Paperclip, type LucideIcon } from './icons.js';
import type { AttachmentRef } from '@maka/core/events';
import { Icon } from '@astryxdesign/core/Icon';

/** Per-kind lucide icon for attachment tokens. Replaces the
 *  emoji labels (🖼📄📘💻📎) with a consistent icon set. */
export const ATTACHMENT_KIND_ICON: Record<AttachmentRef['kind'], LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  doc: FileType,
  code: FileCode,
  other: Paperclip,
};

export function AttachmentKindIcon(props: { kind: AttachmentRef['kind']; className?: string }) {
  const AttachmentIcon = ATTACHMENT_KIND_ICON[props.kind];
  return <Icon icon={AttachmentIcon} size="sm" color="inherit" className={props.className} />;
}
