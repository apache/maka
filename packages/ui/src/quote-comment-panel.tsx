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

import { useEffect, useRef, useState } from 'react';
import {
  Button as UiButton,
  ChatComposerInput,
  HStack,
  VStack,
  type ChatComposerInputHandle,
} from '@astryxdesign/core';
import { QUOTE_COMMENT_MAX_LENGTH } from '@maka/core/events';
import { cn } from './utils.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface QuoteCommentPanelProps {
  /** Note already staged. Empty when the panel gates a fresh quote. */
  comment?: string;
  title: string;
  /** Commits the quote with the note written below. */
  submitLabel: string;
  /** Commits the quote with no note, discarding whatever is written below. */
  skipLabel: string;
  onSubmit(comment: string): void;
  onSkip(): void;
  className?: string;
}

/**
 * Annotation editor for one quote, rendered by the host wherever the gesture
 * happened: below the selection's action bar in the transcript, or in a
 * popover on the staged token in the composer. Both placements submit the same
 * trimmed note, so a quote carries the same annotation whichever way it was
 * made.
 *
 * The panel is content only — each host owns the surface it floats on (the
 * composer's Popover, the transcript's annotation layer), so the same note
 * reads the same wherever it is written. Its own buttons are the only way
 * out; the submit shortcut lives here and nothing else does.
 */
export function QuoteCommentPanel(props: QuoteCommentPanelProps) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [draft, setDraft] = useState(props.comment ?? '');
  const inputRef = useRef<ChatComposerInputHandle>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(): void {
    props.onSubmit(draft.slice(0, QUOTE_COMMENT_MAX_LENGTH).trim());
  }

  return (
    <VStack
      gap={2}
      className={cn('maka-quote-comment-panel', props.className)}
      role="group"
      aria-label={props.title}
    >
      <ChatComposerInput
        handleRef={inputRef}
        label={copy.quoteCommentLabel}
        value={draft}
        onChange={(value) => setDraft(value.slice(0, QUOTE_COMMENT_MAX_LENGTH))}
        placeholder={copy.quoteCommentPlaceholder}
        maxRows={4}
        hasHistory={false}
        pasteAsToken={false}
        onSubmit={submit}
      />
      <HStack gap={2} hAlign="end">
        <UiButton variant="ghost" size="sm" label={props.skipLabel} onClick={props.onSkip} />
        <UiButton size="sm" label={props.submitLabel} onClick={submit} />
      </HStack>
    </VStack>
  );
}
