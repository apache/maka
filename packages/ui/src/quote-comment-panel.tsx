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
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface QuoteCommentPanelProps {
  /** Note already staged. Empty when the panel gates a fresh quote. */
  comment?: string;
  title: string;
  /** Commits the note as written; an empty note means no annotation. */
  submitLabel: string;
  /** Leaves without committing anything. */
  cancelLabel: string;
  onSubmit(comment: string): void;
  onCancel(): void;
}

/**
 * Note editor for one quote. Content only: the host owns the surface it floats
 * on (the transcript's annotation layer or the composer's Popover), and those
 * surfaces don't light-dismiss, so the panel's own buttons are the only exits.
 */
export function QuoteCommentPanel(props: QuoteCommentPanelProps) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [draft, setDraft] = useState(props.comment ?? '');
  const inputRef = useRef<ChatComposerInputHandle>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(): void {
    props.onSubmit(draft.trim());
  }

  return (
    <VStack
      gap={2}
      className="maka-quote-comment-panel"
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
        <UiButton variant="ghost" size="sm" label={props.cancelLabel} onClick={props.onCancel} />
        <UiButton size="sm" label={props.submitLabel} onClick={submit} />
      </HStack>
    </VStack>
  );
}
