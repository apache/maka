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

import type { MessageContent } from './events.js';

export const SESSION_MAILBOX_TEXT_MAX_BYTES = 16_000;
export const SESSION_MAILBOX_KINDS = ['request', 'reply', 'notification'] as const;
export type SessionMailboxKind = (typeof SESSION_MAILBOX_KINDS)[number];

export interface SessionMailboxEnvelope {
  readonly messageId: string;
  readonly fromSessionId: string;
  readonly fromSessionName: string;
  readonly toSessionId: string;
  readonly kind: SessionMailboxKind;
  readonly text: string;
  readonly correlationId?: string;
}

export interface SessionMailboxIncomingDisplay {
  readonly direction: 'incoming';
  readonly messageId: string;
  readonly fromSessionId: string;
  readonly fromSessionName: string;
  readonly toSessionId: string;
  readonly kind: SessionMailboxKind;
  readonly text: string;
  readonly correlationId?: string;
}

export interface SessionMailboxSentNoteData {
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly kind: SessionMailboxKind;
  readonly text: string;
  readonly disposition: 'turn_started' | 'queued';
}

export function sessionMailboxSentReceiptId(messageId: string): string {
  return `session-mailbox-sent:${messageId}`;
}

/**
 * Session messages are ordinary canonical user messages at the execution
 * boundary. The model-facing text carries an explicit Host-authored
 * envelope while the human-facing transcript stays compact.
 */
export function sessionMailboxMessageContent(envelope: SessionMailboxEnvelope): MessageContent {
  const attributes = [
    `message_id="${escapeAttribute(envelope.messageId)}"`,
    `from_session_id="${escapeAttribute(envelope.fromSessionId)}"`,
    `from_session_name="${escapeAttribute(envelope.fromSessionName)}"`,
    `to_session_id="${escapeAttribute(envelope.toSessionId)}"`,
    `kind="${envelope.kind}"`,
    ...(envelope.correlationId
      ? [`correlation_id="${escapeAttribute(envelope.correlationId)}"`]
      : []),
  ].join(' ');
  const replyInstruction =
    envelope.kind === 'request'
      ? `\nReply with session_reply(target_session_id=\"${envelope.fromSessionId}\", in_reply_to=\"${envelope.messageId}\", text=...).`
      : '';
  return {
    text: [
      `<session_message ${attributes}>`,
      `From session \"${escapeText(envelope.fromSessionName)}\":`,
      escapeText(envelope.text),
      replyInstruction,
      '</session_message>',
    ].join('\n'),
    displayText: `From ${envelope.fromSessionName}: ${envelope.text}`,
    inlineReferences: [],
  };
}

/**
 * Recovers the display fields from the exact Host-authored envelope. This is
 * deliberately stricter than looking for a human-readable `From:` prefix, so
 * ordinary user messages can never accidentally turn into mailbox cards.
 */
export function parseSessionMailboxMessageContent(
  content: Pick<MessageContent, 'text'>,
): SessionMailboxIncomingDisplay | undefined {
  const opening = content.text.match(/^<session_message ([^>\n]+)>\n/);
  if (!opening || !content.text.endsWith('\n</session_message>')) return undefined;
  const attributes = parseAttributes(opening[1] ?? '');
  const messageId = attributes.message_id;
  const fromSessionId = attributes.from_session_id;
  const toSessionId = attributes.to_session_id;
  const kind = attributes.kind;
  if (
    !messageId ||
    !fromSessionId ||
    !toSessionId ||
    !SESSION_MAILBOX_KINDS.includes(kind as SessionMailboxKind)
  ) {
    return undefined;
  }

  const inner = content.text.slice(opening[0].length, -'\n</session_message>'.length);
  const firstLineEnd = inner.indexOf('\n');
  if (firstLineEnd < 0) return undefined;
  const sourceLine = inner.slice(0, firstLineEnd);
  const legacySource = sourceLine.match(/^From session "([\s\S]*)":$/);
  const fromSessionName = attributes.from_session_name ?? legacySource?.[1];
  if (fromSessionName === undefined) return undefined;

  let body = inner.slice(firstLineEnd + 1);
  if (kind === 'request') {
    const replyInstruction =
      `\n\nReply with session_reply(target_session_id="${fromSessionId}", ` +
      `in_reply_to="${messageId}", text=...).`;
    if (!body.endsWith(replyInstruction)) return undefined;
    body = body.slice(0, -replyInstruction.length);
  }

  return {
    direction: 'incoming',
    messageId: unescapeText(messageId),
    fromSessionId: unescapeText(fromSessionId),
    fromSessionName: unescapeText(fromSessionName),
    toSessionId: unescapeText(toSessionId),
    kind: kind as SessionMailboxKind,
    text: unescapeText(body),
    ...(attributes.correlation_id
      ? { correlationId: unescapeText(attributes.correlation_id) }
      : {}),
  };
}

export function parseSessionMailboxSentNoteData(
  value: unknown,
): SessionMailboxSentNoteData | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.messageId !== 'string' ||
    typeof value.targetSessionId !== 'string' ||
    typeof value.targetSessionName !== 'string' ||
    typeof value.text !== 'string' ||
    !SESSION_MAILBOX_KINDS.includes(value.kind as SessionMailboxKind) ||
    (value.disposition !== 'turn_started' && value.disposition !== 'queued')
  ) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    targetSessionId: value.targetSessionId,
    targetSessionName: value.targetSessionName,
    kind: value.kind as SessionMailboxKind,
    text: value.text,
    disposition: value.disposition,
  };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/(?:^| )([a-z_]+)="([^"]*)"/g)) {
    const key = match[1];
    const attributeValue = match[2];
    if (key !== undefined && attributeValue !== undefined) attributes[key] = attributeValue;
  }
  return attributes;
}

function unescapeText(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
