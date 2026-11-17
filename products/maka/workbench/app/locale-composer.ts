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

export const composerMessages = {
  'Suggested message: {message}': [
    'Suggested message: {message}',
    '消息建议：{message}',
    '訊息建議：{message}',
  ],
  'Use suggested message': ['Use suggested message', '使用建议消息', '使用建議訊息'],
  'Press Tab to accept': ['Press Tab to accept', '按 Tab 使用', '按 Tab 使用'],
  'Compacting context… ({duration})': [
    'Compacting context… ({duration})',
    '正在压缩（{duration}）',
    '正在壓縮（{duration}）',
  ],
  'Context compacted ({duration})': [
    'Context compacted ({duration})',
    '上下文已压缩（{duration}）',
    '上下文已壓縮（{duration}）',
  ],
  'Instructions for this compaction only': [
    'Instructions for this compaction only',
    '提示词仅用于本次压缩',
    '提示詞僅用於本次壓縮',
  ],
  'One-time compaction prompt': [
    'One-time compaction prompt',
    '一次性压缩提示词',
    '一次性壓縮提示詞',
  ],
  'Cancel compaction': ['Cancel compaction', '取消压缩', '取消壓縮'],
  'Retry compaction prompt': [
    'Retry compaction prompt',
    '重新加载压缩提示词',
    '重新載入壓縮提示詞',
  ],
  'Compact now': ['Compact now', '开始压缩', '開始壓縮'],
  'Background tasks': ['Background tasks', '后台任务', '背景任務'],
  '{count} running': ['{count} running', '{count} 个运行中', '{count} 個執行中'],
  '{count} finished': ['{count} finished', '{count} 个已结束', '{count} 個已結束'],
  'Open output of {command}': [
    'Open output of {command}',
    '查看 {command} 的输出',
    '檢視 {command} 的輸出',
  ],
  'Stop {command}': ['Stop {command}', '停止 {command}', '停止 {command}'],
  'Stop this background task?': [
    'Stop this background task?',
    '停止这个后台任务？',
    '停止這個背景任務？',
  ],
  'The agent sees it as stopped and may start it again.': [
    'The agent sees it as stopped and may start it again.',
    'Agent 会看到它已停止，之后可能重新启动它。',
    'Agent 會看到它已停止，之後可能重新啟動它。',
  ],
  'Could not stop the background task.': [
    'Could not stop the background task.',
    '无法停止后台任务。',
    '無法停止背景任務。',
  ],
  'An earlier terminal action is still being confirmed. Try again shortly.': [
    'An earlier terminal action is still being confirmed. Try again shortly.',
    '之前的终端操作仍在确认中，请稍后再试。',
    '先前的終端操作仍在確認中，請稍後再試。',
  ],
  'Refresh background tasks': ['Refresh background tasks', '刷新后台任务', '重新整理背景任務'],
  'Could not load background tasks. Refresh to try again.': [
    'Could not load background tasks. Refresh to try again.',
    '无法加载后台任务，请刷新重试。',
    '無法載入背景任務，請重新整理後再試。',
  ],
  'Search files…': ['Search files…', '搜索文件…', '搜尋檔案…'],
  'Search skills…': ['Search skills…', '搜索技能…', '搜尋技能…'],
  Skills: ['Skills', '技能', '技能'],
  'Add to message': ['Add to message', '添加到消息', '新增至訊息'],
  'Reference a workspace file': ['Reference a workspace file', '引用工作区文件', '參照工作區檔案'],
  'Use a skill': ['Use a skill', '使用技能', '使用技能'],
  'Commands and skills': ['Commands and skills', '命令和技能', '命令和技能'],
  'Message commands': ['Message commands', '消息命令', '訊息命令'],
  'Searching files…': ['Searching files…', '正在搜索文件…', '正在搜尋檔案…'],
  'Loading skills…': ['Loading skills…', '正在加载技能…', '正在載入技能…'],
  'No matching files.': ['No matching files.', '没有匹配的文件。', '沒有相符的檔案。'],
  'No matching references': ['No matching references', '没有匹配结果', '沒有相符的結果'],
  'No matching skills.': ['No matching skills.', '没有匹配的技能。', '沒有相符的技能。'],
  'No matching commands.': ['No matching commands.', '没有匹配的命令。', '沒有相符的命令。'],
  'Choose a model to browse skills.': [
    'Choose a model to browse skills.',
    '选择模型后即可浏览技能。',
    '選擇模型後即可瀏覽技能。',
  ],
  'This file name cannot be inserted as text.': [
    'This file name cannot be inserted as text.',
    '此文件名无法作为文本引用。',
    '此檔案名稱無法以文字參照。',
  ],
  'Compact conversation': ['Compact conversation', '压缩对话上下文', '壓縮對話上下文'],
  'Summarize context for the next request': [
    'Summarize context for the next request',
    '为下一次请求整理上下文摘要',
    '為下一次請求整理上下文摘要',
  ],
  'Wait for the current run before compacting.': [
    'Wait for the current run before compacting.',
    '请等当前运行结束后再压缩上下文。',
    '請等目前執行結束後再壓縮上下文。',
  ],
  'Context compaction rejected: {reason}': [
    'Context compaction rejected: {reason}',
    '上下文压缩被拒绝：{reason}',
    '上下文壓縮遭拒絕：{reason}',
  ],
  'Choose a model before compacting.': [
    'Choose a model before compacting.',
    '请先选择用于压缩上下文的模型。',
    '請先選擇用於壓縮上下文的模型。',
  ],
} satisfies Catalog;
