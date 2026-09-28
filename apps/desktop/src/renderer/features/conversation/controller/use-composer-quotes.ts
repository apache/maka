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

import { useCallback, useRef, useState } from 'react';
import { QUOTE_COMMENT_MAX_LENGTH, type QuoteRef } from '@maka/core/events';
import type { ChatViewHandle } from '@maka/ui';

const MAX_QUOTE_CHARS = 32_000;

type PendingQuotes = Record<string, QuoteRef[]>;

export function useComposerQuotes(options: { readonly draftKey: string }) {
  // Each draft's bucket is mutated in place so a send in the same tick as a
  // staging call already sees the quote; the version bump only re-renders.
  // Consumers must read the contents, never depend on the array identity.
  const [, bumpVersion] = useState(0);
  const pendingByKeyRef = useRef<PendingQuotes>({});
  const bucket = pendingByKeyRef.current[options.draftKey] ??
    (pendingByKeyRef.current[options.draftKey] = []);

  const publish = useCallback((): void => {
    bumpVersion((version) => version + 1);
  }, []);

  const addQuote = useCallback((input: {
    text: string;
    turnId?: string;
    label?: string;
    comment?: string;
    sourceSessionId?: string;
    sourceSessionName?: string;
    sourceCapturedAt?: number;
    sourceTruncated?: boolean;
  }): void => {
    const text = input.text.slice(0, MAX_QUOTE_CHARS).trim();
    if (!text) return;
    const comment = input.comment?.slice(0, QUOTE_COMMENT_MAX_LENGTH).trim();
    bucket.push({
      text,
      ...(input.label ? { label: input.label } : {}),
      ...(comment ? { comment } : {}),
      ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceSessionName ? { sourceSessionName: input.sourceSessionName } : {}),
      ...(input.sourceCapturedAt !== undefined ? { sourceCapturedAt: input.sourceCapturedAt } : {}),
      ...(input.sourceTruncated !== undefined ? { sourceTruncated: input.sourceTruncated } : {}),
    });
    publish();
  }, [bucket, publish]);

  const updateQuoteComment = useCallback((index: number, comment: string): void => {
    const quote = bucket[index];
    if (!quote) return;
    const { comment: _previous, ...rest } = quote;
    const note = comment.slice(0, QUOTE_COMMENT_MAX_LENGTH).trim();
    bucket[index] = note ? { ...rest, comment: note } : rest;
    publish();
  }, [bucket, publish]);

  const removeQuote = useCallback((index: number): void => {
    bucket.splice(index, 1);
    publish();
  }, [bucket, publish]);

  const clearQuotes = useCallback((): void => {
    bucket.splice(0, bucket.length);
    publish();
  }, [bucket, publish]);

  const restoreQuotes = useCallback((ownerKey: string, quotes: readonly QuoteRef[]): void => {
    if (quotes.length === 0) return;
    const ownerBucket = pendingByKeyRef.current[ownerKey] ??
      (pendingByKeyRef.current[ownerKey] = []);
    ownerBucket.push(...quotes.map((quote) => ({ ...quote })));
    publish();
  }, [publish]);

  // The composer's token asks the transcript to open the note editor over the
  // excerpt; a synchronous false means it falls back to its own popover.
  const chatViewRef = useRef<ChatViewHandle>(null);
  const tryAnnotateQuote = (index: number): boolean =>
    chatViewRef.current?.openQuoteAnnotation(index) ?? false;

  const quotesForSend = (): QuoteRef[] | undefined =>
    bucket.length ? bucket : undefined;

  return {
    pendingQuotes: bucket,
    hasStagedQuotes: bucket.length > 0,
    addQuote,
    updateQuoteComment,
    removeQuote,
    clearQuotes,
    restoreQuotes,
    quotesForSend,
    composerQuoteProps: (canStage: boolean) => ({
      pendingQuotes: bucket,
      onRemoveQuote: removeQuote,
      onEditQuoteComment: canStage ? updateQuoteComment : undefined,
      onAnnotateQuote: canStage ? tryAnnotateQuote : undefined,
    }),
    chatViewQuoteProps: {
      handleRef: chatViewRef,
      pendingQuotes: bucket,
      onQuoteAnnotationSubmit: updateQuoteComment,
    },
  };
}
