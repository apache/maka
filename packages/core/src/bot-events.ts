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

import type { BotProvider } from './bot-chat-settings.js';

export type BotPlatform = BotProvider;

export interface BotAttachmentRef {
  kind: 'image' | 'file' | 'voice';
  url?: string;
  fileId?: string;
  mimeType?: string;
}

/**
 * PR-BOT-NON-TEXT-MESSAGE-ACK-0 (external bot research): the kind of non-text
 * payload Telegram delivered alongside (or instead of) text. Used so
 * the handler can send a helpful "Maka 现在只读文字" ack instead of
 * silently dropping a photo / voice / sticker message. NOT a request
 * to ingest the binary — Maka does not yet have multi-modal input.
 *
 * `unknown` covers Telegram message subtypes we did not enumerate
 * (location, contact, poll, video_note, ...). Those still need an ack
 * because the user typed nothing the bot can act on.
 */
export type BotAttachmentKind =
  | 'photo'
  | 'voice'
  | 'sticker'
  | 'document'
  | 'video'
  | 'audio'
  | 'animation'
  | 'unknown';

export interface BotMessageEvent {
  platform: BotPlatform;
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
  attachments?: BotAttachmentRef[];
  /**
   * PR-BOT-NON-TEXT-MESSAGE-ACK-0: when the inbound message carried a
   * non-text payload (photo / voice / etc.), this records the kind so
   * the handler can decide whether to ack or drop. `undefined` means
   * "text-only message" — the default and most common case.
   */
  attachmentKind?: BotAttachmentKind;
}

/**
 * PR-BOT-NON-TEXT-MESSAGE-ACK-0: fixed copy for the "we only handle
 * text" ack. Kind-aware so a voice message and a sticker get slightly
 * different copy without diluting the core message. Exported so the
 * handler can use it AND a contract test can pin it.
 */
// bot-channel notices follow the bot audience language; localization tracked under #2672
export function nonTextMessageAck(kind: BotAttachmentKind): string {
  switch (kind) {
    case 'photo':
      return 'Maka 目前只能读文字。如果想问关于这张图的问题，请把内容直接写出来（caption 里也可以）。';
    case 'voice':
    case 'audio':
      return 'Maka 目前不能识别语音消息。请把要问的内容用文字发过来。';
    case 'sticker':
      return 'Maka 目前不会处理贴纸。如果有问题，请直接用文字描述。';
    case 'video':
    case 'animation':
      return 'Maka 目前不会处理视频。如果想讨论视频内容，请把要点用文字写一下。';
    case 'document':
      return 'Maka 目前不能直接读取附件文件。如果文件里有问题，请把内容粘到消息里。';
    case 'unknown':
    default:
      return 'Maka 目前只能处理文字消息。请把要问的内容用文字发过来。';
  }
}

export function botDisplayLabel(platform: BotPlatform): string {
  switch (platform) {
    case 'telegram':
      return 'Telegram';
    case 'feishu':
      return '飞书';
    case 'wecom':
      return '企业微信';
    case 'wechat':
      return '微信';
    case 'discord':
      return 'Discord';
    case 'dingtalk':
      return '钉钉';
    case 'qq':
      return 'QQ';
    case 'slack':
      return 'Slack';
  }
}

export function botConversationKey(message: Pick<BotMessageEvent, 'platform' | 'chatId'>): string {
  return `${message.platform}:${message.chatId}`;
}

/**
 * PR-BOT-INCOMING-IDEMPOTENCY-0 (external bot research): platform bridges
 * can redeliver the same inbound message during reconnect / polling
 * recovery. The runtime needs a stable event key before creating a
 * Maka turn or sending a transient ack, otherwise a repeated platform
 * update can produce duplicate agent replies.
 *
 * Scope deliberately stays at platform + chat + source message id. The
 * id is only trusted as an idempotency key inside that chat; it is NOT
 * a permission token and does not grant access to message history.
 */
export function botSourceEventKey(
  message: Pick<BotMessageEvent, 'platform' | 'chatId' | 'sourceMessageId'>,
): string | undefined {
  const sourceMessageId = message.sourceMessageId.trim();
  if (!sourceMessageId) return undefined;
  return `${message.platform}:${message.chatId}:${sourceMessageId}`;
}

/** DM-only commands; a group shares one conversation key, so reset must not affect every member. */
export const BOT_PLAINTEXT_RESET_COMMANDS: ReadonlyArray<string> = Object.freeze([
  'restart',
  'reset',
  '/restart',
  '/reset',
  '/new',
  '/newchat',
  'new chat',
  '重启',
  '重置',
  '重新开始',
  '新对话',
  '新会话',
]);

export function isPlaintextResetCommand(
  message: Pick<BotMessageEvent, 'text' | 'isGroup'>,
): boolean {
  return isPlaintextCommand(message, BOT_PLAINTEXT_RESET_COMMANDS);
}

export const BOT_PLAINTEXT_HELP_COMMANDS: ReadonlyArray<string> = Object.freeze([
  'help',
  '/help',
  '?',
  '/?',
  '帮助',
  '/帮助',
]);

export function isPlaintextHelpCommand(
  message: Pick<BotMessageEvent, 'text' | 'isGroup'>,
): boolean {
  return isPlaintextCommand(message, BOT_PLAINTEXT_HELP_COMMANDS);
}

function isPlaintextCommand(
  message: Pick<BotMessageEvent, 'text' | 'isGroup'>,
  commands: ReadonlyArray<string>,
): boolean {
  if (message.isGroup) return false;
  const trimmed = message.text.normalize('NFC').trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return commands.includes(trimmed);
}

export function plaintextHelpReply(): string {
  return [
    'Maka 机器人帮助',
    '',
    '· 直接发文字消息就能和 Maka 对话；回复会挂在你的提问下面。',
    '· 想清空当前任务另起一个，发：restart / reset / 重置 / 重启 / 新对话。',
    '· 群里不响应 plaintext 重置指令（避免一个成员把整群的任务清掉）。',
    '· 长回复会自动拆成多条，第一条挂在你的提问下面。',
  ].join('\n');
}

export function formatBotMessageForSession(
  message: Pick<BotMessageEvent, 'platform' | 'userName' | 'text'>,
): string {
  return `[${botDisplayLabel(message.platform)}:${sanitizeBotUserName(message.userName)}] ${message.text.trim()}`;
}

function sanitizeBotUserName(value: string): string {
  return (
    value
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
      .replace(/[\p{Cf}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'unknown'
  );
}

/**
 * Non-error `BotStatus.reason` values. These states have their own UI surface,
 * so an error readout must not repeat them as failures.
 */
const BOT_BENIGN_STATUS_REASONS: ReadonlySet<string> = new Set([
  'disabled',
  'stopped',
  'no-token',
  'missing-feishu-credentials',
  'feishu-domain-required',
  'feishu-events-not-connected',
  'scaffold-only',
  'unimplemented',
]);

/**
 * `BotStatus.reason` stays a stable code; presenters own the copy. Benign
 * states yield `undefined` so they never overwrite a real error readout.
 */
export function botStatusErrorReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  if (trimmed.length === 0 || BOT_BENIGN_STATUS_REASONS.has(trimmed)) return undefined;
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}
