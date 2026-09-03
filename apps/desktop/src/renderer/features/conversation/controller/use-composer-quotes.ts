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
import type { QuoteRef } from '@maka/core/events';

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
    sourceSessionId?: string;
    sourceSessionName?: string;
    sourceCapturedAt?: number;
    sourceTruncated?: boolean;
  }): void => {
    const text = input.text.slice(0, MAX_QUOTE_CHARS).trim();
    if (!text) return;
    const quote: QuoteRef = {
      text,
      ...(input.label ? { label: input.label } : {}),
      ...(input.turnId ? { sourceTurnId: input.turnId } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourceSessionName ? { sourceSessionName: input.sourceSessionName } : {}),
      ...(input.sourceCapturedAt !== undefined ? { sourceCapturedAt: input.sourceCapturedAt } : {}),
      ...(input.sourceTruncated !== undefined ? { sourceTruncated: input.sourceTruncated } : {}),
    };
    bucket.push(quote);
    publish();
  }, [bucket, options.draftKey, publish]);

  const removeQuote = useCallback((index: number): void => {
    bucket.splice(index, 1);
    publish();
  }, [bucket, publish]);

  const clearQuotes = useCallback((): void => {
    bucket.splice(0, bucket.length);
    publish();
  }, [bucket, publish]);

  const clearAllQuotes = useCallback((): void => {
    for (const quotes of Object.values(pendingByKeyRef.current)) quotes.splice(0, quotes.length);
    publish();
  }, [publish]);

  const restoreQuotes = useCallback((ownerKey: string, quotes: readonly QuoteRef[]): void => {
    if (quotes.length === 0) return;
    const ownerBucket = pendingByKeyRef.current[ownerKey] ??
      (pendingByKeyRef.current[ownerKey] = []);
    ownerBucket.push(...quotes.map((quote) => ({ ...quote })));
    publish();
  }, [publish]);

  return {
    pendingQuotes,
    addQuote,
    removeQuote,
    clearQuotes,
    clearAllQuotes,
    restoreQuotes,
  };
}
