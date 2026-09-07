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

import type { StoredMessage, UserMessage } from '@maka/core/session';

export function projectSessionCatalogMessages(messages: readonly StoredMessage[]): {
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
} {
  const lastMessageAt = latestVisibleMessageAt(messages);
  const lastMessagePreview = lastMessagePreviewForMessages(messages);
  return {
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
  };
}

export function catalogPreviewForUserMessage(message: UserMessage): string | undefined {
  const text = normalizePreviewText(message.displayText ?? message.text);
  if (text) return truncatePreview(text);
  return message.attachments && message.attachments.length > 0 ? '附件' : undefined;
}

export function latestVisibleMessageAt(messages: readonly StoredMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.type === 'user' ||
      message.type === 'assistant' ||
      message.type === 'workhub_coordination'
    ) {
      return message.ts;
    }
  }
  return undefined;
}

export function isVisibleSessionMessage(
  message: StoredMessage,
): message is Extract<StoredMessage, { type: 'user' | 'assistant' }> {
  return message.type === 'user' || message.type === 'assistant';
}

export function lastMessagePreviewForMessages(
  messages: readonly StoredMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user') {
      const preview = catalogPreviewForUserMessage(message);
      if (preview !== undefined) return preview;
    }
    if (message.type === 'assistant') {
      const text = normalizePreviewText(message.text);
      if (text) return truncatePreview(text);
    }
    if (message.type === 'workhub_coordination') {
      const text = 'userText' in message ? normalizePreviewText(message.userText) : '';
      if (text) return truncatePreview(text);
    }
  }
  return undefined;
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncatePreview(text: string, maxLength = 96): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength - 1).join('')}…`;
}
