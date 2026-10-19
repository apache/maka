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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ImageDeliveryRequest, ImageDeliveryResult, ResolveImageDelivery } from '@maka/core/image-delivery';
import { isRemoteImageSource } from '@maka/core/image-delivery';
export type { ResolveImageDelivery } from '@maka/core/image-delivery';
const ImageMessageScope = createContext<{ turnId: string; messageId: string; streaming?: boolean } | undefined>(undefined);
/** Installed by assistant messages, outside the generic Markdown renderer. */
export function ImageMessageProvider(props: {
  identity?: { turnId: string; messageId: string };
  streaming?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => props.identity
    ? { turnId: props.identity.turnId, messageId: props.identity.messageId, streaming: props.streaming }
    : undefined, [props.identity?.turnId, props.identity?.messageId, props.streaming]);
  return <ImageMessageScope.Provider value={value}>{props.children}</ImageMessageScope.Provider>;
}
const DeliveryContext = createContext<{ resolve(request: ImageDeliveryRequest): Promise<ImageDeliveryResult> } | undefined>(undefined);
export function ImageDeliveryProvider(props: { sessionId: string; resolve?: ResolveImageDelivery; children: ReactNode }) {
  const value = useMemo(() => {
    if (!props.resolve) return undefined;
    const resolve = props.resolve;
    const pending = new Map<string, Promise<ImageDeliveryResult>>();
    const ready = new Map<string, ImageDeliveryResult>();
    return { resolve(request: ImageDeliveryRequest) {
      const key = JSON.stringify([request.turnId, request.messageId, request.source]);
      const cached = ready.get(key); if (cached) return Promise.resolve(cached);
      const running = pending.get(key); if (running) return running;
      const job = resolve(props.sessionId, request).catch((): ImageDeliveryResult => ({ status: 'failed', reason: 'read_failed' }));
      pending.set(key, job);
      void job.then(result => {
        pending.delete(key);
        if (result.status === 'ready') {
          ready.set(key, result); if (ready.size > 128) ready.delete(ready.keys().next().value!);
        }
      });
      return job;
    }};
  }, [props.resolve, props.sessionId]);
  return <DeliveryContext.Provider value={value}>{props.children}</DeliveryContext.Provider>;
}
export function useImageDelivery(source: string, enabled: boolean, allowRemote: boolean) {
  const scope = useContext(ImageMessageScope);
  const context = useContext(DeliveryContext);
  const [attempt, setAttempt] = useState(0);
  // Saved images can resolve even when display redaction forbids a source fetch.
  // Redaction protects display/retry UX for recognized secrets, not outbound data:
  // an encoded value in a model-authored URL may still pass this presentation check.
  const loadRemote = allowRemote && isRemoteImageSource(source);
  const identity = useMemo(() => context && scope?.turnId && scope.messageId && enabled
    ? { context, turnId: scope.turnId, messageId: scope.messageId, streaming: scope.streaming === true, source, attempt, loadRemote } : undefined,
    [context, scope?.turnId, scope?.messageId, scope?.streaming, source, attempt, loadRemote, enabled]);
  const [settled, setSettled] = useState<{ identity: typeof identity; result: ImageDeliveryResult }>();
  const retry = useCallback(() => setAttempt(a => a + 1), []);
  useEffect(() => {
    if (!identity) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined; let delay = 500; let unavailableRetries = 0;
    const query = async (retry: boolean) => {
      const result = await identity.context.resolve({ turnId: identity.turnId, messageId: identity.messageId, source: identity.source, ...(retry ? { retry: true } : {}), ...(identity.loadRemote ? { loadRemote: true } : {}) });
      if (cancelled) return;
      setSettled({ identity, result });
      // Canonical text can lag the displayed stream. Retry briefly after settlement,
      // but do not poll permanently unsupported sources forever.
      if (result.status === 'pending' || result.status === 'unavailable' && (identity.streaming || unavailableRetries++ < 3)) {
        timer = setTimeout(() => { void query(false); }, delay); delay = Math.min(5000, delay * 2);
      }
    };
    void query(attempt > 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [identity, attempt]);
  const result: ImageDeliveryResult = !identity ? { status: 'unavailable' }
    : settled?.identity === identity ? settled.result : { status: 'pending' };
  return { ...result, retry, available: !!identity };
}
