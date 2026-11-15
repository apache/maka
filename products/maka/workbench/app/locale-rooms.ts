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

export const roomMessages = {
  Rooms: ['Rooms', '房间', '房間'],
  'More navigation': ['Show more', '更多', '更多'],
  'Less navigation': ['Show less', '收起', '收合'],
  'Workspace mode': ['Workspace mode', '工作模式', '工作模式'],
  'New room': ['New room', '新建房间', '新增房間'],
  'Room name': ['Room name', '房间名称', '房間名稱'],
  'Message room': ['Message room', '发送到房间', '傳送到房間'],
  'Message this room…': ['Message this room…', '发条消息…', '傳送訊息…'],
  'Search sessions…': ['Search sessions…', '搜索会话…', '搜尋會話…'],
  'Mention a session': ['Mention a session', '@ 会话', '@ 會話'],
  'Remove mention {name}': ['Remove mention {name}', '移除 @ {name}', '移除 @ {name}'],
  'No matching sessions': ['No matching sessions', '没有匹配的会话', '沒有相符的會話'],
  'Reply to message': ['Reply to message', '回复消息', '回覆訊息'],
  'Cancel reply': ['Cancel reply', '取消回复', '取消回覆'],
  'View replied message': ['View replied message', '查看回复的消息', '檢視回覆的訊息'],
  'Earlier messages': ['Earlier messages', '更早的消息', '較早的訊息'],
  'Select a room': ['Select a room', '选择一个房间', '選擇一個房間'],
  'Rename room': ['Rename room', '重命名房间', '重新命名房間'],
  'Confirm delete room': ['Confirm delete room', '确认删除房间', '確認刪除房間'],
  'Delete room': ['Delete room', '删除房间', '刪除房間'],
  'Room actions': ['Room actions', '房间操作', '房間操作'],
  'Delete “{title}” and its messages?': [
    'Delete “{title}” and its messages?',
    '删除“{title}”及其消息？',
    '刪除「{title}」及其訊息？',
  ],
  'Room messages': ['Room messages', '房间消息', '房間訊息'],
  'Could not load rooms.': ['Could not load rooms.', '无法加载房间。', '無法載入房間。'],
  'Could not load room messages.': [
    'Could not load room messages.',
    '无法加载房间消息。',
    '無法載入房間訊息。',
  ],
  'Could not save the room draft.': [
    'Could not save the room draft.',
    '无法保存房间草稿。',
    '無法儲存房間草稿。',
  ],
  'Could not send to the room.': [
    'Could not send to the room.',
    '发送到房间失败。',
    '傳送到房間失敗。',
  ],
  'Mention delivery failed: {reason}': [
    'Mention delivery failed: {reason}',
    '@ 送达失败：{reason}',
    '@ 傳遞失敗：{reason}',
  ],
} as const satisfies Catalog;
