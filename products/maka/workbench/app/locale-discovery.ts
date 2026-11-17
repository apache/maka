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
    'The selected model may incur charges. Findings go to Bot.',
    '所选模型可能产生费用，发现交给 Bot 处理。',
    '選用的模型可能產生費用，發現交給 Bot 處理。',
  ],
  'Use read-only investigation tools': ['Read-only tools', '只读', '唯讀'],
  'Use standard Session tools': ['Standard Session tools', '普通会话', '一般對話'],
  'Discovery permissions': ['Investigation permissions', '调查权限', '調查權限'],
  'Discovery custom permissions': ['Custom', '自定义', '自訂'],
  'Discovery read files': ['Read files', '读取文件', '讀取檔案'],
  'Discovery read files detail': [
    'Find and read accessible local files.',
    '查找和读取可访问的本地资料。',
    '尋找和讀取可存取的本機資料。',
  ],
  'Discovery read history': ['Read conversations and memory', '读取会话与记忆', '讀取對話與記憶'],
  'Discovery read history detail': [
    'Use past conversations, their attachments and investigation records.',
    '查阅历史对话、附件和调查记录。',
    '查閱歷史對話、附件和調查紀錄。',
  ],
  'Discovery modify files': ['Modify files', '修改文件', '修改檔案'],
  'Discovery modify files detail': [
    'Create, modify or delete files within the existing workspace permissions.',
    '在现有工作区权限内新建、修改或删除文件。',
    '在現有工作區權限內新增、修改或刪除檔案。',
  ],
  'Discovery run commands': ['Run commands', '运行命令', '執行命令'],
  'Discovery run commands detail': [
    'Use the terminal under the investigation’s file and network permissions.',
    '使用终端，遵守此调查的文件和联网权限。',
    '使用終端機，遵守此調查的檔案和網路權限。',
  ],
  'Discovery network': ['Access the web', '联网访问', '網路存取'],
  'Discovery network detail': [
    'Search and read web pages within the existing network permissions.',
    '在现有联网权限内搜索和读取网页。',
    '在現有網路權限內搜尋和讀取網頁。',
  ],
  'Discovery manage sessions': ['Manage sessions and plans', '管理会话与计划', '管理對話與計畫'],
  'Discovery manage sessions detail': [
    'Delegate work and manage scheduled tasks.',
    '委派任务和管理排期。',
    '委派任務及管理排程。',
  ],
  'Discovery extensions': ['Plugins and other tools', '插件与其他工具', '外掛與其他工具'],
  'Discovery extensions detail': [
    'Use configured extensions, including MCP.',
    '使用已配置的扩展能力，包括 MCP。',
    '使用已設定的擴充功能，包括 MCP。',
  ],
  'Discovery desktop': ['Control the desktop', '控制桌面', '控制桌面'],
  'Discovery desktop detail': [
    'Interact with applications and windows.',
    '操作应用和窗口。',
    '操作應用程式和視窗。',
  ],
  'More discovery permissions': ['More permissions', '更多权限', '更多權限'],
  'More discovery permissions enabled': [
    'More permissions ({count} on)',
    '更多权限（已开启 {count} 项）',
    '更多權限（已開啟 {count} 項）',
  ],
  'Hide more discovery permissions': ['Fewer permissions', '收起更多权限', '收合更多權限'],
  'View discovery tool details': ['View tool details', '查看具体工具', '檢視個別工具'],
  'Hide discovery tool details': ['Hide tool details', '收起具体工具', '收合個別工具'],
  'Discovery unavailable': [
    'Unavailable with these settings',
    '在当前设置下不可用',
    '在目前設定下無法使用',
  ],
  'Discovery exclusions': ['Files to exclude', '不读取的资料', '不讀取的資料'],
  'Discovery exclusions detail': [
    'Applies to all proactive discoveries and automatic follow-ups. Copies in past conversations follow the conversation permission.',
    '适用于所有主动发现和自动复查。已复制到历史会话的内容按会话读取权限处理。',
    '適用於所有主動發現和自動複查。已複製到歷史對話的內容依對話讀取權限處理。',
  ],
  'No discovery exclusions': ['No exclusions', '尚未排除任何资料', '尚未排除任何資料'],
  'Discovery add exclusion': ['Add a rule', '添加规则', '新增規則'],
  'Discovery add exclusion entry': ['Add', '添加', '新增'],
  'Discovery exclude directory': ['Folder', '目录', '資料夾'],
  'Discovery exclude file': ['File', '文件', '檔案'],
  'Discovery exclude suffix': ['File suffix', '后缀', '副檔名'],
  'Discovery file suffix': ['Suffix, such as .pem', '文件后缀，例如 .pem', '副檔名，例如 .pem'],
  'Discovery exclusion path': ['Full path on the Host', '本机绝对路径', '本機絕對路徑'],
  'Discovery remove exclusion': ['Remove {path}', '移除 {path}', '移除 {path}'],
  'Could not load discovery exclusions.': [
    'Could not load the exclusion rules.',
    '无法读取资料排除规则。',
    '無法讀取資料排除規則。',
  ],
  'Could not save discovery exclusions.': [
    'Could not save the exclusion rules.',
    '无法保存资料排除规则。',
    '無法儲存資料排除規則。',
  ],
  'Discovery exclusions changed': [
    'The rules changed. Review the latest list before saving.',
    '规则已变更，请核对最新列表后再保存。',
    '規則已變更，請確認最新清單後再儲存。',
  ],
  'Discovery exclusions investigation running': [
    'Wait for the current investigation to finish or pause its plan before saving again.',
    '请等待当前调查结束，或暂停该计划后再保存。',
    '請等待目前的調查結束，或暫停該計畫後再儲存。',
  ],
  'Discovery invalid exclusion path': [
    'Enter an absolute path matching the selected file or folder type.',
    '请输入与所选文件或目录类型匹配的绝对路径。',
    '請輸入與所選檔案或資料夾類型相符的絕對路徑。',
  ],
  'Discovery invalid exclusion suffix': [
    'Use a file suffix such as .pem or .tar.gz.',
    '请输入文件后缀，例如 .pem 或 .tar.gz。',
    '請輸入副檔名，例如 .pem 或 .tar.gz。',
  ],
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
  'Discovery needs renewed approval': ['Needs renewed approval', '等待重新授权', '等待重新授權'],
  'Delete discovery plan?': ['Delete this plan?', '删除此计划？', '刪除此計畫？'],
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
  'Resume discovery': ['Resume', '恢复', '恢復'],
  'Review discovery permissions': ['Review permissions', '查看授权范围', '查看授權範圍'],
  'Approve and resume discovery': ['Approve and resume', '批准并恢复', '核准並恢復'],
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
