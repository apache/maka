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

import type { InlineReference, QuoteRef } from '@maka/core/events';
import type { TransientUserMessageProjection } from '@maka/ui';

type DirectoryReferences = NonNullable<TransientUserMessageProjection['directoryReferences']>;
interface TransientMessagePublisher {
  activeIdRef: { current: string | undefined };
  addTransientMessage: (sessionId: string, message: TransientUserMessageProjection) => void;
  updateTransientMessage: (sessionId: string, message: TransientUserMessageProjection) => void;
  setMessageLoadErrorBySession: (updater: (current: Record<string, string>) => Record<string, string>) => void;
}

function copiedArray<K extends string, T>(key: K, values: readonly T[] | undefined): Partial<Record<K, T[]>> {
  return values?.length ? { [key]: [...values] } as Record<K, T[]> : {};
}

export function publishTransientUserMessage(
  deps: TransientMessagePublisher,
  sessionId: string,
  messageId: string,
  text: string,
  attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
  options: {
    placement?: TransientUserMessageProjection['transientPlacement'];
    hostTurnId?: string;
    displayAfter?: import('@maka/core/events').MessageDisplayAnchor | null;
    updateOnly?: boolean;
    directoryReferences?: DirectoryReferences;
    quotes?: readonly QuoteRef[];
    inlineReferences?: readonly InlineReference[];
  } = {},
): void {
  const { activeIdRef, addTransientMessage, updateTransientMessage, setMessageLoadErrorBySession } = deps;
  const directoryReferences = options.directoryReferences;
  const quotes = options.quotes ?? [];
  const next: TransientUserMessageProjection = {
    id: messageId,
    ts: Date.now(),
    ...(options.displayAfter !== undefined ? { displayAfter: options.displayAfter } : {}),
    text,
    ...copiedArray('attachments', attachments),
    ...copiedArray('directoryReferences', directoryReferences),
    ...copiedArray('quotes', quotes),
    inlineReferences: [...(options.inlineReferences ?? [])],
    transientPlacement: options.placement ?? 'current_turn',
    ...(options.hostTurnId ? { hostTurnId: options.hostTurnId } : {}),
  };
  if (options.updateOnly) updateTransientMessage(sessionId, next);
  else addTransientMessage(sessionId, next);
  if (activeIdRef.current !== sessionId) return;
  setMessageLoadErrorBySession((current) => {
    if (!current[sessionId]) return current;
    const cleared = { ...current };
    delete cleared[sessionId];
    return cleared;
  });
}
