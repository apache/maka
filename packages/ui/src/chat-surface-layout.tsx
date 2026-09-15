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

import { useMemo, useState, type ComponentProps } from 'react';
import { ChatLayout } from '@astryxdesign/core/Chat';
import { AstryxLocaleProvider } from './astryx-i18n.js';
import {
  TranscriptScrollAuthorityProvider,
  TranscriptScrollButton,
} from './transcript-scroll-authority.js';
import { cn } from './utils.js';
import { PromptAnchorRailHostContext } from './prompt-anchor-rail.js';

/**
 * Stock ChatLayoutProps, minus `autoScroll`. That prop is the patch-package
 * seam (`patches/@astryxdesign+core+0.5.2.patch`) forwarding Astryx's own
 * published `enabled` option to `useChatStreamScroll`. Maka always owns
 * transcript scrolling, so callers cannot enable a competing writer.
 */
export type ChatSurfaceLayoutProps = Omit<ComponentProps<typeof ChatLayout>, 'autoScroll'> & {
  scrollToBottomLabel?: string;
  /** Loads the durable tail after the scroll authority pins to it. */
  onReturnToTail?(): Promise<void> | void;
};

/**
 * Maka's product seam for the Astryx chat page shell.
 *
 * Astryx owns the bottom dock and the message area; Maka owns scrolling.
 *
 * The density default drops a `compact` override and lets Astryx's own default
 * (`balanced`) stand. Compact spends spacing-2 on the dock's gutters — 8px
 * between the composer card's rounded bottom edge and the window edge, at every
 * window height — and the card read as pushed against the frame rather than
 * resting above it. Balanced spends spacing-3 there and lengthens the fade's
 * mask ramp to match (24px → 36px); the blur layer itself fills the dock at
 * every tier, so density tunes only the ramp. The message-area and dock-inner
 * styles resolve to literally the same StyleX atoms in both tiers, so this
 * moves the dock and nothing else. It stays written out rather than dropped
 * entirely so an upstream default change cannot silently retune the composer's
 * gutters.
 */
export function ChatSurfaceLayout({
  className,
  children,
  density = 'balanced',
  scrollToBottomLabel,
  onReturnToTail,
  ...props
}: ChatSurfaceLayoutProps) {
  const [railHost, setRailHost] = useState<HTMLDivElement | null>(null);
  const astryxOverrides = useMemo(
    () =>
      scrollToBottomLabel
        ? {
            '@astryx.chatLayoutScrollButton.scrollToBottom': scrollToBottomLabel,
          }
        : undefined,
    [scrollToBottomLabel],
  );
  // Mirror Astryx ChatLayout's hasVisibleContent check to preserve the public
  // emptyState prop: a host fragment would otherwise count as visible content.
  const hasContent = children != null && children !== false
    && !(Array.isArray(children) && children.length === 0);
  const layout = (
    <ChatLayout
      {...props}
      autoScroll={false}
      // Astryx's default button reads `isScrolledUp`, which stops updating the
      // moment its scroll layer is off. Maka's reads Maka's pin instead.
      scrollButton={props.scrollButton === null ? null
        : <TranscriptScrollButton onActivate={onReturnToTail} />}
      density={density}
      className={cn('maka-chat-layout', className)}
      data-chat-scroll-container="true"
    >
      {hasContent ? <>
        <div className="maka-prompt-rail-host" ref={setRailHost} />
        {children}
      </> : children}
    </ChatLayout>
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
  return <TranscriptScrollAuthorityProvider>
    <PromptAnchorRailHostContext value={railHost}>{localized}</PromptAnchorRailHostContext>
  </TranscriptScrollAuthorityProvider>;
}
