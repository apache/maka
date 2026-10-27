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

import type { Catalog } from '../../../../plugins/shared/locale.js';

export const recallMessages = {
  'Search conversations': ['Search conversations', '搜索会话', '搜尋對話'],
  'Close conversation search': ['Close conversation search', '关闭会话搜索', '關閉對話搜尋'],
  'Search conversation history': ['Search conversation history', '搜索会话历史', '搜尋對話歷史'],
  'Search every conversation you can read, including archived conversations.': [
    'Search every conversation you can read, including archived conversations.',
    '搜索所有可读取的会话，包括已归档会话。',
    '搜尋所有可讀取的對話，包括已封存對話。',
  ],
  'Search titles and messages…': [
    'Search titles and messages…',
    '搜索标题和消息…',
    '搜尋標題和訊息…',
  ],
  'Type words to search conversation history.': [
    'Type words to search conversation history.',
    '输入关键词，搜索会话历史。',
    '輸入關鍵字，搜尋對話歷史。',
  ],
  'Searching conversations…': ['Searching conversations…', '正在搜索会话…', '正在搜尋對話…'],
  'Conversation search ended without a result.': [
    'Conversation search ended without a result.',
    '会话搜索结束，但未返回结果。',
    '對話搜尋結束，但未傳回結果。',
  ],
  'Search is incomplete. Available matches are shown.': [
    'Search is incomplete. Available matches are shown.',
    '部分会话未能搜索，已显示可用结果。',
    '部分對話未能搜尋，已顯示可用結果。',
  ],
  'Opening conversation…': ['Opening conversation…', '正在打开会话…', '正在開啟對話…'],
  'No matching conversations or messages.': [
    'No matching conversations or messages.',
    '没有匹配的会话或消息。',
    '沒有符合的對話或訊息。',
  ],
  'Open matching passage in {title}': [
    'Open matching passage in {title}',
    '打开“{title}”中的匹配内容',
    '開啟「{title}」中的符合內容',
  ],
  'Conversation navigation was cancelled.': [
    'Conversation navigation was cancelled.',
    '会话导航已取消。',
    '對話導覽已取消。',
  ],
  'History navigation was cancelled.': [
    'History navigation was cancelled.',
    '历史导航已取消。',
    '歷史導覽已取消。',
  ],
  'The original message could not be verified.': [
    'The original message could not be verified.',
    '无法验证原始消息。',
    '無法驗證原始訊息。',
  ],
  'The original message is no longer available.': [
    'The original message is no longer available.',
    '原始消息已不可用。',
    '原始訊息已無法使用。',
  ],
  'The original message is not available in this conversation.': [
    'The original message is not available in this conversation.',
    '此会话中找不到原始消息。',
    '此對話中找不到原始訊息。',
  ],
  'This turn is no longer available.': [
    'This turn is no longer available.',
    '此轮对话已不可用。',
    '此輪對話已無法使用。',
  ],
  'The read confirmation is still unknown.': [
    'The read confirmation is still unknown.',
    '已读确认的结果仍未知。',
    '已讀確認的結果仍未知。',
  ],
  'Read confirmation rejected: {reason}': [
    'Read confirmation rejected: {reason}',
    '已读确认被拒绝：{reason}',
    '已讀確認遭拒：{reason}',
  ],
} as const satisfies Catalog;
