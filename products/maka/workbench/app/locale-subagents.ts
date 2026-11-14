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

export const subagentMessages = {
  Description: ['Description', '描述', '描述'],
  'Refresh models': ['Refresh models', '刷新模型', '重新整理模型'],
  'Load more models': ['Load more models', '加载更多模型', '載入更多模型'],
  Subagents: ['Subagents', '子 Agent', '子 Agent'],
  'Add subagent': ['Add subagent', '添加子 Agent', '新增子 Agent'],
  'Save subagent': ['Save subagent', '保存子 Agent', '儲存子 Agent'],
  'Delete subagent': ['Delete subagent', '删除子 Agent', '刪除子 Agent'],
  'Delete subagent {name}?': [
    'Delete subagent {name}?',
    '删除子 Agent {name}？',
    '刪除子 Agent {name}？',
  ],
  'No subagent presets.': ['No subagent presets.', '暂无子 Agent 预设。', '尚無子 Agent 預設。'],
  'Subagent name': ['Subagent name', '子 Agent 名称', '子 Agent 名稱'],
  'Role instruction': ['Role instruction', '角色指令', '角色指令'],
  'Subagent name placeholder': [
    'Give this subagent a recognizable name, e.g. Code reviewer',
    '为子 Agent 起一个易识别的名称，例如：代码审阅员',
    '為子 Agent 取一個易辨識的名稱，例如：程式碼審閱員',
  ],
  'Subagent description placeholder': [
    'Help the parent session choose this subagent: describe its strengths and when to use it.\nExample: Reviews code changes for correctness, edge cases, and missing tests.',
    '供父会话选择子 Agent 使用：说明它擅长的任务及适用场景。\n示例：适合审阅代码变更，检查正确性、边界情况和测试遗漏。',
    '供父對話選擇子 Agent 使用：說明它擅長的任務及適用情境。\n範例：適合審閱程式碼變更，檢查正確性、邊界情況和測試遺漏。',
  ],
  'Subagent instruction placeholder': [
    'Define responsibilities, execution steps, behavioral boundaries, output format, and acceptance criteria.\n\nExample:\nResponsibilities: Review code changes for correctness.\nSteps: Read the diff, trace affected paths, and check relevant tests.\nBoundaries: Analyze only; do not modify files.\nOutput: List issues by severity with location, impact, and a suggested fix.\nAcceptance: Support every issue with evidence; state explicitly if no confirmed issues are found.',
    '定义工作职能、执行步骤、行为边界、输出格式和验收标准。\n\n示例：\n工作职能：审阅代码变更，发现正确性问题。\n执行步骤：阅读差异，追踪受影响路径，检查相关测试。\n行为边界：仅分析，不修改文件。\n输出格式：按严重程度列出问题，附位置、影响和修复建议。\n验收标准：每个问题都有明确证据；未发现确认的问题时明确说明。',
    '定義工作職能、執行步驟、行為邊界、輸出格式和驗收標準。\n\n範例：\n工作職能：審閱程式碼變更，找出正確性問題。\n執行步驟：閱讀差異，追蹤受影響路徑，檢查相關測試。\n行為邊界：僅分析，不修改檔案。\n輸出格式：依嚴重程度列出問題，附位置、影響和修復建議。\n驗收標準：每個問題都有明確證據；未發現確認的問題時明確說明。',
  ],
  'Initial model': ['Initial model', '初始模型', '初始模型'],
  'Current model': ['Current model', '当前模型', '目前模型'],
  'This subagent preset was deleted.': [
    'This subagent preset was deleted.',
    '此子 Agent 预设已被删除。',
    '此子 Agent 預設已被刪除。',
  ],
  'A subagent with this name already exists.': [
    'A subagent with this name already exists.',
    '已存在同名子 Agent。',
    '已存在同名子 Agent。',
  ],
  'The preset model is unavailable. Choose another model.': [
    'The preset model is unavailable. Choose another model.',
    '预设模型不可用，请选择其他模型。',
    '預設模型無法使用，請選擇其他模型。',
  ],
  'The preset reasoning effort is unavailable.': [
    'The preset reasoning effort is unavailable.',
    '预设思考强度不可用。',
    '預設思考強度無法使用。',
  ],
  'Invalid preset field: {field}': [
    'Invalid preset field: {field}',
    '预设字段无效：{field}',
    '預設欄位無效：{field}',
  ],
  'Applied subagent': ['Applied subagent', '已应用的子 Agent', '已套用的子 Agent'],
} as const;
