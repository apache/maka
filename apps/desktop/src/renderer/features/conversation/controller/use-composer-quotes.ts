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

const MAX_QUOTE_CHARS = 32_000;

type PendingQuotes = Record<string, QuoteRef[]>;

export function useComposerQuotes(options: { readonly draftKey: string }) {
  const [pendingByKey, setPendingByKey] = useState<PendingQuotes>({});
  // React state triggers rendering, while each bucket is kept mutable so a
  // send callback from the current render observes a quote selected in the
  // same tick as the snapshot read. This avoids making AppShell reach into a
  // second quote getter solely to bridge React's commit timing.
  const pendingByKeyRef = useRef<PendingQuotes>({});
  const bucket = pendingByKeyRef.current[options.draftKey] ??
    (pendingByKeyRef.current[options.draftKey] = []);
  // This is intentionally a live bucket so a same-tick send can observe a
  // snapshot selected before React commits the state update. Consumers must
  // read its contents, not use the array identity as a useMemo/useEffect
  // dependency; the identity is stable while the bucket is mutated in place.
  const pendingQuotes = pendingByKey[options.draftKey] ?? bucket;

  const publish = useCallback((): void => {
    setPendingByKey({ ...pendingByKeyRef.current });
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
    const quote: QuoteRef = {
      text,
      ...(input.label ? { label: input.label } : {}),
      ...(comment ? { comment } : {}),
      ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceSessionName ? { sourceSessionName: input.sourceSessionName } : {}),
      ...(input.sourceCapturedAt !== undefined ? { sourceCapturedAt: input.sourceCapturedAt } : {}),
      ...(input.sourceTruncated !== undefined ? { sourceTruncated: input.sourceTruncated } : {}),
    };
    bucket.push(quote);
    publish();
  }, [bucket, options.draftKey, publish]);

  const updateQuoteComment = useCallback((index: number, comment: string): void => {
    const next = comment.slice(0, QUOTE_COMMENT_MAX_LENGTH).trim();
    const quote = bucket[index];
    if (!quote) return;
    // An emptied note removes the field rather than keeping the old one:
    // the excerpt is still staged, it simply carries nothing now.
    const { comment: _previous, ...rest } = quote;
    bucket[index] = next ? { ...rest, comment: next } : rest;
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

  return {
    pendingQuotes,
    addQuote,
    updateQuoteComment,
    removeQuote,
    clearQuotes,
  };
}
