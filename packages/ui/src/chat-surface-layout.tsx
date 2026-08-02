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
 *
 * The density default drops a `compact` override and lets Astryx's own default
 * (`balanced`) stand. Compact spends spacing-2 on the dock's gutters — 8px
 * between the composer card's rounded bottom edge and the window edge, at every
 * window height — and the card read as pushed against the frame rather than
 * resting above it. Balanced spends spacing-3 there and lengthens the fade over
 * the transcript to match (blur layer 80px → 100px, mask ramp 24px → 36px). The
 * message-area and dock-inner styles resolve to literally the same StyleX atoms
 * in both tiers, so this moves the dock and nothing else. It stays written out
 * rather than dropped entirely so an upstream default change cannot silently
 * retune the composer's gutters; `chat-surface-layout.test.tsx` holds the value.
 */
export function ChatSurfaceLayout({ className, density = 'balanced', ...props }: ChatSurfaceLayoutProps) {
  return (
    <ChatLayout
      {...props}
      density={density}
      className={cn('maka-chat-layout', className)}
      data-chat-scroll-container="true"
    />
  );
}
