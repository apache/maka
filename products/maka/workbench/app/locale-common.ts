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
import {
  msg_cancel,
  msg_checklistRetry,
  msg_closeModels,
  msg_copy,
  msg_helpNew,
  msg_models,
  msg_thinkingUnavailable,
} from '../../../../plugins/shared/locale-messages.js';

/** Shared interface terms have one translation owner across every surface. */
export const commonMessages = {
  'Abandon unconfirmed {method}': [
    'Abandon unconfirmed {method}',
    '放弃尚未确认的 {method}',
    '放棄尚未確認的 {method}',
  ],
  'Ask Maka': ['Ask Maka', '询问 Maka', '詢問 Maka'],
  'Ask a follow-up': ['Ask a follow-up', '继续询问', '繼續詢問'],
  'No model is available': ['No model is available', '还没有可用的模型', '還沒有可用的模型'],
  'Choose Model': ['Choose Model', '选择模型', '選擇模型'],
  'Connection interrupted. Reconnect to continue; your draft is kept.': [
    'Connection interrupted. Reconnect to continue; your draft is kept.',
    '连接已中断，重新连接后可继续。草稿已保留。',
    '連線已中斷，重新連線後可繼續。草稿已保留。',
  ],
  'Conversation data is temporarily unavailable. Try reconnecting.': [
    'Conversation data is temporarily unavailable. Try reconnecting.',
    '暂时无法读取会话数据，请尝试重新连接。',
    '暫時無法讀取對話資料，請嘗試重新連線。',
  ],
  'Conversation list is temporarily unavailable. Try reconnecting.': [
    'Conversation list is temporarily unavailable. Try reconnecting.',
    '暂时无法读取会话列表，请尝试重新连接。',
    '暫時無法讀取對話清單，請嘗試重新連線。',
  ],
  'Maka Bot could not be opened': [
    'Maka Bot could not be opened',
    '无法打开 Maka Bot',
    '無法開啟 Maka Bot',
  ],
  'Open Maka': ['Open Maka', '打开 Maka', '打開 Maka'],
  'Open in Main Window': ['Open in Main Window', '在主窗口打开', '在主視窗開啟'],
  'Quit Maka': ['Quit Maka', '退出 Maka', '結束 Maka'],
  'The Alt+Space shortcut is unavailable': [
    'The Alt+Space shortcut is unavailable',
    'Alt+Space 快捷键不可用',
    'Alt+Space 快捷鍵無法使用',
  ],
  'The Option+Space shortcut is unavailable': [
    'The Option+Space shortcut is unavailable',
    'Option+Space 快捷键不可用',
    'Option+Space 快捷鍵無法使用',
  ],
  'The action outcome is unknown. Check the current state before trying again.': [
    'The action outcome is unknown. Check the current state before trying again.',
    '暂时无法确认操作结果，请先检查当前状态再决定是否重试。',
    '暫時無法確認操作結果，請先檢查目前狀態再決定是否重試。',
  ],
  Cancel: msg_cancel,
  'Choose workspace': ['Choose workspace', '选择工作区', '選擇工作區'],
  Close: msg_closeModels,
  'Close · Esc': ['Close · Esc', '关闭 · Esc', '關閉 · Esc'],
  Copy: msg_copy,
  'Connections & models': ['Connections & models', '连接与模型', '連線與模型'],
  'Add a model connection': ['Add a model connection', '添加模型连接', '新增模型連線'],
  'Conversations need a model. Add a connection with your API key or account first.': [
    'Conversations need a model. Add a connection with your API key or account first.',
    '对话需要一个模型。请先用 API 密钥或账号添加一个连接。',
    '對話需要一個模型。請先用 API 金鑰或帳號新增一個連線。',
  ],
  'Draft could not be saved or restored. Its existing contents are preserved.': [
    'Draft could not be saved or restored. Its existing contents are preserved.',
    '无法保存或恢复草稿。已有内容已保留。',
    '無法儲存或還原草稿。既有內容已保留。',
  ],
  Edit: ['Edit', '编辑', '編輯'],
  Failed: ['Failed', '失败', '失敗'],
  'Loading…': ['Loading…', '正在加载…', '正在載入…'],
  Models: msg_models,
  'New conversation': msg_helpNew,
  'Original image': ['Original image', '原始图片', '原始圖片'],
  'Press Ctrl+C again to exit.': [
    'Press Ctrl+C again to exit.',
    '再按一次 Ctrl+C 退出。',
    '再按一次 Ctrl+C 結束。',
  ],
  'Stop the current task?': [
    'Stop the current task?',
    '要停止当前任务吗？',
    '要停止目前的工作嗎？',
  ],
  'The task will keep running unless you choose to stop it.': [
    'The task will keep running unless you choose to stop it.',
    '只有选择停止，才会中断当前任务。',
    '只有選擇停止，才會中斷目前的工作。',
  ],
  'Stop task': ['Stop task', '停止任务', '停止工作'],
  Retry: msg_checklistRetry,
  Save: ['Save', '保存', '儲存'],
  Skills: ['Skills', '技能', '技能'],
  'shared · view only': ['shared · view only', '共享 · 仅查看', '共用 · 僅檢視'],
  'Stop process': ['Stop process', '停止进程', '停止處理程序'],
  Terminal: ['Terminal', '终端', '終端機'],
  Unavailable: msg_thinkingUnavailable,
  'Untitled conversation': ['Untitled conversation', '未命名对话', '未命名對話'],
  View: ['View', '显示', '顯示'],
  Window: ['Window', '窗口', '視窗'],
  'Add to {section}': ['Add to {section}', '添加到{section}', '新增到{section}'],
  'Capture a screen region': ['Capture a screen region', '截取屏幕区域', '擷取螢幕區域'],
  'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.':
    [
      'Allow Maka under Screen & System Audio Recording in System Settings, then take the screenshot again.',
      '请在系统设置的“录屏与系统录音”中允许 Maka，然后重新截图。',
      '請在系統設定的「螢幕與系統錄音」中允許 Maka，然後重新截圖。',
    ],
  'The screenshot failed: {reason}': [
    'The screenshot failed: {reason}',
    '截图失败：{reason}',
    '截圖失敗：{reason}',
  ],
  'Press any key to close': ['Press any key to close', '按任意键关闭', '按任意鍵關閉'],
  'Confirm delete': ['Confirm delete', '确认删除', '確認刪除'],
  Content: ['Content', '内容', '內容'],
  'Enter a URL starting with http:// or https://': [
    'Enter a URL starting with http:// or https://',
    '请输入以 http:// 或 https:// 开头的网址',
    '請輸入以 http:// 或 https:// 開頭的網址',
  ],
  'Enter a name': ['Enter a name', '请输入名称', '請輸入名稱'],
  'Enter some content': ['Enter some content', '请输入内容', '請輸入內容'],
  Links: ['Links', '链接', '連結'],
  'Nothing here yet': ['Nothing here yet', '暂无内容', '尚無內容'],
  Notes: ['Notes', '笔记', '筆記'],
  'Put {query} in a URL to fill it with the text typed after the name.': [
    'Put {query} in a URL to fill it with the text typed after the name.',
    '在网址里写 {query}，会用名称后面输入的文字替换。',
    '在網址裡寫 {query}，會用名稱後面輸入的文字取代。',
  ],
  Snippets: ['Snippets', '片段', '片段'],
  'The content is too long': ['The content is too long', '内容太长', '內容太長'],
  'The link could not be opened': ['The link could not be opened', '无法打开链接', '無法開啟連結'],
  'The name is too long': ['The name is too long', '名称太长', '名稱太長'],
  URL: ['URL', '网址', '網址'],
  Name: ['Name', '名称', '名稱'],
  Open: ['Open', '打开', '開啟'],
  Recommended: ['Recommended', '推荐', '推薦'],
  'Recently used': ['Recently used', '最近使用', '最近使用'],
  'Frequently used': ['Frequently used', '常用', '常用'],
  'Search tools or ask Maka': [
    'Search tools or ask Maka',
    '搜索工具，或询问 Maka',
    '搜尋工具，或詢問 Maka',
  ],
  'Copy and close': ['Copy and close', '复制并关闭', '複製並關閉'],
  Navigate: ['Navigate', '切换', '切換'],
  Application: ['Application', '应用', '應用程式'],
  'Search applications': ['Search applications', '搜索应用', '搜尋應用程式'],
  Calculator: ['Calculator', '计算器', '計算機'],
  Clipboard: ['Clipboard', '剪贴板', '剪貼簿'],
  'Clipboard history': ['Clipboard history', '剪贴板历史', '剪貼簿歷史'],
  Note: ['Note', '笔记', '筆記'],
  Snippet: ['Snippet', '片段', '片段'],
  Symbol: ['Symbol', '符号', '符號'],
  Symbols: ['Symbols', '符号', '符號'],
  'screenshot keyword': ['screenshot', '截图', '截圖'],
  Delete: ['Delete', '删除', '刪除'],
} as const satisfies Catalog;
