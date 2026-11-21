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
  'Start dictation': ['Start dictation', '开始听写', '開始聽寫'],
  'Dictation uses the model connection from General settings.': [
    'Dictation uses the model connection from General settings.',
    '与聊天共用听写服务。可在「常规 → 语音听写」中选择模型连接。',
    '與聊天共用聽寫服務。可在「一般 → 語音聽寫」中選擇模型連線。',
  ],
  'Listen when Quick Tools opens': [
    'Listen when Quick Tools opens',
    '打开快捷面板时听写',
    '打開快捷面板時聽寫',
  ],
  'Preparing microphone…': ['Preparing microphone…', '正在准备麦克风…', '正在準備麥克風…'],
  Recording: ['Recording', '录音中', '錄音中'],
  'Recording finished': ['Recording finished', '录音已结束', '錄音已結束'],
  'Transcribing…': ['Transcribing…', '正在转写…', '正在轉寫…'],
  'Cancel dictation': ['Cancel dictation', '取消听写', '取消聽寫'],
  'Transcribe and send': ['Transcribe and send', '转写并发送', '轉寫並傳送'],
  'Finish and transcribe': ['Finish and transcribe', '结束并转写', '結束並轉寫'],
  'Transcription failed': ['Transcription failed', '转写失败', '轉寫失敗'],
  'Retry transcription': ['Retry transcription', '重试转写', '重試轉寫'],
  'Transcript ready': ['Transcript ready', '听写文字待插入', '聽寫文字待插入'],
  'Insert transcript': ['Insert transcript', '插入听写文字', '插入聽寫文字'],
  'Saved dictation key': ['Saved dictation key', '已保存的听写密钥', '已儲存的聽寫密鑰'],
  'Choose a model connection': ['Choose a model connection', '选择模型连接', '選擇模型連線'],
  'Dictation is off': ['Dictation is off', '听写已关闭', '聽寫已關閉'],
  'Choose a DeepSeek connection in dictation settings.': [
    'Choose a DeepSeek connection in dictation settings.',
    '请在听写设置中选择 DeepSeek 连接。',
    '請在聽寫設定中選擇 DeepSeek 連線。',
  ],
  'Enable dictation': ['Enable dictation', '启用语音听写', '啟用語音聽寫'],
  'Use the microphone in chats and Quick Tools.': [
    'Use the microphone in chats and Quick Tools.',
    '在聊天和快捷面板中使用麦克风。',
    '在聊天和快捷面板中使用麥克風。',
  ],
  'Dictation uses the API key from this connection.': [
    'Dictation uses the API key from this connection.',
    '听写使用此连接的 API Key。',
    '聽寫使用此連線的 API Key。',
  ],
  'Transcription service': ['Transcription service', '听写服务', '聽寫服務'],
  'Add a DeepSeek connection': [
    'Add a DeepSeek connection',
    '添加 DeepSeek 连接',
    '新增 DeepSeek 連線',
  ],
  'Model connection': ['Model connection', '模型连接', '模型連線'],
  'Use for dictation': ['Use for dictation', '用于听写', '用於聽寫'],
  'Saving will enable dictation with this connection.': [
    'Saving will enable dictation with this connection.',
    '保存后启用听写，并使用此连接。',
    '儲存後啟用聽寫，並使用此連線。',
  ],
  'Dictation settings are being saved.': [
    'Dictation settings are being saved.',
    '正在保存听写设置。',
    '正在儲存聽寫設定。',
  ],
  'Enter a DeepSeek API key to enable dictation.': [
    'Enter a DeepSeek API key to enable dictation.',
    '请输入 DeepSeek API Key 以启用听写。',
    '請輸入 DeepSeek API Key 以啟用聽寫。',
  ],
  'Connection saved and dictation enabled.': [
    'Connection saved and dictation enabled.',
    '连接已保存，听写已启用。',
    '連線已儲存，聽寫已啟用。',
  ],
  Dictation: ['Dictation', '语音听写', '語音聽寫'],
  'Dictate a message': ['Dictate a message', '语音听写', '語音聽寫'],
  'No speech detected': ['No speech detected', '没有识别到语音', '沒有辨識到語音'],
  'Draft changed. Dictation: {text}': [
    'Draft changed. Dictation: {text}',
    '草稿已更改。听写内容：{text}',
    '草稿已變更。聽寫內容：{text}',
  ],
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
  'Compact context': ['Compact context', '压缩上下文', '壓縮上下文'],
  'Keep in context': ['Keep in context', '保留重点', '保留重點'],
  'Continue with model': ['Continue with model', '接手模型', '接手模型'],
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
  '{percent}% remaining': ['{percent}% remaining', '剩余 {percent}%', '剩餘 {percent}%'],
  Usage: ['Usage', '用量余量', '用量餘額'],
  Composer: ['Composer', '输入栏', '輸入列'],
  Reset: ['Reset', '恢复默认', '恢復預設'],
  'Toolbar layout': ['Toolbar layout', '工具栏布局', '工具列版面'],
  'Drag widgets to change their order or move them across the spacer.': [
    'Drag widgets to change their order or move them across the spacer.',
    '拖拽小组件调整顺序，拖过空白分隔可在左、右两侧间移动。',
    '拖曳小工具調整順序，拖過空白分隔可在左、右兩側間移動。',
  ],
  'Composer toolbar layout': ['Composer toolbar layout', '输入栏工具栏布局', '輸入列工具列版面'],
  Spacer: ['Spacer', '空白分隔', '空白分隔'],
  'Drag widgets to reorder, or select one to move with buttons.': [
    'Drag widgets to reorder, or select one to move with buttons.',
    '拖拽调整顺序，或点选某项后用按钮微调。',
    '拖曳調整順序，或點選某項後用按鈕微調。',
  ],
  '{name} · Left': ['{name} · Left', '{name} · 左侧', '{name} · 左側'],
  '{name} · Right': ['{name} · Right', '{name} · 右侧', '{name} · 右側'],
  'Move left': ['Move left', '左移', '左移'],
  'Move right': ['Move right', '右移', '右移'],
  'Context usage': ['Context usage', '上下文占用', '上下文佔用'],
  'Show how much of the model context window is in use.': [
    'Show how much of the model context window is in use.',
    '显示当前对话已占用的模型上下文比例。',
    '顯示目前對話已佔用的模型上下文比例。',
  ],
  '70%+': ['70%+', '≥70%', '≥70%'],
  'Show remaining usage when the selected model connection reports it.': [
    'Show remaining usage when the selected model connection reports it.',
    '仅在当前模型所属连接或外部代理提供余量数据时显示。',
    '僅在目前模型所屬連線或外部代理提供餘額資料時顯示。',
  ],
} satisfies Catalog;
