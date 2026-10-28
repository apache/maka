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
  msg_graphStatus_failed,
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
  Cancel: msg_cancel,
  'Choose workspace': ['Choose workspace', '选择工作区', '選擇工作區'],
  Close: msg_closeModels,
  'Close · Esc': ['Close · Esc', '关闭 · Esc', '關閉 · Esc'],
  'Connections & models': ['Connections & models', '连接与模型', '連線與模型'],
  'Draft could not be saved or restored. Its existing contents are preserved.': [
    'Draft could not be saved or restored. Its existing contents are preserved.',
    '无法保存或恢复草稿。已有内容已保留。',
    '無法儲存或還原草稿。既有內容已保留。',
  ],
  Edit: ['Edit', '编辑', '編輯'],
  Failed: msg_graphStatus_failed,
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
} as const satisfies Catalog;
