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
export const goalMessages = {
  'Pursuing Goal: {objective}': [
    'Pursuing Goal: {objective}',
    '继续目标：{objective}',
    '繼續目標：{objective}',
  ],
  'Apply and resume': ['Apply and resume', '保存并继续', '儲存並繼續'],
  'Retrying at {time}': ['Retrying at {time}', '将在 {time} 继续', '將在 {time} 繼續'],
  Goal: ['Goal', '目标', '目標'],
  'New Goal': ['New Goal', '新建目标', '新增目標'],
  'Start Goal': ['Start Goal', '开始目标', '開始目標'],
  'Starting Goal…': ['Starting Goal…', '正在开始目标…', '正在開始目標…'],
  Objective: ['Objective', '目标内容', '目標內容'],
  'What should the Agent accomplish?': [
    'What should the Agent accomplish?',
    '你希望 Agent 完成什么？',
    '你希望 Agent 完成什麼？',
  ],
  'Token budget (optional)': [
    'Token budget (optional)',
    'Token 预算（可选）',
    'Token 預算（選填）',
  ],
  'No limit': ['No limit', '不设上限', '不設上限'],
  'More options': ['More options', '更多选项', '更多選項'],
  'Pause Goal': ['Pause Goal', '暂停目标', '暫停目標'],
  'Resume Goal': ['Resume Goal', '继续目标', '繼續目標'],
  'Cancel Goal': ['Cancel Goal', '取消目标', '取消目標'],
  'Complete Goal': ['Complete Goal', '标记完成', '標記完成'],
  'Goal active': ['Goal active', '正在推进', '正在推進'],
  'Goal paused': ['Goal paused', '已暂停', '已暫停'],
  'Goal blocked': ['Goal blocked', '等待处理', '等待處理'],
  'Goal achieved': ['Goal achieved', '已完成', '已完成'],
  'Goal cancelled': ['Goal cancelled', '已取消', '已取消'],
  'Goal ready': ['Goal ready', '待开始', '待開始'],
  'Goal budget reached': ['Goal budget reached', '已达预算', '已達預算'],
  'Goal progress': ['Goal progress', '目标进度', '目標進度'],
  'Change budget': ['Change budget', '调整预算', '調整預算'],
  'Apply budget': ['Apply budget', '保存预算', '儲存預算'],
  'Known tokens': ['Known tokens', '已知 Token 用量', '已知 Token 用量'],
  'Remaining tokens': ['Remaining tokens', '剩余 Token', '剩餘 Token'],
  'Usage incomplete': ['Usage incomplete', '用量不完整', '用量不完整'],
  'Elapsed time': ['Elapsed time', '已用时间', '已用時間'],
  'Iteration {count}': ['Iteration {count}', '第 {count} 轮', '第 {count} 輪'],
  'Enter a positive whole number or leave the budget empty.': [
    'Enter a positive whole number or leave the budget empty.',
    '请输入正整数，或留空以不设预算。',
    '請輸入正整數，或留空以不設預算。',
  ],
  'The budget is checked between turns; a running turn can exceed it.': [
    'The budget is checked between turns; a running turn can exceed it.',
    '预算在每轮之间检查，执行中的一轮可能超过预算。',
    '預算在每輪之間檢查，執行中的一輪可能超過預算。',
  ],
  'Goal updates disconnected. Reconnecting…': [
    'Goal updates disconnected. Reconnecting…',
    '目标更新已断开，正在重新连接…',
    '目標更新已中斷，正在重新連線…',
  ],
  'The Goal changed. Review it and try again.': [
    'The Goal changed. Review it and try again.',
    '目标已更改，请查看后重试。',
    '目標已變更，請查看後重試。',
  ],
  'Goals are unavailable in this Agent.': [
    'Goals are unavailable in this Agent.',
    '此 Agent 不支持目标。',
    '此 Agent 不支援目標。',
  ],
  'Finish or cancel the current Goal before starting another.': [
    'Finish or cancel the current Goal before starting another.',
    '请先完成或取消当前目标。',
    '請先完成或取消目前目標。',
  ],
  'Turn off incognito to start a Goal.': [
    'Turn off incognito to start a Goal.',
    '请先关闭隐私模式，再开始目标。',
    '請先關閉隱私模式，再開始目標。',
  ],
  'Conversation settings changed. Try again.': [
    'Conversation settings changed. Try again.',
    '对话设置已更改，请重试。',
    '對話設定已變更，請重試。',
  ],
  'Enable Goal tools for this conversation to start a Goal.': [
    'Enable Goal tools for this conversation to start a Goal.',
    '请为此对话启用目标工具，再开始目标。',
    '請為此對話啟用目標工具，再開始目標。',
  ],
  'Close Goal': ['Close Goal', '关闭目标面板', '關閉目標面板'],
} as const;
