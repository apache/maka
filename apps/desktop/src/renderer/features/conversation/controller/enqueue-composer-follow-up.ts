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

import type { PendingAttachment } from '@maka/ui/composer-attachments';
import type { QuoteRef } from '@maka/core/events';

export async function enqueueComposerFollowUp<Context extends { quotes?: readonly QuoteRef[] }>(input: {
  sessionId: string;
  text: string;
  mode: 'steer' | 'queue';
  pending: readonly PendingAttachment[] | undefined;
  context: Context;
  enqueueMessage: (sessionId: string, text: string, placement: 'current_turn' | 'next_turn', pending: readonly PendingAttachment[] | undefined, context: Context) => Promise<boolean>;
  clearSubmittedContext: (pending: readonly PendingAttachment[] | undefined) => void;
  clearQuotes: () => void;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  try {
    const sent = await input.enqueueMessage(input.sessionId, input.text,
      input.mode === 'steer' ? 'current_turn' : 'next_turn', input.pending, input.context);
    if (!sent) return false;
    input.clearSubmittedContext(input.pending);
    if (input.context.quotes?.length) input.clearQuotes();
    return true;
  } catch (error) {
    input.onError(error);
    return false;
  }
}
