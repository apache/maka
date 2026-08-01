import type { ComponentProps } from 'react';
import { ChatLayout } from '@astryxdesign/core/Chat';
import { cn } from './utils.js';

export type ChatSurfaceLayoutProps = ComponentProps<typeof ChatLayout>;

/**
 * Maka's product seam for the Astryx chat page shell.
 *
 * Astryx owns scrolling, new-message following, the bottom dock, and the
 * scroll-to-bottom affordance. Maka supplies only transcript and composer
 * content through the published ChatLayout slots.
 */
export function ChatSurfaceLayout({ className, density = 'compact', ...props }: ChatSurfaceLayoutProps) {
  return (
    <ChatLayout
      {...props}
      density={density}
      className={cn('maka-chat-layout', className)}
      data-chat-scroll-container="true"
    />
  );
}
