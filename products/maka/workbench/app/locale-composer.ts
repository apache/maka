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
  'Search files…': ['Search files…', '搜索文件…', '搜尋檔案…'],
  'Search skills…': ['Search skills…', '搜索技能…', '搜尋技能…'],
  'Add to message': ['Add to message', '添加到消息', '新增至訊息'],
  'Reference a workspace file': ['Reference a workspace file', '引用工作区文件', '參照工作區檔案'],
  'Use a skill': ['Use a skill', '使用技能', '使用技能'],
  'Message commands': ['Message commands', '消息命令', '訊息命令'],
  'Searching files…': ['Searching files…', '正在搜索文件…', '正在搜尋檔案…'],
  'Loading skills…': ['Loading skills…', '正在加载技能…', '正在載入技能…'],
  'No matching files.': ['No matching files.', '没有匹配的文件。', '沒有相符的檔案。'],
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
