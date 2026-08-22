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
import { cn } from './utils.js';

/**
 * Stock ChatLayoutProps plus the patch-package conversationKey seam
 * (`patches/@astryxdesign+core+0.3.0.patch`): resets scroll / unread state when
 * the host switches conversations in place without remounting the composer.
 *
 * Intersection is explicit because some TS resolutions only see the published
 * Astryx destructure list (which omits conversationKey) via ComponentProps.
 */
export type ChatSurfaceLayoutProps = ComponentProps<typeof ChatLayout> & {
  conversationKey?: string | number;
  scrollToBottomLabel?: string;
};

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
export function ChatSurfaceLayout({
  className,
  density = 'balanced',
  conversationKey,
  scrollToBottomLabel,
  ...props
}: ChatSurfaceLayoutProps) {
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
      conversationKey={conversationKey}
      density={density}
      className={cn('maka-chat-layout', className)}
      data-chat-scroll-container="true"
    />
  );
  return astryxOverrides ? (
    <AstryxLocaleProvider overrides={astryxOverrides}>{layout}</AstryxLocaleProvider>
  ) : (
    layout
  );
}
