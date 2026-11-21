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
  'Workspace mode': ['Workspace mode', '工作模式', '工作模式'],
  'New room': ['New room', '新建房间', '新增房間'],
  'Room name': ['Room name', '房间名称', '房間名稱'],
  'Room topic (optional)': [
    'Room topic (optional)',
    '房间主题 / 目标（可选）',
    '房間主題 / 目標（選填）',
  ],
  'Edit room topic': ['Edit room topic', '编辑房间主题', '編輯房間主題'],
  'Room topic': ['Room topic', '房间主题', '房間主題'],
  'Change workspace': ['Change workspace', '更换工作区', '更換工作區'],
  'Choose workspace': ['Choose workspace', '选择工作区', '選擇工作區'],
  'Message room': ['Message room', '发送到房间', '傳送到房間'],
  'Message this room…': [
    'Message this room…',
    '发条消息，输入 @ 点名成员…',
    '傳送訊息，輸入 @ 提及成員…',
  ],
  'Search sessions…': ['Search sessions…', '搜索会话…', '搜尋會話…'],
  'Search rooms…': ['Search rooms…', '搜索房间…', '搜尋房間…'],
  'Search messages…': ['Search messages…', '搜索房间消息…', '搜尋房間訊息…'],
  'Search messages': ['Search messages', '搜索消息', '搜尋訊息'],
  'No matching messages': ['No matching messages', '没有匹配的消息', '沒有相符的訊息'],
  'Mention a session': ['Mention a session', '@ 会话', '@ 會話'],
  'Mention all members': ['Mention all members', '@ 全体成员', '@ 全體成員'],
  'All room members': ['All room members', '全体成员', '全體成員'],
  'Room members': ['Room members', '房间成员', '房間成員'],
  'Other conversations': ['Other conversations', '其他会话', '其他會話'],
  'Remove mention {name}': ['Remove mention {name}', '移除 @ {name}', '移除 @ {name}'],
  'No matching sessions': ['No matching sessions', '没有匹配的会话', '沒有相符的會話'],
  'Reply to message': ['Reply to message', '回复消息', '回覆訊息'],
  'Cancel reply': ['Cancel reply', '取消回复', '取消回覆'],
  'View replied message': ['View replied message', '查看回复的消息', '檢視回覆的訊息'],
  'Earlier messages': ['Earlier messages', '更早的消息', '較早的訊息'],
  'Newer messages': ['Newer messages', '更新的消息', '較新的訊息'],
  'Select a room': ['Select a room', '选择一个房间', '選擇一個房間'],
  'Rename room': ['Rename room', '重命名房间', '重新命名房間'],
  'Pin room': ['Pin room', '置顶房间', '釘選房間'],
  'Unpin room': ['Unpin room', '取消置顶', '取消釘選'],
  'Archive room': ['Archive room', '归档房间', '封存房間'],
  'Restore room': ['Restore room', '恢复房间', '還原房間'],
  'Active rooms': ['Active', '活跃', '進行中'],
  'Archived rooms': ['Archived', '已归档', '已封存'],
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
  Members: ['Members', '成员', '成員'],
  'Add member': ['Add member', '添加成员', '新增成員'],
  'Remove member': ['Remove member', '移出房间', '移出房間'],
  'Spawn from preset': ['Spawn from preset', '从预设召唤新角色', '從預設召喚新角色'],
  'Use isolated worktree': [
    'Use isolated worktree',
    '使用独立 Git worktree',
    '使用獨立 Git worktree',
  ],
  'No members yet': [
    'No members yet',
    '暂无成员，发送时 @ 会话即可自动加入',
    '尚無成員，傳送時 @ 會話即可自動加入',
  ],
  'Pinned messages': ['Pinned', '置顶', '釘選'],
  'Pin message': ['Pin message', '置顶消息', '釘選訊息'],
  'Unpin message': ['Unpin message', '取消置顶', '取消釘選'],
  'Edit message': ['Edit message', '编辑消息', '編輯訊息'],
  'Delete message': ['Delete message', '撤回消息', '收回訊息'],
  Edited: ['edited', '已编辑', '已編輯'],
  'Message deleted': ['Message deleted', '消息已撤回', '訊息已收回'],
  'Delivery queued': ['Queued', '排队中', '排隊中'],
  'Delivery working': ['Working…', '思考中…', '思考中…'],
  'Delivery waiting': ['Needs attention', '等待确认', '等待確認'],
  'Delivery replied': ['Replied', '已回复', '已回覆'],
  'Delivery silent': ['Finished without replying', '已完成但未发言', '已完成但未發言'],
  'Delivery failed': ['Run failed', '运行失败', '執行失敗'],
  'Delivery stopped': ['Stopped', '已停止', '已停止'],
  'Inspect session': ['Inspect', '查看私聊', '檢視對話'],
  'Jump to reply': ['View reply', '查看回复', '檢視回覆'],
  'Waiting for your input': [
    '{names} waiting for your input',
    '{names} 正在等待你的确认',
    '{names} 正在等待你的確認',
  ],
  'Open to respond': ['Respond', '去处理', '去處理'],
  'Queue delivery': ['Queue', '任务后排队', '任務後排隊'],
  'Steer delivery': ['Steer', '实时插话', '即時插話'],
  'No mentions notice': [
    'No one mentioned — message will be saved as a room note',
    '未 @ 成员，消息仅记录到房间',
    '未 @ 成員，訊息僅記錄到房間',
  ],
  'New messages available': ['New messages', '有新消息', '有新訊息'],
  Today: ['Today', '今天', '今天'],
  Yesterday: ['Yesterday', '昨天', '昨天'],
  'Deleted session': ['Deleted session', '已删除的会话', '已刪除的會話'],
  You: ['You', '我', '我'],
  'From room human': [
    '{room} · You mentioned this session',
    '{room} · 你在房间里 @ 了此会话',
    '{room} · 你在房間裡 @ 了此會話',
  ],
  'From room agent': [
    '{room} · Mentioned by {sender}',
    '{room} · 由 {sender} 在房间里 @',
    '{room} · 由 {sender} 在房間裡 @',
  ],
  'Reason model unavailable': [
    'No model configured on target session',
    '目标会话未配置可用模型',
    '目標會話未設定可用模型',
  ],
  'Reason self mention': ['Cannot mention itself', '不能 @ 自己', '不能 @ 自己'],
  'Reason hop limit': [
    'Auto-mention loop limit reached — human input needed',
    '已达自动互 @ 轮次上限，需人工介入',
    '已達自動互 @ 輪次上限，需人工介入',
  ],
  'Reason reply tool unavailable': [
    'Target session cannot post back (SessionSend disabled)',
    '目标会话未启用 SessionSend，无法回房发言',
    '目標會話未啟用 SessionSend，無法回房發言',
  ],
  'Reason session unavailable': [
    'Target session was archived or removed',
    '目标会话已归档或不存在',
    '目標會話已封存或不存在',
  ],
  'Reason not your worker': [
    'Permission denied for target session',
    '无权唤醒目标会话',
    '無權喚醒目標會話',
  ],
  'Reason turn stopped': ['Target run was stopped', '目标回合已停止', '目標回合已停止'],
  'Reason room has no backend': [
    'Cannot mention another Room',
    '不能 @ 另一个房间',
    '不能 @ 另一個房間',
  ],
} as const satisfies Catalog;
