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

export const nativeToolMessages = {
  'Read surrounding messages': ['Read surrounding messages', '读取相邻消息', '讀取相鄰訊息'],
  'Read historical attachment': ['Read historical attachment', '读取历史附件', '讀取歷史附件'],
  'No matching passages': ['No matching passages', '没有匹配的段落', '沒有相符的段落'],
  'Some conversations could not be searched': [
    'Some conversations could not be searched',
    '部分会话未能搜索',
    '部分對話未能搜尋',
  ],
  'Conversation passage': ['Conversation passage', '会话片段', '對話片段'],
  'Recall user message': ['User message', '用户消息', '使用者訊息'],
  'Create goal': ['Create goal', '创建目标', '建立目標'],
  'Read goal': ['Read goal', '查看目标', '查看目標'],
  'Update goal status': ['Update goal status', '更新目标状态', '更新目標狀態'],
  'No goal in this conversation': [
    'No goal in this conversation',
    '本会话没有目标',
    '這個對話沒有目標',
  ],
  'Goal checkpoint': ['Goal checkpoint', '进展记录', '進度紀錄'],
  'Goal state': ['Goal state', '目标状态', '目標狀態'],
  'Goal token budget': ['Goal token budget', 'Token 预算', 'Token 預算'],
  'Read checklist': ['Read checklist', '查看待办', '查看待辦'],
  'Update checklist': ['Update checklist', '更新待办', '更新待辦'],
  'No checklist items': ['No checklist items', '没有待办事项', '沒有待辦事項'],
  'Checklist items to do': ['To do', '待处理', '待處理'],
  'Checklist items in progress': ['In progress', '进行中', '進行中'],
  'Manage scheduled tasks': ['Manage scheduled tasks', '管理定时任务', '管理排程任務'],
  'List scheduled tasks': ['List scheduled tasks', '列出定时任务', '列出排程任務'],
  'Task instructions': ['Task instructions', '任务内容', '任務內容'],
  'Scheduled start': ['Start time', '开始时间', '開始時間'],
  'Schedule frequency': ['Frequency', '频率', '頻率'],
  'Schedule time zone': ['Time zone', '时区', '時區'],
  'Runs every {interval}': [
    'Runs every {interval}',
    '每隔 {interval} 运行',
    '每隔 {interval} 執行',
  ],
  'Daily schedule': ['Daily', '每天', '每天'],
  'Weekly schedule': ['Weekly', '每周', '每週'],
  'Monthly schedule': ['Monthly', '每月', '每月'],
  'Cron expression': ['Cron expression', 'Cron 表达式', 'Cron 運算式'],
  'No scheduled tasks': ['No scheduled tasks', '没有定时任务', '沒有排程任務'],
  'Approval required to run': ['Approval required to run', '运行前需要审批', '執行前需要核准'],
  'Schedule change saved': ['Schedule change saved', '已保存定时任务变更', '已儲存排程任務變更'],
  'Schedule active': ['Active', '已启用', '已啟用'],
  'Schedule paused': ['Paused', '已暂停', '已暫停'],
  'Schedule expired': ['Expired', '已过期', '已過期'],
  'Schedule next run {time}': ['Next run {time}', '下次运行 {time}', '下次執行 {time}'],
  'More scheduled tasks are available': [
    'More scheduled tasks are available',
    '还有更多定时任务',
    '還有更多排程任務',
  ],
  'Send a message to the user': ['Send a message to the user', '给用户发消息', '傳送訊息給使用者'],
  'Sent 1 message': ['Sent 1 message', '已发送 1 条消息', '已傳送 1 則訊息'],
  'Sent {count} messages': [
    'Sent {count} messages',
    '已发送 {count} 条消息',
    '已傳送 {count} 則訊息',
  ],
  'Message already sent': ['Already sent', '消息已发送过', '訊息已傳送過'],
  'Wait for a new event': ['Wait for a new event', '等待新事件', '等待新事件'],
  'Waiting for a message or background result': [
    'Waiting for a message or background result',
    '等待消息或后台任务结果',
    '等待訊息或背景任務結果',
  ],
  'Script source': ['Script', '脚本', '腳本'],
  'Run script': ['Run script', '运行脚本', '執行腳本'],
  'Wait for script': ['Wait for script', '等待脚本', '等待腳本'],
  'Script still running at capture': [
    'Script was still running when checked',
    '查看时脚本仍在运行',
    '查看時腳本仍在執行',
  ],
  'Script interrupted': ['Script interrupted', '脚本已中断', '腳本已中斷'],
  'Script finished without text output': [
    'Script finished without text output',
    '脚本结束，没有文本输出',
    '腳本已結束，沒有文字輸出',
  ],
  'Script reported an error': ['Script reported an error', '脚本报错', '腳本發生錯誤'],
  'Find tools': ['Find tools', '查找工具', '尋找工具'],
  'No additional tools found': [
    'No additional tools found',
    '没有找到其他工具',
    '沒有找到其他工具',
  ],
  '{count} tools made available': [
    '{count} tools made available',
    '已加载 {count} 个工具',
    '已載入 {count} 個工具',
  ],
  '1 tool made available': ['1 tool made available', '已加载 1 个工具', '已載入 1 個工具'],
} as const satisfies Catalog;
