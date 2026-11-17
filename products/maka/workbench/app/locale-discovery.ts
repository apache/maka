/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { Catalog } from '../../../../plugins/shared/locale.js';
export const discoveryMessages = {
  'Proactive discovery': ['Proactive discovery', '主动发现', '主動發現'],
  'Discovery broad placeholder': [
    'Leave blank for broad exploration',
    '留空则进行广域探索',
    '留空則進行廣域探索',
  ],
  'Discovery existing schedule': [
    'This plan’s existing schedule will be preserved.',
    '保留此计划原有的定时方式。',
    '保留此計畫原有的排程方式。',
  ],
  'Discovery plan': ['Plan', '计划', '計畫'],
  'Discovery cadence': ['Timing', '计时方式', '計時方式'],
  'Discovery after completion': ['After completion', '上轮结束后', '上輪結束後'],
  'Discovery fixed interval': ['Fixed interval', '固定间隔', '固定間隔'],
  'Discovery interval (minutes)': ['Interval (minutes)', '检查间隔（分钟）', '檢查間隔（分鐘）'],
  'Discovery instructions': [
    'Investigation direction (optional)',
    '调查方向（可选）',
    '調查方向（選填）',
  ],
  'Discovery permission notice': [
    'Investigations can use configured Shell, web, and MCP tools within the workspace permissions shown above. The selected model may incur charges. Findings go to Bot.',
    '调查可在上方显示的工作区权限内使用已配置的 Shell、网页和 MCP 工具。所选模型可能产生费用，发现交给 Bot 处理。',
    '調查可在上方顯示的工作區權限內使用已設定的 Shell、網頁和 MCP 工具。所選模型可能產生費用，發現交給 Bot 處理。',
  ],
  'Discovery read-only notice': [
    'This plan uses read-only investigation tools. Its selected model may incur charges.',
    '此计划使用只读调查工具，所选模型可能产生费用。',
    '此計畫使用唯讀調查工具，選用的模型可能產生費用。',
  ],
  'Discovery tools': ['Tools', '调查工具', '調查工具'],
  'Use read-only investigation tools': ['Read-only tools', '只读工具', '唯讀工具'],
  'Use standard Session tools': ['Standard Session tools', '普通会话工具', '一般對話工具'],
  'Discovery permissions': ['Investigation permissions', '调查权限', '調查權限'],
  'Discovery workspace': ['Bot workspace', 'Bot 工作区', 'Bot 工作區'],
  'Change discovery model': ['Change model', '更换模型', '更換模型'],
  'Discovery model': ['Investigation model', '调查模型', '調查模型'],
  'Approve and enable discovery': ['Approve and enable', '批准并启用', '核准並啟用'],
  'Approve and save discovery': ['Approve and save', '批准并保存', '核准並儲存'],
  'New discovery plan': ['New plan', '新建计划', '新增計畫'],
  'Edit discovery plan': ['Edit plan', '编辑计划', '編輯計畫'],
  'View background follow-ups': ['View background follow-ups', '查看后台复查', '查看背景複查'],
  'Hide background follow-ups': ['Hide background follow-ups', '收起后台复查', '收合背景複查'],
  'Discovery not enabled': ['Not enabled', '尚未启用', '尚未啟用'],
  'Discovery active': ['Enabled', '已启用', '已啟用'],
  'Discovery paused': ['Paused', '已暂停', '已暫停'],
  'Discovery plan completed': ['Completed', '已完成', '已完成'],
  'Discovery plan expired': ['Expired', '已过期', '已過期'],
  'Discovery investigating': ['Investigating', '正在调查', '正在調查'],
  'Discovery delivering': ['Waiting for Bot', '等待 Bot 接收', '等待 Bot 接收'],
  'Discovery stopping': ['Stopping investigation', '正在停止调查', '正在停止調查'],
  'Discovery queued': ['Waiting for the investigation slot', '等待调查位', '等待調查位置'],
  'Discovery needs approval': ['Needs approval', '等待批准', '等待核准'],
  'Discovery last check': ['Last check', '上次检查', '上次檢查'],
  'Discovery next check': ['Next check', '下次检查', '下次檢查'],
  'Discovery next check pending': [
    'Scheduled when this check ends',
    '本轮结束后排期',
    '本輪結束後排期',
  ],
  'Discovery no history': ['No investigations yet', '尚无调查记录', '尚無調查紀錄'],
  'Discovery no report': ['No report needed', '没有需要通知的发现', '沒有需要通知的發現'],
  'Discovery reported': ['Findings handed to Bot', '发现已交给 Bot', '發現已交給 Bot'],
  'Discovery failed': ['Investigation failed', '调查失败', '調查失敗'],
  'Discovery blocked': [
    'Investigation cancelled or unavailable',
    '调查已取消或无法执行',
    '調查已取消或無法執行',
  ],
  'Run discovery now': ['Check now', '立即检查', '立即檢查'],
  'Pause discovery': ['Pause', '暂停', '暫停'],
  'Resume discovery': ['Approve and resume', '批准并恢复', '核准並恢復'],
  'Open investigation': ['View investigation', '查看调查过程', '檢視調查過程'],
  'Open previous investigation': ['View previous investigation', '查看上次调查', '檢視上次調查'],
  'Could not load the discovery plan.': [
    'Could not load the discovery plan.',
    '无法读取主动发现计划。',
    '無法讀取主動發現計畫。',
  ],
  'Could not update the discovery plan.': [
    'Could not update the discovery plan.',
    '无法更新主动发现计划。',
    '無法更新主動發現計畫。',
  ],
  'Discovery settings changed': [
    'The workspace or model changed. Review the displayed settings and confirm again.',
    '工作区或模型已变化，请核对更新后的配置并再次确认。',
    '工作區或模型已變更，請核對更新後的設定並再次確認。',
  ],
  'Discovery plan changed': [
    'The plan changed. Refresh and review it before trying again.',
    '计划已变化，请刷新并核对后重试。',
    '計畫已變更，請重新整理並核對後重試。',
  ],
  'Discovery invalid settings': [
    'Enter a positive whole number of minutes.',
    '请输入大于零的整数分钟数。',
    '請輸入大於零的整數分鐘數。',
  ],
  'Discovery updates disconnected': [
    'Status updates disconnected. Refresh to reconnect.',
    '状态更新已断开，请刷新重连。',
    '狀態更新已中斷，請重新整理連線。',
  ],
  'Quote selection': ['Quote selection', '引用选中文字', '引用選取文字'],
  'Remove quote': ['Remove quote', '移除引用', '移除引用'],
  'Too many quotes': [
    'You can attach up to 16 quotes.',
    '最多可附带 16 条引用。',
    '最多可附加 16 則引用。',
  ],
} satisfies Catalog;
