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

import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';

/** Copy one committed mailbox message into the canonical conversation ledger.
 * No provider is started. The existing atomic conversation-copy writer seals
 * the presentation invocation with its text, so restart cannot expose half a message.
 */
export async function publishBotConversationMessage(
  stores: ExecutionStoresWriter<'interactive'>,
  header: SessionHeader,
  message: StoredMessage,
  assertAvailable: () => void = () => {},
) {
  if (message.type !== 'user' && message.type !== 'assistant')
    throw Error('Expected conversation text');
  const runId =
    'assistant-message-' +
    createHash('sha256')
      .update(JSON.stringify([header.id, message.id]))
      .digest('hex')
      .slice(0, 40);
  const existing = await stores.runtimeEventStore.readRuntimeEvents(header.id, runId);
  if (existing.length) {
    const text = existing.find((event) => event.refs?.storedMessageId === message.id);
    if (
      text?.content?.kind !== 'text' ||
      text.content.text !== message.text ||
      !isDeepStrictEqual(
        text.content.origin,
        message.type === 'user' ? message.origin : undefined,
      ) ||
      text.author !== (message.type === 'user' ? (message.origin ? 'host' : 'user') : 'agent') ||
      text.content.summary !== (message.type === 'assistant' ? message.summary : undefined) ||
      !isDeepStrictEqual(text.content.card, message.type === 'assistant' ? message.card : undefined)
    )
      throw Error('Assistant conversation ledger identity conflict');
    return;
  }
  const identity = { sessionId: header.id, runId, turnId: message.turnId, invocationId: runId };
  const base = { ...identity, ts: message.ts, partial: false } as const;
  const events: RuntimeEvent[] = [
    buildInvocationOpenedEvent({
      id: `${runId}-opened`,
      run: identity,
      openedAt: message.ts,
      opening: {
        kind: 'invocation_opened',
        protocol: 'invocation_opened_v1',
        // This is copied conversation, not an authenticated model execution.
        route: {
          provenance: 'unknown',
          backendKind: header.backend,
          llmConnectionSlug: header.llmConnectionSlug,
          modelId: message.type === 'assistant' ? message.modelId : header.model,
        },
        configuration: {
          cwd: header.cwd,
          permissionMode: header.permissionMode,
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          toolMode: DEFAULT_TOOL_MODE,
        },
        root: { kind: 'user' },
        source: { kind: 'fresh' },
      },
    }),
    {
      ...base,
      id: `${runId}-text`,
      role: message.type === 'user' ? 'user' : 'model',
      author: message.type === 'user' ? (message.origin ? 'host' : 'user') : 'agent',
      content: {
        kind: 'text',
        text: message.text,
        ...(message.type === 'assistant' && message.card !== undefined
          ? { card: message.card }
          : {}),
        ...(message.type === 'assistant' && message.summary !== undefined
          ? { summary: message.summary }
          : {}),
        ...(message.type === 'user'
          ? {
              ...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
              ...(message.origin !== undefined ? { origin: message.origin } : {}),
              ...(message.attachments?.length ? { attachments: message.attachments } : {}),
              ...(message.quotes?.length ? { quotes: message.quotes } : {}),
              ...(message.directoryReferences
                ? { directoryReferences: message.directoryReferences }
                : {}),
              ...(message.inlineReferences ? { inlineReferences: message.inlineReferences } : {}),
            }
          : {}),
      },
      refs: { storedMessageId: message.id },
    },
    {
      ...base,
      id: `${runId}-closed`,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    },
  ];
  // Reads above can yield while the assistant is being disabled. Fence the
  // first durable write; the outbox retains accepted input for later replay.
  assertAvailable();
  await stores.runtimeEventStore.importConversationCopyRuntimeEvents(header.id, [
    { runId, events },
  ]);
}
