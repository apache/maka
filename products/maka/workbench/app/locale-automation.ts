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

export const automationMessages = {
  Automations: ['Automations', '自动化', '自動化'],
  'Automation: {title}': ['Automation: {title}', '自动化 · {title}', '自動化 · {title}'],
  'New automation': ['New automation', '新建自动化', '新增自動化'],
  'Edit automation': ['Edit automation', '编辑自动化', '編輯自動化'],
  'No automations yet': ['No automations yet', '暂无自动化', '尚無自動化'],
  'Automation name': ['Name', '名称', '名稱'],
  'Automation message': ['Message to send', '要发送的消息', '要傳送的訊息'],
  'Open automation conversation': ['Open conversation', '打开会话', '開啟對話'],
  'Load more conversations': ['More conversations', '更多会话', '更多對話'],
  'Pause automation': ['Pause', '暂停', '暫停'],
  'Resume automation': ['Resume', '恢复', '恢復'],
  'Target conversation': ['Conversation', '目标会话', '目標對話'],
  'Trigger type': ['Trigger', '触发条件', '觸發條件'],
  'Once at a specific time': ['Once', '指定时间', '指定時間'],
  'Repeating interval': ['Interval', '按间隔重复', '按間隔重複'],
  'Daily at a local time': ['Daily', '每天', '每天'],
  'Weekly at a local time': ['Weekly', '每周', '每週'],
  'Monthly at a local time': ['Monthly', '每月', '每月'],
  'Cron schedule': ['Cron', 'Cron', 'Cron'],
  'Script condition': ['Script condition', '脚本条件', '指令碼條件'],
  'Check interval in seconds': ['Check every (seconds)', '检查间隔（秒）', '檢查間隔（秒）'],
  'Repeat interval in seconds': ['Repeat every (seconds)', '重复间隔（秒）', '重複間隔（秒）'],
  'Automation local time': ['Local date and time', '本地日期和时间', '本機日期和時間'],
  'Automation time zone': ['Recurrence time zone', '重复规则时区', '重複規則時區'],
  'Automation delivery': ['Delivery', '投递方式', '傳送方式'],
  'Steer current turn': ['Steer current turn', '插入当前轮', '插入目前回合'],
  'Wait for the next turn': ['Wait for next turn', '等待下一轮', '等到下一回合'],
  'Start a new conversation': ['New conversation', '新建会话', '新增對話'],
  'Script check guidance': [
    'Run JavaScript or TypeScript with Maka’s embedded Deno runtime. Print true or false on the last line. Triggers when the result changes to true.',
    '使用 Maka 内嵌的 Deno 运行 JavaScript 或 TypeScript。最后一行输出 true 或 false，结果变为 true 时触发。',
    '使用 Maka 內嵌的 Deno 執行 JavaScript 或 TypeScript。最後一行輸出 true 或 false，結果變為 true 時觸發。',
  ],
  'Choose a conversation with a model': [
    'Choose a conversation with a model.',
    '选择已配置模型的会话。',
    '選擇已設定模型的對話。',
  ],
  'Enter a valid date and time': [
    'Enter a valid date and time.',
    '请输入有效的日期和时间。',
    '請輸入有效的日期和時間。',
  ],
  'Enter a positive number of seconds': [
    'Enter a positive number of seconds.',
    '请输入大于零的秒数。',
    '請輸入大於零的秒數。',
  ],
  'Could not load automations: {reason}': [
    'Could not load automations: {reason}',
    '无法加载自动化：{reason}',
    '無法載入自動化：{reason}',
  ],
  'Automation changed. Reopen it to edit the latest version.': [
    'This automation changed. Reopen it to edit the latest version.',
    '这条自动化已更新。请重新打开后编辑。',
    '這條自動化已更新。請重新開啟後編輯。',
  ],
  'Could not save the automation: {reason}': [
    'Could not save the automation: {reason}',
    '无法保存自动化：{reason}',
    '無法儲存自動化：{reason}',
  ],
  'Automation is delivering a message': ['Delivering a message', '正在投递消息', '正在傳送訊息'],
  'Automation next check: {time}': ['Next check: {time}', '下次检查 · {time}', '下次檢查 · {time}'],
  'Automation next run: {time}': ['Next run: {time}', '下次运行 · {time}', '下次執行 · {time}'],
  'Delete automation?': ['Delete this automation?', '删除这条自动化？', '刪除這條自動化？'],
} as const;
