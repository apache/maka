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

import { useMemo, type ComponentProps } from 'react';
import { ChatLayout } from '@astryxdesign/core/Chat';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import {
  TranscriptScrollAuthorityProvider,
  TranscriptScrollButton,
} from './transcript-scroll-authority.js';
import { cn } from './utils.js';

/**
 * Stock ChatLayoutProps, minus `autoScroll`. That prop is the patch-package
 * seam (`patches/@astryxdesign+core+0.5.0.patch`) forwarding Astryx's own
 * published `enabled` option to `useChatStreamScroll`, and `scrollOwner`
 * decides it — a caller-supplied value would be silently overwritten.
 */
export type ChatSurfaceLayoutProps = Omit<ComponentProps<typeof ChatLayout>, 'autoScroll'> & {
  /**
   * Who positions this transcript.
   *
   * `astryx` keeps the library's auto-follow, for the surfaces that render
   * their own content rather than a `ChatView`. `host` turns Astryx's scroll
   * layer off entirely — no listeners, no spring — and hands `scrollTop` to
   * Maka's single authority, which is what a `ChatView` transcript needs: it
   * knows turn identity, the Host active range and the navigation the reader
   * asked for, none of which a generic scroll container can see.
   */
  scrollOwner?: 'astryx' | 'host';
  scrollToBottomLabel?: string;
};

/**
 * Maka's product seam for the Astryx chat page shell.
 *
 * Astryx owns the bottom dock and the message area. Whether it also owns
 * scrolling is `scrollOwner`'s answer, and there is never more than one owner.
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
 * retune the composer's gutters.
 */
export function ChatSurfaceLayout({
  className,
  density = 'balanced',
  scrollOwner = 'astryx',
  scrollToBottomLabel,
  ...props
}: ChatSurfaceLayoutProps) {
  const hostOwned = scrollOwner === 'host';
  const astryxOverrides = useMemo(
    () =>
      scrollToBottomLabel
        ? {
            '@astryx.chatLayoutScrollButton.scrollToBottom': scrollToBottomLabel,
          }
        : undefined,
    [scrollToBottomLabel],
  );
  const layout = (
    <ChatLayout
      {...props}
      autoScroll={!hostOwned}
      // Astryx's default button reads `isScrolledUp`, which stops updating the
      // moment its scroll layer is off. Maka's reads Maka's pin instead.
      scrollButton={hostOwned ? <TranscriptScrollButton /> : props.scrollButton}
      density={density}
      className={cn('maka-chat-layout', className)}
      data-chat-scroll-container="true"
    />
  );
  const localized = astryxOverrides ? (
    <AstryxLocaleProvider overrides={astryxOverrides}>{layout}</AstryxLocaleProvider>
  ) : (
    layout
  );
  // Unconditional: an authority nobody attaches a scroller to writes nothing
  // and costs one object, and providing it always is what lets everything
  // below treat it as present instead of carrying a second, unreachable
  // behaviour for its absence.
  return <TranscriptScrollAuthorityProvider>{localized}</TranscriptScrollAuthorityProvider>;
}
