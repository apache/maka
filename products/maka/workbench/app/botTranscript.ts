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

import { signal } from 'nsh';
import type { createHost } from './host';

type Host = Pick<ReturnType<typeof createHost>, 'query' | 'subscribe'>;
export type BotTranscriptMessage = {
  sequence: number;
  messageId: string;
  index: number;
  text: string;
  at: number;
};

const SEND_USER = 'SendUser';
const MESSAGE_ID = /"messageId"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** The `messageId` of a `SendUser` call row, read from its (possibly partial) arguments. */
export function sendUserMessageId(row: { role: string; text: string; tool?: any }): string | null {
  if (row.role !== 'tool_call' || row.tool?.call?.name !== SEND_USER) return null;
  try {
    const value = JSON.parse(row.text);
    if (typeof value?.messageId === 'string') return value.messageId.trim();
  } catch {
    // Partial arguments: fall back to the field itself.
  }
  const match = MESSAGE_ID.exec(row.text);
  if (!match) return null;
  try {
    return (JSON.parse(`"${match[1]}"`) as string).trim();
  } catch {
    return null;
  }
}

/**
 * What the Bot deliberately told its user, keyed by `SendUser` messageId. Only the
 * Bot Session subscribes; other Sessions make one head lookup and stop.
 */
export function createBotTranscript(host: Host, sessionId: string) {
  const isBot = signal(false);
  const byMessage = signal<ReadonlyMap<string, BotTranscriptMessage[]>>(new Map());
  let alive = true;
  let stream: { close(): Promise<void> } | null = null;
  let cursor = 0;
  const catchUp = async (through: number) => {
    while (alive && cursor < through) {
      const page = await host.query('agent', 'botOutbox', { after: cursor });
      if (!alive || page.sessionId !== sessionId || page.messages.length === 0) return;
      const next = new Map(byMessage());
      for (const message of page.messages) {
        next.set(message.messageId, [...(next.get(message.messageId) ?? []), message]);
        cursor = message.sequence;
      }
      byMessage.set(next);
      if (page.nextAfter === null || page.nextAfter === undefined) return;
    }
  };
  void (async () => {
    try {
      const head = await host.query('agent', 'botOutbox', { limit: 0 });
      if (!alive || head.sessionId !== sessionId) return;
      isBot.set(true);
      const opened = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const latest = await opened.next();
        if (!alive || latest === null) return;
        if (latest.sessionId === sessionId) await catchUp(latest.through);
      }
    } catch {
      // Not the Bot Session, or the Bot mode is off: the conversation stays ordinary.
    }
  })();
  return {
    isBot: () => isBot(),
    messages: (messageId: string) => byMessage().get(messageId),
    close() {
      alive = false;
      const previous = stream;
      stream = null;
      if (previous) void previous.close().catch(() => {});
    },
  };
}
