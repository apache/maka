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

import type { Message } from './locale.js';

export const tui_task_outputs: Message = ['Results', '产物与验证', '產物與驗證'];
export const tui_task_evidence_hint: Message = [
  'Recorded files, commands and replies in this history window. Review them before accepting the result.',
  '查看文件、命令结果与回复；下方可载入更早的记录。',
  '檢視檔案、命令結果與回覆；下方可載入更早的記錄。',
];
export const tui_task_outputs_empty: Message = [
  'No output in this window. Earlier records remain available.',
  '当前窗口没有产出记录，可查看更早的记录。',
  '目前視窗沒有產出記錄，可查看更早的記錄。',
];
export const tui_task_continue: Message = [
  'Add instructions and continue',
  '补充说明并继续',
  '補充說明並繼續',
];
export const tui_task_idle: Message = ['Ready to continue', '待继续', '待繼續'];
export const tui_task_ready: Message = ['Ready to start', '等待开始', '等待開始'];
export const tui_task_running: Message = ['Working', '正在执行', '正在執行'];
export const tui_task_waiting: Message = ['Needs your decision', '需要你决定', '需要你決定'];
export const tui_task_ended: Message = ['Turn ended', '本轮已结束', '本輪已結束'];
export const tui_task_failed: Message = ['Run failed', '本轮执行失败', '本輪執行失敗'];
export const tui_task_stopped: Message = ['Stopped', '已停止', '已停止'];
export const tui_task_empty: Message = [
  'What would you like to accomplish?',
  '这次要完成什么？',
  '這次要完成什麼？',
];
export const tui_task_empty_help: Message = [
  'Describe the result you want and how to check it. Enter sends; Shift+Enter adds a line.',
  '写下期望的结果和验收方式。Enter 发送，Shift+Enter 换行。',
  '寫下期望的結果和驗收方式。Enter 傳送，Shift+Enter 換行。',
];
export const tui_task_queue: Message = ['Queue for next turn', '排到下一轮', '排到下一輪'];
export const tui_task_queue_help: Message = [
  'Sent while running: queued for the next turn. Use ↗ in the queue to bring it into the current run.',
  '执行中发送的内容会排到下一轮；可用队列中的 ↗ 提前加入当前执行。',
  '執行中傳送的內容會排到下一輪；可用佇列中的 ↗ 提前加入目前執行。',
];
export const tui_task_current: Message = ['Current run', '正在处理', '正在處理'];
export const tui_task_followup: Message = ['Next turn', '下一轮', '下一輪'];
export const tui_task_steering: Message = [
  'Current run · queued',
  '当前执行 · 待处理',
  '目前執行 · 待處理',
];
export const tui_task_tool_error: Message = [
  'A tool reported an error; inspect its result.',
  '有工具报告错误，请检查其结果。',
  '有工具回報錯誤，請檢查其結果。',
];
export const tui_anonymous_setup: Message = [
  'Confirm the endpoint to load models. Credentials are optional for this provider.',
  '确认端点后加载模型；此服务支持无凭据连接。',
  '確認端點後載入模型；此服務支援無憑據連線。',
];
export const tui_anonymous_credential: Message = [
  'No credentials saved. This provider supports anonymous connections.',
  '未保存凭据；此服务支持匿名连接。',
  '未儲存憑據；此服務支援匿名連線。',
];
export const tui_settings_decisions_api: Message = ['Decisions API', '决策 API', '決策 API'];
export const tui_decisions_api_help: Message = [
  'Evaluate structured questions with a configured Decisions API service. Enabling it permits requests to the saved endpoint within this installation’s network permissions.',
  '使用配置的 决策 API 服务评估结构化问题。启用后可在安装的网络权限范围内向已保存的端点发送请求。',
  '使用設定的 決策 API 服務評估結構化問題。啟用後可在安裝的網路權限範圍內向已儲存的端點傳送請求。',
];
export const tui_decisions_api_enabled: Message = [
  'Decisions API enabled',
  '启用决策 API',
  '啟用決策 API',
];
export const tui_decisions_api_url: Message = ['Endpoint URL', '端点 URL', '端點 URL'];
export const tui_decisions_api_model: Message = ['Model', '模型', '模型'];
export const tui_decisions_api_timeoutMs: Message = [
  'Timeout (100–60000 ms)',
  '超时（100–60000 毫秒）',
  '逾時（100–60000 毫秒）',
];
export const tui_decisions_api_headerName: Message = ['Header name', '请求头名称', '請求標頭名稱'];
export const tui_decisions_api_secret: Message = [
  'New key or header value',
  '新密钥或请求头值',
  '新金鑰或請求標頭值',
];
export const tui_decisions_api_save: Message = ['Save settings', '保存设置', '儲存設定'];
export const tui_decisions_api_saved: Message = ['Saved', '已保存', '已儲存'];
export const tui_decisions_api_saved_endpoint: Message = [
  'Credentials for saved endpoint',
  '凭据对应的已保存端点',
  '憑證對應的已儲存端點',
];
export const tui_decisions_api_key_present: Message = [
  'API key saved',
  '已保存 API 密钥',
  '已儲存 API 金鑰',
];
export const tui_decisions_api_key_absent: Message = [
  'No API key saved',
  '未保存 API 密钥',
  '未儲存 API 金鑰',
];
export const tui_decisions_api_credential_help: Message = [
  'Save the endpoint first. Keys and header values stay private and belong to that exact URL. Each credential change preserves the other saved values.',
  '请先保存端点。密钥和请求头值保持私密，绑定到该完整 URL。每次凭据修改都会保留其他已保存的值。',
  '請先儲存端點。金鑰和請求標頭值保持私密，綁定至該完整 URL。每次憑證修改都會保留其他已儲存的值。',
];
export const tui_decisions_api_save_key: Message = [
  'Save API key',
  '保存 API 密钥',
  '儲存 API 金鑰',
];
export const tui_decisions_api_remove_key: Message = [
  'Remove API key',
  '删除 API 密钥',
  '刪除 API 金鑰',
];
export const tui_decisions_api_save_header: Message = [
  'Save header value',
  '保存请求头值',
  '儲存請求標頭值',
];
export const tui_decisions_api_remove_header: Message = [
  'Remove header',
  '删除请求头',
  '刪除請求標頭',
];
export const tui_decisions_api_test: Message = [
  'Test saved configuration',
  '测试已保存的配置',
  '測試已儲存的設定',
];
export const tui_decisions_api_test_help: Message = [
  'Sends a small test question to the saved endpoint. Provider charges may apply.',
  '向已保存端点发送一个简单测试问题，服务商可能收费。',
  '向已儲存端點傳送一個簡單測試問題，服務商可能收費。',
];
export const tui_decisions_api_tested: Message = ['Test completed', '测试完成', '測試完成'];
export const tui_decisions_api_test_failed: Message = [
  'Test failed. Check the endpoint, credentials and network permissions.',
  '测试失败，请检查端点、凭据和网络权限。',
  '測試失敗，請檢查端點、憑證和網路權限。',
];
export const tui_decisions_api_reload: Message = [
  'Reload saved settings',
  '重新加载已保存设置',
  '重新載入已儲存設定',
];
export const tui_decisions_api_invalid: Message = [
  'Invalid settings or credentials. Check the URL, model, timeout and header name/value.',
  '设置或凭据无效，请检查 URL、模型、超时及请求头名称和值。',
  '設定或憑證無效，請檢查 URL、模型、逾時及請求標頭名稱和值。',
];
export const tui_decisions_api_conflict: Message = [
  'Saved values changed elsewhere. Reload before retrying; your draft is retained.',
  '已保存值被其他操作修改。草稿已保留，请重新加载后再试。',
  '已儲存值被其他操作修改。草稿已保留，請重新載入後再試。',
];
export const tui_decisions_api_unknown: Message = [
  'The outcome is unknown. Read the original receipt before another change.',
  '结果未知，请先查询原操作回执。',
  '結果未知，請先查詢原操作回執。',
];
export const tui_decisions_api_unavailable: Message = [
  'Unable to load or save Decisions API settings.',
  '无法加载或保存 决策 API 设置。',
  '無法載入或儲存 決策 API 設定。',
];
export const tui_decisions_api_remove: Message = ['Remove credential', '删除凭据', '刪除憑證'];
export const tui_decisions_api_remove_question: Message = [
  'Remove this saved credential? Other keys and headers will be kept.',
  '删除此已保存凭据？其他密钥和请求头将保留。',
  '刪除此已儲存憑證？其他金鑰和請求標頭將保留。',
];
export const tui_web_check_key: Message = [
  'Check saved key',
  '验证已保存的密钥',
  '驗證已儲存的金鑰',
];
export const tui_web_checked: Message = ['Key check complete', '密钥验证完成', '金鑰驗證完成'];
export const tui_web_check_unavailable: Message = [
  'Key check is unavailable: check the key and network access.',
  '无法验证，请检查密钥和网络权限。',
  '無法驗證，請檢查金鑰和網路權限。',
];
export const tui_web_check_valid: Message = [
  'Key accepted by Tavily',
  'Tavily 已接受此密钥',
  'Tavily 已接受此金鑰',
];
export const tui_web_check_invalid_credentials: Message = [
  'Tavily rejected this key',
  'Tavily 拒绝了此密钥',
  'Tavily 拒絕了此金鑰',
];
export const tui_web_check_rate_limited: Message = [
  'Tavily rate limit exceeded',
  '已达到 Tavily 速率限制',
  '已達到 Tavily 速率限制',
];
export const tui_web_check_network_error: Message = [
  'Unable to reach Tavily',
  '无法连接 Tavily',
  '無法連線 Tavily',
];
export const tui_web_check_timeout: Message = [
  'Key check timed out',
  '密钥验证超时',
  '金鑰驗證逾時',
];
export const tui_web_key_invalid: Message = [
  'Enter a nonempty key of at most 4 KiB without control characters.',
  '请输入非空、不含控制字符且不超过 4 KiB 的密钥。',
  '請輸入非空、不含控制字元且不超過 4 KiB 的金鑰。',
];
export const tui_settings_web: Message = ['Web', '网络', '網路'];
export const tui_web_enabled: Message = ['Web tools', '网络工具', '網路工具'];
export const tui_web_source: Message = ['Search source', '搜索来源', '搜尋來源'];
export const tui_web_source_model: Message = ['Selected model', '所选模型', '所選模型'];
export const tui_web_source_tavily: Message = ['Tavily', 'Tavily', 'Tavily'];
export const tui_web_model_help: Message = [
  'Native search is available when the selected model supports it.',
  '所选模型支持时可使用原生搜索。',
  '所選模型支援時可使用原生搜尋。',
];
export const tui_web_tavily_help: Message = [
  'Tavily search requires a saved API key.',
  'Tavily 搜索需要保存 API 密钥。',
  'Tavily 搜尋需要儲存 API 金鑰。',
];
export const tui_web_key_configured: Message = [
  'Tavily key saved',
  '已保存 Tavily 密钥',
  '已儲存 Tavily 金鑰',
];
export const tui_web_key_missing: Message = [
  'No Tavily key',
  '尚未配置 Tavily 密钥',
  '尚未設定 Tavily 金鑰',
];
export const tui_web_key: Message = ['Tavily API key', 'Tavily API 密钥', 'Tavily API 金鑰'];
export const tui_web_save_key: Message = ['Save key', '保存密钥', '儲存金鑰'];
export const tui_web_remove_key: Message = ['Remove key', '移除密钥', '移除金鑰'];
export const tui_web_remove_question: Message = [
  'Remove the saved Tavily key?',
  '移除已保存的 Tavily 密钥？',
  '移除已儲存的 Tavily 金鑰？',
];
export const tui_web_saved: Message = ['Saved', '已保存', '已儲存'];
export const tui_web_conflict: Message = [
  'Settings changed elsewhere. Review the refreshed values and try again.',
  '设置已在其他地方更改，请检查刷新后的值再重试。',
  '設定已在其他地方變更，請檢查重新整理後的值再重試。',
];
export const tui_web_unknown: Message = [
  'The outcome is unknown. Read the original receipt before making another change.',
  '结果未知，请先查询原操作回执。',
  '結果未知，請先查詢原操作回執。',
];
export const tui_web_unavailable: Message = [
  'Unable to load or save Web settings.',
  '无法读取或保存网络设置。',
  '無法讀取或儲存網路設定。',
];
export const tui_web_reload: Message = ['Refresh', '刷新', '重新整理'];
export const tui_settings_insights: Message = ['Usage & pricing', '用量与价格', '用量與價格'];
export const tui_insights_all_sessions: Message = ['All sessions', '全部会话', '全部工作階段'];
export const tui_insights_this_session: Message = ['Session usage', '会话用量', '工作階段用量'];
export const tui_insights_search: Message = [
  'Search requests, models or tools',
  '搜索请求、模型或工具',
  '搜尋請求、模型或工具',
];
export const tui_insights_search_apply: Message = ['Apply search', '应用搜索', '套用搜尋'];
export const tui_insights_search_invalid: Message = [
  'Search must be at most 1 KiB with no control characters.',
  '搜索不得超过 1 KiB 或包含控制字符。',
  '搜尋不得超過 1 KiB 或包含控制字元。',
];
export const tui_insights_view_save: Message = ['Save view', '保存视图', '儲存檢視'];
export const tui_insights_view_saved: Message = ['View saved', '视图已保存', '檢視已儲存'];
export const tui_insights_view_load: Message = ['Load view', '加载视图', '載入檢視'];
export const tui_insights_view_retry: Message = [
  'Retry saved view',
  '重试保存视图',
  '重試儲存檢視',
];
export const tui_insights_started: Message = ['Started', '开始时间', '開始時間'];
export const tui_insights_duration: Message = ['Duration (ms)', '耗时（毫秒）', '耗時（毫秒）'];
export const tui_insights_binding: Message = ['Provider binding', '提供商绑定', '提供者綁定'];
export const tui_insights_origin: Message = ['Origin', '来源', '來源'];
export const tui_insights_rejection: Message = ['Rejection reason', '拒绝原因', '拒絕原因'];
export const tui_insights_call: Message = ['Tool call', '工具调用', '工具呼叫'];
export const tui_insights_overview: Message = ['Overview', '概览', '概覽'];
export const tui_insights_activity: Message = ['Activity', '调用记录', '呼叫記錄'];
export const tui_insights_pricing: Message = ['Pricing', '价格', '價格'];
export const tui_insights_range: Message = ['Range', '时间范围', '時間範圍'];
export const tui_insights_range_1: Message = ['Day', '一天', '一天'];
export const tui_insights_range_7: Message = ['Week', '一周', '一週'];
export const tui_insights_range_30: Message = ['Month', '一个月', '一個月'];
export const tui_insights_range_all: Message = ['All', '全部', '全部'];
export const tui_insights_refresh: Message = ['Refresh', '刷新', '重新整理'];
export const tui_insights_estimate: Message = [
  'Estimated cost from recorded usage and request-time prices.',
  '费用根据已报告用量与请求当时的价格估算。',
  '費用根據已回報用量與請求當時的價格估算。',
];
export const tui_insights_unvalued: Message = ['unvalued', '次费用未知', '次費用未知'];
export const tui_insights_unreported: Message = ['unreported', '次未报告', '次未回報'];
export const tui_insights_input: Message = ['Input', '输入', '輸入'];
export const tui_insights_output: Message = ['Output', '输出', '輸出'];
export const tui_insights_cacheRead: Message = ['Cache read', '缓存读取', '快取讀取'];
export const tui_insights_cacheWrite: Message = ['Cache write', '缓存写入', '快取寫入'];
export const tui_insights_reasoning: Message = ['Reasoning', '推理', '推理'];
export const tui_insights_models: Message = ['Model calls', '模型调用', '模型呼叫'];
export const tui_insights_tools: Message = ['Tool calls', '工具调用', '工具呼叫'];
export const tui_insights_error: Message = ['Failed', '失败', '失敗'];
export const tui_insights_aborted: Message = ['Aborted', '已中止', '已中止'];
export const tui_insights_unknown_status: Message = ['Unknown', '未知', '未知'];
export const tui_insights_unknown: Message = [
  'The outcome is unknown. Read the original receipt before making another change.',
  '结果未知，请先读取原操作回执再进行修改。',
  '結果未知，請先讀取原操作回執再進行修改。',
];
export const tui_insights_rejected: Message = ['Rejected', '已拒绝', '已拒絕'];
export const tui_insights_pending: Message = ['Pending', '进行中', '進行中'];
export const tui_insights_group: Message = ['Group by', '分组', '分組'];
export const tui_insights_byProvider: Message = ['Provider', '提供商', '提供者'];
export const tui_insights_byModel: Message = ['Model', '模型', '模型'];
export const tui_insights_byTool: Message = ['Tool', '工具', '工具'];
export const tui_insights_previous: Message = ['Previous', '上一页', '上一頁'];
export const tui_insights_next: Message = ['Next', '下一页', '下一頁'];
export const tui_insights_kind: Message = ['Type', '类型', '類型'];
export const tui_insights_status: Message = ['Status', '状态', '狀態'];
export const tui_insights_all: Message = ['All', '全部', '全部'];
export const tui_insights_model: Message = [
  'Model key (provider:model)',
  '模型标识（提供商:模型）',
  '模型識別碼（提供者:模型）',
];
export const tui_insights_tool: Message = ['Tool', '工具', '工具'];
export const tui_insights_success: Message = ['Succeeded', '成功', '成功'];
export const tui_insights_request: Message = ['Request', '请求', '請求'];
export const tui_insights_completed: Message = ['Completed', '完成时间', '完成時間'];
export const tui_insights_session: Message = ['Session', '会话', '工作階段'];
export const tui_insights_cost: Message = ['Estimated cost', '估算费用', '估算費用'];
export const tui_insights_quote: Message = ['Recorded price', '当时价格', '當時價格'];
export const tui_insights_unpriced: Message = ['Unpriced', '未定价', '未定價'];
export const tui_insights_attempts: Message = ['attempts', '次调用', '次呼叫'];
export const tui_insights_unit: Message = [
  'US dollars per million tokens. Blank cache rates use the input rate.',
  '单位为每百万 token 美元。缓存价格留空时使用输入价格。',
  '單位為每百萬 token 美元。快取價格留空時使用輸入價格。',
];
export const tui_insights_save: Message = ['Save', '保存', '儲存'];
export const tui_insights_price_save: Message = ['Save price', '保存价格', '儲存價格'];
export const tui_insights_remove: Message = [
  'Remove custom price',
  '移除自定义价格',
  '移除自訂價格',
];
export const tui_insights_restore_builtin: Message = [
  'Removing this price restores the built-in rate for future requests.',
  '移除后，后续请求将恢复使用内置价格。',
  '移除後，後續請求將恢復使用內建價格。',
];
export const tui_insights_become_unpriced: Message = [
  'Removing this price leaves future requests unpriced.',
  '移除后，后续请求将变为未定价。',
  '移除後，後續請求將變為未定價。',
];
export const tui_insights_confirm: Message = ['Confirm removal', '确认移除', '確認移除'];
export const tui_insights_close: Message = ['Close editor', '关闭编辑', '關閉編輯'];
export const tui_insights_new: Message = ['New price', '新价格', '新價格'];
export const tui_insights_saved: Message = [
  'Price saved. Historical estimates are unchanged.',
  '价格已保存，历史估算保持不变。',
  '價格已儲存，歷史估算保持不變。',
];
export const tui_insights_invalid: Message = [
  'Check the model key and nonnegative numeric prices.',
  '请检查模型标识和非负数字价格。',
  '請檢查模型識別碼和非負數字價格。',
];
export const tui_insights_conflict: Message = [
  'Prices changed. Close the editor and refresh before editing again.',
  '价格已变化。请关闭编辑并刷新后重新编辑。',
  '價格已變更。請關閉編輯並重新整理後再次編輯。',
];
export const tui_insights_unavailable: Message = [
  'Could not read this data. Refresh to try again.',
  '无法读取数据，请刷新重试。',
  '無法讀取資料，請重新整理重試。',
];
export const tui_insights_editor_changed: Message = [
  'The editor was replaced. Close and reopen it to reload the price.',
  '编辑器已更换，请关闭并重新打开以加载价格。',
  '編輯器已更換，請關閉並重新開啟以載入價格。',
];

export const tui_route_agent_screen: Message = ['Tasks', '任务工作台', '任務工作台'];

export const tui_state_save_failed: Message = [
  'Local changes not saved · check storage before closing',
  '本地更改未保存 · 关闭前请检查存储',
  '本機變更未儲存 · 關閉前請檢查儲存空間',
];

export const tui_route_settings: Message = ['Settings', '设置', '設定'];

export const tui_command_inbox: Message = [
  'Open pending requests',
  '打开待处理请求',
  '開啟待處理請求',
];

export const tui_terminal_small: Message = [
  'Maka — enlarge the terminal\nCtrl+Q to quit',
  'Maka — 请扩大终端窗口\nCtrl+Q 退出',
  'Maka — 請放大終端機視窗\nCtrl+Q 離開',
];
export const tui_terminal_required: Message = [
  'Maka TUI requires a terminal on stdin and stdout; use maka --help for non-interactive commands',
  'Maka TUI 需要终端输入和输出；非交互命令请使用 maka --help',
  'Maka TUI 需要終端機輸入和輸出；非互動命令請使用 maka --help',
];

export const tui_language_auto: Message = [
  'Automatic ({ $language })',
  '自动（{ $language }）',
  '自動（{ $language }）',
];

export const tui_help: Message = [
  'Tab / Shift+Tab     Move focus between controls\nUp / Down          Select a navigation, page or command item\nEnter              Activate the focused item\nEnter              Send from composer / queue for next turn\nShift+Enter        New line in composer\nCtrl+J             New line in composer (all terminals)\nCtrl+Enter         Submit answers / run message revision\nCtrl+K / Ctrl+P     Open command palette\nCtrl+F             Find in conversation\nCtrl+N             New session\nCtrl+A / Ctrl+Z    Select all / undo in editor\nF4                 Inspect results and execution evidence\nCtrl+G             Review a pending approval or question\nCtrl+B             Expand / collapse navigation\nCtrl+PgUp/PgDn     Switch session tabs\nCtrl+W             Close tab (keeps draft and running tasks)\nF11                Session focus mode\nPageUp / PageDown  Scroll conversation outside editor\nEnd                Latest outside editor\nAlt+Down / Tab     Enter conversation focus outside editor / after composer\nUp/Down, Left/Right Select messages, collapse/enter groups in conversation\nEnter / Space      Toggle selected conversation item\nShift+Arrows       Extend conversation text selection\nShift+Home / End   Extend to visual line start / end\nAlt+Click          Extend from the selection start after scrolling (Option on macOS)\nShift+Click        Also extends when the terminal forwards Shift mouse events\nShift+PageUp/Down  Extend selection by a page\nCtrl+C             Clear composer / current action; otherwise press twice within 2s to quit\nCmd+C (macOS) / Ctrl+C (Linux, Windows) Copy selected text\nF5                 Refresh current page\nAlt+Left / Right   Back / forward\nEsc                Close palette / leave editor or conversation, otherwise go back\n? / F1             Show help (? remains text inside an editor)\nCtrl+Q             Quit Maka\nCtrl+Alt+Q         Close UI only; keep Host and background work running\nMouse: click controls or message triangles; wheel scrolls the conversation.\nNo special font is required. Resize adapts the navigation layout.\nShift+Enter and Ctrl+Enter require terminal keyboard support; Ctrl+J always inserts a new line in the composer.',
  'Tab / Shift+Tab     在控件间移动焦点\n上 / 下             选择导航、页面或命令项\nEnter              激活焦点项\nEnter              发送消息 / 运行中排入下一轮\nShift+Enter        输入框内换行\nCtrl+J             消息输入框换行（所有终端）\nCtrl+Enter         提交问答 / 运行消息修订\nCtrl+K / Ctrl+P     打开命令面板\nCtrl+F             查找对话内容\nCtrl+N             新建会话\nCtrl+A / Ctrl+Z    编辑器内全选 / 撤销\nF4                 检查产物与执行证据\nCtrl+G             查看待审批请求或问题\nCtrl+B             展开 / 折叠导航\nCtrl+PgUp/PgDn     切换会话页签\nCtrl+W             关闭页签（保留草稿与任务）\nF11                会话专注模式\nPageUp / PageDown  编辑器外滚动正文\nEnd                编辑器外回到最新\nAlt+下 / Tab       编辑器外进入正文焦点 / 编辑器后进入正文\n上下 / 左右         正文逐项定位 / 收起或进入分组\nEnter / 空格       展开折叠选中的正文项\nShift+方向键        扩展正文选区\nShift+Home / End   扩选到视觉行首 / 行尾\nAlt+点击            从原起点扩选，可先滚动再点击（macOS 使用 Option）\nShift+点击          终端转发 Shift 鼠标事件时也可扩选\nShift+PageUp/Down  按页扩展选区\nCtrl+C             清空输入框 / 当前操作；无其它操作时两秒内按两次退出\nCmd+C（macOS）/ Ctrl+C（Linux、Windows）复制选中内容\nF5                 刷新当前页\nAlt+左 / 右         后退 / 前进\nEsc                关闭面板 / 离开编辑器或正文焦点，否则后退\n? / F1             显示帮助（编辑器中的 ? 仍是文字）\nCtrl+Q             退出 Maka\nCtrl+Alt+Q         仅关闭界面；保留 Host 和后台任务\n鼠标：点击控件或消息三角；滚轮滚动正文。\n无需特殊字体。调整窗口大小会改变导航布局。\nShift+Enter、Ctrl+Enter 需要终端支持；Ctrl+J 始终可在消息输入框内换行。',
  'Tab / Shift+Tab     在控制項間移動焦點\n上 / 下             選擇導覽、頁面或命令項\nEnter              啟用焦點項\nEnter              傳送訊息 / 執行中排入下一輪\nShift+Enter        輸入框內換行\nCtrl+J             訊息輸入框換行（所有終端機）\nCtrl+Enter         提交問答 / 執行訊息修訂\nCtrl+K / Ctrl+P     開啟命令面板\nCtrl+F             尋找對話內容\nCtrl+N             建立對話\nCtrl+A / Ctrl+Z    編輯器內全選 / 復原\nF4                 檢查產物與執行證據\nCtrl+G             查看待審批請求或問題\nCtrl+B             展開 / 收合導覽\nCtrl+PgUp/PgDn     切換對話分頁\nCtrl+W             關閉分頁（保留草稿與工作）\nF11                工作階段專注模式\nPageUp / PageDown  編輯器外捲動正文\nEnd                編輯器外回到最新\nAlt+下 / Tab       編輯器外進入正文焦點 / 編輯器後進入正文\n上下 / 左右         正文逐項定位 / 收起或進入群組\nEnter / 空白鍵     展開摺疊選取的正文項\nShift+方向鍵        擴展正文選取範圍\nShift+Home / End   擴選至視覺行首 / 行尾\nAlt+點擊            從原起點擴選，可先捲動再點擊（macOS 使用 Option）\nShift+點擊          終端機轉發 Shift 滑鼠事件時也可擴選\nShift+PageUp/Down  按頁擴展選取範圍\nCtrl+C             清空輸入框 / 目前操作；無其他操作時兩秒內按兩次離開\nCmd+C（macOS）/ Ctrl+C（Linux、Windows）複製選取內容\nF5                 重新整理目前頁面\nAlt+左 / 右         返回 / 前進\nEsc                關閉面板 / 離開編輯器或正文焦點，否則返回\n? / F1             顯示說明（編輯器中的 ? 仍是文字）\nCtrl+Q             離開 Maka\nCtrl+Alt+Q         僅關閉介面；保留 Host 和背景工作\n滑鼠：點擊控制項或訊息三角；滾輪捲動正文。\n無需特殊字型。調整視窗大小會改變導覽佈局。\nShift+Enter、Ctrl+Enter 需要終端機支援；Ctrl+J 始終可在訊息輸入框內換行。',
];
export const tui_command_agent_screen: Message = [
  'Open Agent screen',
  '打开 任务工作台',
  '開啟 任務工作台',
];
export const tui_command_host: Message = [
  'Open Host connection',
  '打开 Host 连接',
  '開啟 Host 連線',
];
export const tui_command_settings: Message = ['Open settings', '打开设置', '開啟設定'];
export const tui_command_help: Message = [
  'Keyboard and mouse help',
  '键盘和鼠标帮助',
  '鍵盤和滑鼠說明',
];

export const tui_settings_host_details: Message = ['Connection details', '连接详情', '連線詳情'];
export const tui_command_connect: Message = [
  'Connect to configured Host',
  '连接配置的 Host',
  '連線至設定的 Host',
];
export const tui_command_refresh: Message = [
  'Refresh current page · F5',
  '刷新当前页 · F5',
  '重新整理目前頁面 · F5',
];
export const tui_command_sidebar: Message = [
  'Expand / collapse navigation · Ctrl+B',
  '展开 / 折叠导航 · Ctrl+B',
  '展開 / 收合導覽 · Ctrl+B',
];
export const tui_command_fullscreen: Message = [
  'Session focus mode · F11',
  '会话专注模式 · F11',
  '工作階段專注模式 · F11',
];
export const tui_command_details: Message = [
  'Show / hide session details',
  '展开 / 收起会话详情',
  '展開 / 收合工作階段詳情',
];
export const tui_command_inspector_show: Message = ['Show panels', '显示面板', '顯示面板'];
export const tui_command_inspector_hide: Message = ['Hide panels', '隐藏面板', '隱藏面板'];
export const tui_command_symbols: Message = [
  'Switch Unicode / ASCII icons',
  '切换 Unicode / ASCII 图标',
  '切換 Unicode / ASCII 圖示',
];
export const tui_command_motion: Message = [
  'Enable / reduce motion',
  '启用 / 减少动态效果',
  '啟用 / 減少動態效果',
];
export const tui_command_quit: Message = ['Quit Maka', '退出 Maka', '離開 Maka'];

export const tui_command_detach: Message = ['Close interface only', '仅关闭界面', '僅關閉介面'];

export const tui_palette_title: Message = ['Commands', '命令', '命令'];
export const tui_palette_filter: Message = [
  'Search commands and sessions…',
  '搜索命令和会话…',
  '搜尋命令和工作階段…',
];
export const tui_palette_empty: Message = [
  'No matching commands or sessions.',
  '没有匹配的命令或会话。',
  '沒有相符的命令或工作階段。',
];
export const tui_palette_session: Message = ['Session', '会话', '工作階段'];
export const tui_palette_more_sessions: Message = [
  'More matching sessions',
  '更多匹配会话',
  '更多相符工作階段',
];
export const tui_palette_searching_sessions: Message = [
  'Searching sessions…',
  '正在搜索会话…',
  '正在搜尋工作階段…',
];
export const tui_palette_session_search_failed: Message = [
  'Session search failed. Edit the query to retry.',
  '会话搜索失败。修改搜索词以重试。',
  '工作階段搜尋失敗。修改搜尋詞以重試。',
];
export const tui_sidebar_search: Message = ['Search', '搜索', '搜尋'];
export const tui_sidebar_search_sessions: Message = ['Search sessions', '搜索会话', '搜尋工作階段'];

export const tui_sessions_loading: Message = [
  'Loading sessions…',
  '正在加载会话…',
  '正在載入工作階段…',
];
export const tui_sessions_failed: Message = [
  'Could not load sessions. Retry when the Host is available.',
  '无法加载会话，请在 Host 可用后重试。',
  '無法載入工作階段，請在 Host 可用後重試。',
];
export const tui_sessions_changed: Message = [
  'The catalog changed. Showing the first page of the new revision.',
  '会话目录已变化，正在显示新修订的第一页。',
  '工作階段目錄已變更，正在顯示新修訂的第一頁。',
];
export const tui_sessions_empty: Message = [
  'No sessions yet. Use + to create one in the current directory.',
  '暂无会话。使用 + 在当前目录新建会话。',
  '尚無工作階段。使用 + 在目前目錄建立。',
];
export const tui_sessions_help: Message = [
  'Sessions · Up/Down selects, Enter or click opens; wheel scrolls.',
  '会话 · 上下键选择，Enter 或点击打开；滚轮滚动。',
  '工作階段 · 上下鍵選擇，Enter 或點擊開啟；滾輪捲動。',
];
export const tui_sessions_next: Message = ['Next page', '下一页', '下一頁'];
export const tui_sessions_previous: Message = ['Previous page', '上一页', '上一頁'];
export const tui_session_missing: Message = [
  'This session no longer exists. Return to the Agent screen.',
  '此会话已不存在，请返回 任务工作台。',
  '此工作階段已不存在，請返回工作區。',
];
export const tui_session_id: Message = [
  'Session ID: { $value }',
  '会话 ID：{ $value }',
  '工作階段 ID：{ $value }',
];
export const tui_session_workspace: Message = [
  'Host workspace: { $value }',
  'Host 工作目录：{ $value }',
  'Host 工作目錄：{ $value }',
];
export const tui_session_model: Message = [
  'Model: { $value }',
  '模型：{ $value }',
  '模型：{ $value }',
];
export const tui_composer_placeholder: Message = ['Message…', '输入消息…', '輸入訊息…'];

export const tui_session_sandbox_change: Message = ['Sandbox', '沙箱', '沙箱'];
export const tui_session_sandbox_note: Message = [
  'Applies to this session. Tightening isolation requires an idle session.',
  '仅影响当前会话。收紧隔离需要会话处于空闲状态。',
  '僅影響目前工作階段。收緊隔離需要工作階段處於閒置狀態。',
];
export const tui_session_sandbox_warning: Message = [
  'Tools may access files and the network without sandbox isolation. Later calls in an active turn may use this mode.',
  '工具可在无沙箱隔离下访问文件和网络。当前轮次的后续调用也可能使用此模式。',
  '工具可在無沙箱隔離下存取檔案與網路。目前輪次的後續呼叫也可能使用此模式。',
];
export const tui_session_sandbox_disable: Message = ['Disable sandbox', '关闭沙箱', '關閉沙箱'];

export const tui_session_sandbox_bypass_warning: Message = [
  'Disables sandbox isolation and all permission approvals for this session. Tools may directly access files and the network, including later calls in an active turn. Use only for trusted tasks.',
  '关闭当前会话的沙箱隔离和所有权限审批。工具可直接访问文件和网络，当前轮次的后续调用也会受影响。仅用于可信任务。',
  '關閉目前工作階段的沙箱隔離及所有權限審批。工具可直接存取檔案與網路，目前輪次的後續呼叫也會受影響。僅用於可信任的任務。',
];
export const tui_session_sandbox_enable_bypass: Message = [
  'Enable full bypass',
  '确认完全绕过',
  '確認完全繞過',
];
export const tui_session_approval_title: Message = ['Escalation approvals', '扩权审批', '擴權審批'];
export const tui_session_approval_note: Message = [
  'Controls whether tools may ask for more permission; it does not grant access. Disabled categories deny escalation without asking.',
  '控制工具能否申请更多权限，不直接授予访问权限。未启用的类别会直接拒绝扩权，不再询问。',
  '控制工具能否申請更多權限，不直接授予存取權限。未啟用的類別會直接拒絕擴權，不再詢問。',
];
export const tui_session_approval_request: Message = [
  'Ask when needed',
  '需要时询问',
  '需要時詢問',
];
export const tui_session_approval_never: Message = [
  'Never ask; deny escalation',
  '不询问，拒绝扩权',
  '不詢問，拒絕擴權',
];
export const tui_session_approval_granular: Message = [
  'Ask by category',
  '按类别询问',
  '按類別詢問',
];
export const tui_session_approval_sandbox: Message = [
  'Execution outside sandbox',
  '沙箱外执行',
  '沙箱外執行',
];
export const tui_session_approval_rules: Message = ['Command rules', '命令规则', '命令規則'];
export const tui_session_approval_permissions: Message = [
  'Additional permissions',
  '额外权限',
  '額外權限',
];
export const tui_session_approval_client: Message = [
  'Client capabilities',
  '客户端能力',
  '用戶端能力',
];
export const tui_sandbox_default_title: Message = [
  'New session sandbox',
  '新会话默认沙箱',
  '新工作階段預設沙箱',
];
export const tui_sandbox_default_note: Message = [
  'Applies only to future sessions. Approvals start at “Ask when needed”; existing sessions stay unchanged.',
  '仅影响以后创建的会话，审批初始为“需要时询问”。已有会话保持不变。',
  '僅影響之後建立的工作階段，審批初始為「需要時詢問」。現有工作階段保持不變。',
];
export const tui_sandbox_default_loading: Message = [
  'Loading the Host default…',
  '正在读取 Host 默认值…',
  '正在讀取 Host 預設值…',
];
export const tui_sandbox_default_failed: Message = [
  'Could not read or update the default. Close and reopen to check its current value.',
  '无法读取或更新默认值。请关闭后重新打开，核对当前设置。',
  '無法讀取或更新預設值。請關閉後重新開啟，核對目前設定。',
];
export const tui_sandbox_default_conflict: Message = [
  'Host settings changed elsewhere. Reopen to review the current default.',
  'Host 设置已在别处修改。请重新打开，核对当前默认值。',
  'Host 設定已在其他地方修改。請重新開啟，核對目前預設值。',
];

export const tui_chat_prompt_jump: Message = [
  'Jump to this message',
  '跳转到这条消息',
  '跳至這則訊息',
];
export const tui_chat_approval_needed: Message = [
  'Approval needed · Review',
  '需要审批 · 查看请求',
  '需要審批 · 檢視請求',
];
export const tui_chat_reply_needed: Message = [
  'Reply needed · Open',
  '等待回复 · 查看问题',
  '等待回覆 · 檢視問題',
];
export const tui_chat_context: Message = ['Context', '上下文', '上下文'];
export const tui_chat_metrics_hint: Message = [
  'Context includes provider usage plus estimated additions (≈). Speed is the last main request’s output tokens / request time, including reasoning and first-token latency; tool and approval waits are excluded.',
  '上下文基于供应商用量与后续内容估算，≈ 表示估算值。速度为最近一次主模型请求的输出 token 数 ÷ 请求耗时，包含思考与首字等待，不含工具执行和审批等待。',
  '上下文依據供應商用量與後續內容估算，≈ 表示估算值。速度為最近一次主模型請求的輸出 token 數 ÷ 請求耗時，包含思考與首字等待，不含工具執行和審批等待。',
];

export const tui_session_active: Message = ['Ready', '就绪', '就緒'];
export const tui_session_running: Message = ['Running', '运行中', '執行中'];
export const tui_session_waiting: Message = ['Waiting for you', '等待你处理', '等待你處理'];
export const tui_session_blocked: Message = ['Blocked', '受阻', '受阻'];
export const tui_session_aborted: Message = ['Aborted', '已中止', '已中止'];
export const tui_session_archived: Message = ['Archived', '已归档', '已封存'];

export const tui_sidebar_needs_you: Message = ['Needs you', '待处理', '待處理'];

export const tui_command_trace_show: Message = [
  'Show execution details',
  '显示执行细节',
  '顯示執行細節',
];
export const tui_command_trace_hide: Message = [
  'Hide execution details',
  '隐藏执行细节',
  '隱藏執行細節',
];

export const tui_queue_focus: Message = ['Queued messages', '待处理消息', '待處理訊息'];

export const tui_session_create: Message = [
  'New session in current directory · Ctrl+N',
  '在当前目录新建会话 · Ctrl+N',
  '在目前目錄建立工作階段 · Ctrl+N',
];
export const tui_session_create_failed: Message = [
  'Couldn’t create session · View details',
  '新建会话失败 · 查看详情',
  '建立工作階段失敗 · 查看詳情',
];
export const tui_session_new: Message = ['New conversation', '新对话', '新對話'];

export const tui_interaction_open: Message = [
  'Review pending request · Ctrl+G',
  '审阅待处理请求 · Ctrl+G',
  '審閱待處理請求 · Ctrl+G',
];

export const tui_review_permissions: Message = [
  'Requested access · choose how long to allow it below',
  '请求的权限 · 请在下方选择允许时长',
  '請求的權限 · 請在下方選擇允許時長',
];

export const tui_form_cancel: Message = ['Cancel request', '取消请求', '取消請求'];

export const tui_session_rename: Message = ['Rename session', '重命名会话', '重新命名對話'];
export const tui_session_archive: Message = ['Archive session', '归档会话', '封存對話'];
export const tui_session_restore: Message = ['Restore session', '恢复会话', '還原對話'];
export const tui_session_save: Message = ['Save', '保存', '儲存'];
export const tui_session_cancel: Message = ['Cancel', '取消', '取消'];
export const tui_session_remove: Message = ['Delete session', '删除会话', '刪除對話'];
export const tui_session_remove_confirm: Message = ['Delete', '删除', '刪除'];
export const tui_session_remove_close: Message = ['Close', '关闭', '關閉'];
export const tui_session_remove_query: Message = ['Check result', '查询结果', '查詢結果'];
export const tui_session_remove_retry: Message = ['Retry', '重试', '重試'];
export const tui_session_remove_checking: Message = [
  'Checking deletion impact…',
  '正在确认删除影响…',
  '正在確認刪除影響…',
];
export const tui_session_remove_note: Message = [
  'Permanently deletes this session and its revisions. Owned worktrees may be reclaimed. Local drafts are kept.',
  '永久删除此会话及其修订，可能回收所属的独占工作树。本地草稿保留。',
  '永久刪除此對話及其修訂，可能回收所屬的獨占工作樹。本機草稿保留。',
];
export const tui_session_remove_subtasks: Message = [
  'Currently { $count } related subtasks would also be archived.',
  '当前还会归档 { $count } 个关联子任务。',
  '目前還會封存 { $count } 個關聯子任務。',
];
export const tui_session_remove_wait: Message = [
  'Deleting… Closing this window will not cancel deletion.',
  '正在删除…关闭此窗口不会取消删除。',
  '正在刪除…關閉此視窗不會取消刪除。',
];
export const tui_session_remove_unknown: Message = [
  'Deletion is unconfirmed. Check the result before taking further action.',
  '删除结果尚未确认，请先查询结果。',
  '刪除結果尚未確認，請先查詢結果。',
];
export const tui_session_remove_read_failed: Message = [
  'Could not check deletion. Try again.',
  '暂时无法确认删除影响，请重试。',
  '暫時無法確認刪除影響，請重試。',
];
export const tui_session_remove_failed: Message = [
  'Could not delete. Check again before retrying.',
  '未能删除，请重新查询后再试。',
  '未能刪除，請重新查詢後再試。',
];
export const tui_session_remove_unavailable: Message = [
  'The Host cannot delete this session in its current state.',
  'Host 暂时无法删除此状态的会话。',
  'Host 暫時無法刪除此狀態的對話。',
];
export const tui_session_removed_draft: Message = [
  'This session is no longer available. Your local draft is kept; you can select and copy it below.',
  '此会话已不可用。本地草稿仍保留，可在下方选择并复制。',
  '此對話已無法使用。本機草稿仍保留，可在下方選取並複製。',
];
export const tui_session_saving: Message = ['Saving…', '正在保存…', '正在儲存…'];
export const tui_session_archive_note: Message = [
  'History is kept. You can restore an archived session from the Agent screen.',
  '历史记录会保留。归档后可在 任务工作台恢复会话。',
  '歷史紀錄會保留。封存後可在工作區還原對話。',
];
export const tui_session_name_too_large: Message = [
  'Name is too long.',
  '名称过长。',
  '名稱過長。',
];
export const tui_session_edit_conflict: Message = [
  'This session changed elsewhere. Close and reopen to review the latest version.',
  '会话已在别处更改。请关闭并重新打开，确认最新版本。',
  '對話已在別處變更。請關閉並重新開啟，確認最新版本。',
];
export const tui_session_edit_unknown: Message = [
  'Result not confirmed. Close and refresh before making another change.',
  '结果尚未确认。请关闭并刷新，确认后再修改。',
  '結果尚未確認。請關閉並重新整理，確認後再修改。',
];
export const tui_session_edit_disconnected: Message = [
  'Host disconnected. Reconnect before making another change.',
  'Host 已断开。请重新连接后再修改。',
  'Host 已中斷連線。請重新連線後再修改。',
];
export const tui_session_edit_busy: Message = [
  'This session still has work in progress. Try again when it finishes.',
  '会话还有未完成的任务。请完成后再试。',
  '對話還有未完成的工作。請完成後再試。',
];
export const tui_session_edit_failed: Message = [
  'Could not save. Check the name and Host connection, then try again.',
  '未能保存。请检查名称和 Host 连接后重试。',
  '無法儲存。請檢查名稱和 Host 連線後重試。',
];
export const tui_session_workspace_change: Message = [
  'Change workspace',
  '切换工作目录',
  '切換工作目錄',
];
export const tui_session_project_change: Message = ['Change project', '切换项目', '切換專案'];
export const tui_session_model_change: Message = ['Change model', '切换模型', '切換模型'];

export const tui_session_model_apply: Message = ['Use model', '使用模型', '使用模型'];
export const tui_session_model_note: Message = [
  'Applies to this session only. The Host default stays unchanged.',
  '仅应用于当前会话，不改变 Host 默认模型。',
  '僅套用至目前對話，不變更 Host 預設模型。',
];
export const tui_session_thinking: Message = ['Thinking level', '思考程度', '思考程度'];
export const tui_session_model_thinking: Message = [
  '{ $name } · Thinking: { $state }',
  '{ $name } · 思考程度：{ $state }',
  '{ $name } · 思考程度：{ $state }',
];
export const tui_session_thinking_fallback: Message = [
  'This model does not support the selected thinking level. Saving will use its default.',
  '此模型不支持所选思考档位，保存后将使用默认设置。',
  '此模型不支援所選思考等級，儲存後將使用預設設定。',
];
export const tui_thinking_default: Message = ['Default', '默认', '預設'];
export const tui_thinking_off: Message = ['Off', '关闭', '關閉'];
export const tui_thinking_minimal: Message = ['Minimal', '最低', '最低'];
export const tui_thinking_low: Message = ['Low', '低', '低'];
export const tui_thinking_medium: Message = ['Medium', '中', '中'];
export const tui_thinking_high: Message = ['High', '高', '高'];
export const tui_thinking_xhigh: Message = ['Extra high', '极高', '極高'];
export const tui_thinking_max: Message = ['Maximum', '最高', '最高'];
export const tui_thinking_ultra: Message = ['Ultra', '极致', '極致'];
export const tui_session_model_empty: Message = [
  'No enabled chat models in the Host catalog.',
  'Host 目录中没有已启用的聊天模型。',
  'Host 清單中沒有已啟用的聊天模型。',
];
export const tui_session_model_search: Message = [
  'Search enabled chat models',
  '搜索已启用的聊天模型',
  '搜尋已啟用的聊天模型',
];
export const tui_session_model_search_limit: Message = [
  'Search is too long.',
  '搜索内容过长。',
  '搜尋內容過長。',
];
export const tui_session_model_search_empty: Message = [
  'No enabled chat models match this search.',
  '没有匹配的已启用聊天模型。',
  '沒有相符的已啟用聊天模型。',
];
export const tui_session_model_enable_chat: Message = [
  'Enable chat models in Connections',
  '前往连接页启用聊天模型',
  '前往連線頁啟用聊天模型',
];
export const tui_session_model_page_empty: Message = [
  'No enabled chat models on this page.',
  '此页没有已启用的聊天模型。',
  '此頁沒有已啟用的聊天模型。',
];
export const tui_session_model_loading: Message = [
  'Loading models…',
  '正在读取模型…',
  '正在讀取模型…',
];
export const tui_session_model_load_failed: Message = [
  'Could not load models. Refresh to retry.',
  '无法读取模型，请刷新重试。',
  '無法讀取模型，請重新整理後重試。',
];
export const tui_session_model_failed: Message = [
  'Could not switch model. Check its connection and credentials, then retry.',
  '无法切换模型，请检查连接和凭证后重试。',
  '無法切換模型，請檢查連線及憑證後重試。',
];
export const tui_session_project_apply: Message = ['Use project', '使用项目', '使用專案'];
export const tui_session_project_note: Message = [
  "Uses the project's Host directory for this session. No files are moved.",
  '此会话将使用项目的 Host 目录，不移动文件。',
  '此對話將使用專案的 Host 目錄，不移動檔案。',
];
export const tui_session_project_failed: Message = [
  'Could not switch project. Refresh the list or choose another project.',
  '无法切换项目，请刷新列表或选择其他项目。',
  '無法切換專案，請重新整理清單或選擇其他專案。',
];
export const tui_session_workspace_apply: Message = ['Switch', '切换', '切換'];
export const tui_session_workspace_note: Message = [
  'Absolute directory on the Host. Changes where future work runs; no files are moved.',
  'Host 上的绝对目录。只更改后续执行位置，不移动文件。',
  'Host 上的絕對目錄。只變更後續執行位置，不移動檔案。',
];
export const tui_session_workspace_invalid: Message = [
  'Enter an existing absolute directory on the Host.',
  '请输入 Host 上已存在的绝对目录。',
  '請輸入 Host 上已存在的絕對目錄。',
];
export const tui_session_workspace_unavailable: Message = [
  'This session cannot switch workspaces. Check its archive or isolated-worktree state.',
  '此会话不能切换目录。请检查归档或隔离工作树状态。',
  '此對話無法切換目錄。請檢查封存或隔離工作樹狀態。',
];
export const tui_session_path_too_large: Message = [
  'Path is too long.',
  '路径过长。',
  '路徑過長。',
];
export const tui_session_path_control: Message = [
  'Paste one path without control characters.',
  '请粘贴单个路径，不包含控制字符。',
  '請貼上單一路徑，不包含控制字元。',
];
export const tui_session_workspace_project_note: Message = [
  "Use a fixed Host directory, no longer following the project's location. No files are moved.",
  '改用固定 Host 目录，不再跟随项目位置。不移动文件。',
  '改用固定 Host 目錄，不再跟隨專案位置。不移動檔案。',
];

export const tui_connection_default: Message = ['Default', '默认', '預設'];
export const tui_connection_models: Message = [
  '{ $count } enabled models',
  '已启用 { $count } 个模型',
  '已啟用 { $count } 個模型',
];
export const tui_connections_loading: Message = [
  'Loading connections…',
  '正在加载连接…',
  '正在載入連線…',
];

export const tui_projects_failed: Message = [
  'Could not load projects. Retry when ready.',
  '未能加载项目，可重试。',
  '無法載入專案，可重試。',
];
export const tui_projects_loading: Message = [
  'Loading projects…',
  '正在加载项目…',
  '正在載入專案…',
];
export const tui_projects_empty: Message = [
  'No registered projects.',
  '尚无已注册项目。',
  '尚無已註冊專案。',
];
export const tui_projects_page_empty: Message = [
  'No project entries on this page. Use the page controls to browse.',
  '本页没有项目条目，可继续翻页。',
  '本頁沒有專案項目，可繼續翻頁。',
];

export const tui_directory_browse: Message = ['Browse…', '浏览…', '瀏覽…'];
export const tui_directory_title: Message = ['Host directories', 'Host 目录', 'Host 目錄'];
export const tui_directory_roots: Message = ['Available roots', '可用目录根', '可用目錄根'];
export const tui_directory_open: Message = ['Open directory', '打开目录', '開啟目錄'];
export const tui_directory_parent: Message = ['Parent directory', '上一级', '上一層'];
export const tui_directory_path: Message = ['Type path', '输入路径', '輸入路徑'];
export const tui_directory_register: Message = ['Register here', '注册此目录', '註冊此目錄'];

export const tui_directory_empty: Message = ['No subdirectories.', '没有子目录。', '沒有子目錄。'];
export const tui_directory_no_roots: Message = [
  'No directories published by this Host. You can type a path instead.',
  'Host 未开放浏览目录，可改为输入路径。',
  'Host 未開放瀏覽目錄，可改為輸入路徑。',
];
export const tui_directory_failed: Message = [
  'Could not read this directory. Refresh or go up to try another.',
  '无法读取此目录。可刷新，或返回上一级选择其他目录。',
  '無法讀取此目錄。可重新整理，或返回上一層選擇其他目錄。',
];

export const tui_project_rename: Message = ['Rename project', '重命名项目', '重新命名專案'];

export const tui_session_model_use_default: Message = [
  'Use default model',
  '使用默认模型',
  '使用預設模型',
];

export const tui_model_profile_choose: Message = [
  'Choose a model to edit its overrides.',
  '选择模型，编辑其覆盖配置。',
  '選擇模型，編輯其覆寫設定。',
];
export const tui_model_profile_back: Message = ['Back', '返回', '返回'];
export const tui_model_profile_name: Message = ['Display name', '显示名称', '顯示名稱'];
export const tui_model_profile_context: Message = ['Context window', '上下文窗口', '上下文視窗'];
export const tui_model_profile_input: Message = ['Input limit', '输入上限', '輸入上限'];
export const tui_model_profile_compaction: Message = ['Compact at', '压缩阈值', '壓縮門檻'];
export const tui_model_profile_output: Message = ['Reply budget', '回复预算', '回覆預算'];
export const tui_model_profile_vision: Message = ['Vision', '视觉输入', '視覺輸入'];
export const tui_model_profile_code: Message = ['Code Mode', 'Code Mode', 'Code Mode'];
export const tui_model_profile_patch: Message = ['apply_patch', 'apply_patch', 'apply_patch'];
export const tui_model_profile_protocol: Message = ['API protocol', 'API 协议', 'API 協定'];
export const tui_model_profile_description: Message = ['Description', '模型说明', '模型說明'];
export const tui_model_profile_cutoff: Message = [
  'Knowledge cutoff',
  '知识截止日期',
  '知識截止日期',
];
export const tui_model_profile_level: Message = [
  'Thinking · { $level }',
  '思考 · { $level }',
  '思考 · { $level }',
];
export const tui_model_profile_on: Message = ['Enabled', '启用', '啟用'];
export const tui_model_profile_off: Message = ['Disabled', '禁用', '停用'];
export const tui_model_profile_note: Message = [
  'Blank values follow model defaults. Changes affect future requests using this connection. Save to apply.',
  '留空沿用模型默认值。影响使用本连接的后续请求，保存后生效。',
  '留空沿用模型預設值。影響使用本連線的後續請求，儲存後生效。',
];
export const tui_model_profile_number_invalid: Message = [
  'Enter a positive whole token count, such as 128K or 1M.',
  '请输入正整数 token 数，例如 128K 或 1M。',
  '請輸入正整數 token 數，例如 128K 或 1M。',
];
export const tui_model_profile_limits_conflict: Message = [
  'Input limit cannot exceed the context window, including inherited limits.',
  '输入上限不能大于上下文窗口，包括沿用的默认上限。',
  '輸入上限不能大於上下文視窗，包括沿用的預設上限。',
];
export const tui_model_profile_invalid: Message = [
  'Check model values and limits before saving.',
  '请检查模型配置及上限后再保存。',
  '請檢查模型設定及上限後再儲存。',
];
export const tui_model_profile_text_limit: Message = [
  'This value is too long.',
  '输入内容过长。',
  '輸入內容過長。',
];

export const tui_model_profile_advanced: Message = ['Advanced', '高级设置', '進階設定'];
export const tui_model_profile_chat: Message = ['Chat', '聊天', '聊天'];
export const tui_model_profile_reasoning: Message = ['Reasoning', '推理', '推理'];
export const tui_model_profile_tools: Message = ['Tool calls', '工具调用', '工具呼叫'];
export const tui_model_profile_parallel: Message = [
  'Parallel tools',
  '并行工具调用',
  '平行工具呼叫',
];
export const tui_model_profile_images: Message = ['Image generation', '图像生成', '圖像生成'];
export const tui_model_profile_web: Message = ['Web search', '网络搜索', '網路搜尋'];
export const tui_model_profile_modalities: Message = ['Modalities', '模态声明', '模態宣告'];
export const tui_model_profile_tier: Message = ['Service tier', '服务档位', '服務級別'];
export const tui_model_profile_custom: Message = ['Custom', '自定义', '自訂'];
export const tui_model_profile_input_text: Message = ['Input · Text', '输入 · 文本', '輸入 · 文字'];
export const tui_model_profile_input_image: Message = [
  'Input · Image',
  '输入 · 图像',
  '輸入 · 圖像',
];
export const tui_model_profile_input_audio: Message = [
  'Input · Audio',
  '输入 · 音频',
  '輸入 · 音訊',
];
export const tui_model_profile_input_pdf: Message = ['Input · PDF', '输入 · PDF', '輸入 · PDF'];
export const tui_model_profile_input_video: Message = [
  'Input · Video',
  '输入 · 视频',
  '輸入 · 影片',
];
export const tui_model_profile_output_text: Message = [
  'Output · Text',
  '输出 · 文本',
  '輸出 · 文字',
];
export const tui_model_profile_output_image: Message = [
  'Output · Image',
  '输出 · 图像',
  '輸出 · 圖像',
];
export const tui_model_profile_output_audio: Message = [
  'Output · Audio',
  '输出 · 音频',
  '輸出 · 音訊',
];
export const tui_model_profile_output_pdf: Message = ['Output · PDF', '输出 · PDF', '輸出 · PDF'];
export const tui_model_profile_output_video: Message = [
  'Output · Video',
  '输出 · 视频',
  '輸出 · 影片',
];
export const tui_model_profile_modalities_note: Message = [
  'Custom replaces both modality lists. Empty means none. Choose Default to inherit.',
  '自定义会替换输入与输出模态。空集合表示不支持；选择默认可恢复继承。',
  '自訂會取代輸入與輸出模態。空集合表示不支援；選擇預設可恢復繼承。',
];

export const tui_theme_reload_file: Message = ['Reload file', '重新读取', '重新讀取'];

export const tui_theme_path: Message = ['File: { $path }', '文件：{ $path }', '檔案：{ $path }'];

export const tui_theme_file_missing: Message = [
  'Theme file not found. Current colors are unchanged.',
  '未找到主题文件，当前配色未变。',
  '找不到主題檔案，目前配色未變。',
];
export const tui_theme_file_unreadable: Message = [
  'Cannot read a regular theme file at an absolute path. Current colors are unchanged.',
  '无法读取主题文件，请使用普通文件的绝对路径。当前配色未变。',
  '無法讀取主題檔案，請使用一般檔案的絕對路徑。目前配色未變。',
];
export const tui_theme_file_version: Message = [
  'Unsupported theme version; use version 1. Current colors are unchanged.',
  '不支持此主题版本，请使用 version 1。当前配色未变。',
  '不支援此主題版本，請使用 version 1。目前配色未變。',
];
export const tui_theme_file_name: Message = [
  'Theme name must contain 1–40 visible characters. Current colors are unchanged.',
  '主题名称需为 1–40 个可见字符，当前配色未变。',
  '主題名稱須為 1–40 個可見字元，目前配色未變。',
];

export const tui_theme_customize: Message = ['Customize theme', '自定义主题', '自訂主題'];
export const tui_theme_custom_name: Message = ['My theme', '我的主题', '我的主題'];
export const tui_theme_name: Message = ['Name', '名称', '名稱'];
export const tui_theme_import_invalid: Message = [
  'Invalid theme file. Check version 1, a name, known fields and #RRGGBB colors.',
  '主题文件无效，请检查 version 1、名称、字段名与 #RRGGBB 色值。',
  '主題檔案無效，請檢查 version 1、名稱、欄位名稱與 #RRGGBB 色碼。',
];
export const tui_theme_export: Message = ['Save to file', '保存到文件', '儲存到檔案'];
export const tui_theme_exported: Message = [
  'Theme file saved.',
  '主题文件已保存。',
  '主題檔案已儲存。',
];
export const tui_theme_imported: Message = [
  'File loaded into preview. Save & apply to keep it.',
  '文件已载入预览；保存并应用后才会保留。',
  '檔案已載入預覽；儲存並套用後才會保留。',
];
export const tui_theme_reload_stale: Message = [
  'Preview changed while loading. Reload again to replace it.',
  '加载期间预览已改变，请再次重新读取。',
  '載入期間預覽已改變，請再次重新讀取。',
];
export const tui_theme_file_draft_hint: Message = [
  'Reload previews the file; Save to file exports this custom theme.',
  '重新读取会预览文件；保存到文件会导出此自定义主题。',
  '重新讀取會預覽檔案；儲存到檔案會匯出此自訂主題。',
];
export const tui_theme_save: Message = ['Save & apply', '保存并应用', '儲存並套用'];

export const tui_theme_preview: Message = [
  'Text · code preview',
  '正文 · 代码预览',
  '內文 · 程式碼預覽',
];
export const tui_theme_hex_invalid: Message = [
  'Enter a color as #RRGGBB.',
  '请输入 #RRGGBB 颜色。',
  '請輸入 #RRGGBB 顏色。',
];
export const tui_theme_file_changed: Message = [
  'File changed externally. Reload it before saving.',
  '文件已被外部修改，请重新加载后保存。',
  '檔案已被外部修改，請重新載入後儲存。',
];
export const tui_theme_file_save: Message = [
  'Could not save; the original file was preserved.',
  '无法保存，原文件已保留。',
  '無法儲存，原始檔案已保留。',
];
export const tui_theme_role_background: Message = ['Background', '背景', '背景'];
export const tui_theme_role_foreground: Message = ['Text', '正文', '內文'];
export const tui_theme_role_surface: Message = ['Surface', '内容底色', '內容底色'];
export const tui_theme_role_accent: Message = ['Accent', '强调', '強調'];
export const tui_theme_role_thinking: Message = ['Thinking', '思考', '思考'];
export const tui_theme_role_success: Message = ['Success', '成功', '成功'];
export const tui_theme_role_warning: Message = ['Warning', '警告', '警告'];
export const tui_theme_role_error: Message = ['Error', '错误', '錯誤'];
export const tui_theme_role_muted: Message = ['Secondary text', '次要文字', '次要文字'];
export const tui_theme_role_subtle: Message = ['Subtle text', '弱文字', '弱文字'];
export const tui_theme_role_border: Message = ['Border', '边框', '邊框'];
export const tui_theme_role_scrollbar: Message = ['Scrollbar', '滚动条', '捲動條'];
export const tui_theme_role_selection: Message = ['Selection', '选中背景', '選取背景'];
export const tui_theme_role_selection_text: Message = ['Selected text', '选中文字', '選取文字'];
export const tui_theme_role_search: Message = ['Search', '搜索背景', '搜尋背景'];
export const tui_theme_role_search_active: Message = ['Active match', '当前匹配', '目前符合'];
export const tui_theme_role_search_text: Message = ['Match text', '匹配文字', '符合文字'];
export const tui_theme_role_keyword: Message = ['Keyword', '关键词', '關鍵字'];
export const tui_theme_role_string: Message = ['String', '字符串', '字串'];
export const tui_theme_role_comment: Message = ['Comment', '注释', '註解'];
export const tui_theme_role_number: Message = ['Number', '数字', '數字'];
export const tui_theme_role_function: Message = ['Function', '函数', '函式'];
export const tui_theme_role_type: Message = ['Type', '类型', '類型'];
export const tui_theme_role_operator: Message = ['Operator', '运算符', '運算子'];

export const tui_attachments_add: Message = ['Attach files', '添加文件', '新增檔案'];

export const tui_attachments_local_files: Message = ['Local files', '本机文件', '本機檔案'];

export const tui_attachments_remove: Message = ['Remove', '移除', '移除'];

export const tui_attachments_ready: Message = ['Ready', '就绪', '就緒'];

export const tui_skills_title: Message = ['Skills', '技能', '技能'];
export const tui_skills_selected: Message = ['Selected', '已选', '已選'];
export const tui_skills_loading: Message = ['Loading skills…', '正在读取技能…', '正在讀取技能…'];
export const tui_skills_empty: Message = ['No skills here.', '暂无技能。', '暫無技能。'];
export const tui_skills_changed: Message = [
  'Skills changed. Refresh to continue.',
  '技能目录已变更，请刷新。',
  '技能目錄已變更，請重新整理。',
];
export const tui_skills_failed: Message = [
  'Could not load skills. Refresh to try again.',
  '无法读取技能，可刷新重试。',
  '無法讀取技能，可重新整理再試。',
];
export const tui_skills_limit: Message = [
  'Too many selected inputs.',
  '所选输入数量已达上限。',
  '所選輸入數量已達上限。',
];
export const tui_skills_idle: Message = [
  'Wait for this turn to finish',
  '等待本轮结束',
  '等待本輪結束',
];

export const tui_recap_title: Message = ['Session recap', '会话回顾', '工作階段回顧'];

export const tui_recap_generate: Message = ['Generate new', '生成新回顾', '產生新回顧'];

export const tui_recap_pending: Message = [
  'The request was recorded but its result is unconfirmed. Refresh to check. Generate new starts a separate request and may incur another charge.',
  '请求已记录，但结果尚未确认。可刷新查询；生成新回顾会发起独立请求，可能再次收费。',
  '請求已記錄，但結果尚未確認。可重新整理查詢；產生新回顧會發起獨立請求，可能再次收費。',
];

export const tui_recap_empty: Message = [
  'No recap has been saved for this session.',
  '本会话尚无已保存的回顾。',
  '本工作階段尚無已儲存的回顧。',
];

export const tui_extensions_refresh: Message = ['Refresh', '刷新', '重新整理'];

export const tui_settings_host: Message = ['Network & proxy', '网络与代理', '網路與代理'];
export const tui_settings_advanced: Message = ['Advanced', '高级', '進階'];
export const tui_provider_custom: Message = ['Custom service', '自定义服务', '自訂服務'];
export const tui_network_help: Message = [
  'Proxy changes apply to subsequent model, Web and process requests. Existing connections may continue using their original route.',
  '代理修改用于后续模型、网页和进程请求。现有连接可能继续使用原有路由。',
  '代理修改用於後續模型、網頁和程序請求。現有連線可能繼續使用原有路由。',
];
export const tui_network_enabled: Message = ['Use proxy', '使用代理', '使用代理'];
export const tui_network_auth: Message = ['Proxy authentication', '代理认证', '代理驗證'];
export const tui_network_host: Message = ['Proxy host', '代理主机', '代理主機'];
export const tui_network_port: Message = ['Port', '端口', '連接埠'];
export const tui_network_username: Message = ['Username', '用户名', '使用者名稱'];
export const tui_network_bypass: Message = [
  'Bypass domains (comma separated)',
  '绕过域名（逗号分隔）',
  '略過網域（逗號分隔）',
];
export const tui_network_secret_present: Message = [
  'Proxy password is saved.',
  '已保存代理密码。',
  '已儲存代理密碼。',
];
export const tui_network_secret_absent: Message = [
  'No proxy password saved.',
  '未保存代理密码。',
  '未儲存代理密碼。',
];
export const tui_network_keep: Message = ['Keep saved password', '保留已存密码', '保留已存密碼'];
export const tui_network_replace: Message = ['Replace password', '替换密码', '取代密碼'];
export const tui_network_delete: Message = [
  'Remove saved password',
  '移除已存密码',
  '移除已存密碼',
];
export const tui_network_password: Message = ['New proxy password', '新代理密码', '新代理密碼'];
export const tui_network_delete_help: Message = [
  'Saving with authentication off removes the saved password. Review the target before saving a replacement.',
  '关闭认证后保存会移除已有密码。替换密码前请核对目标。',
  '關閉驗證後儲存會移除已有密碼。取代密碼前請核對目標。',
];
export const tui_network_save: Message = ['Save proxy settings', '保存代理设置', '儲存代理設定'];
export const tui_network_reload: Message = [
  'Reload saved settings',
  '重新加载已存设置',
  '重新載入已存設定',
];
export const tui_network_auto_bypass: Message = [
  'Automatic bypass domains',
  '自动绕过域名',
  '自動略過網域',
];
export const tui_network_saved: Message = [
  'Proxy settings saved.',
  '代理设置已保存。',
  '代理設定已儲存。',
];
export const tui_network_invalid: Message = [
  'Check the proxy fields and password, then save again.',
  '请检查代理字段和密码后重新保存。',
  '請檢查代理欄位和密碼後重新儲存。',
];
export const tui_network_conflict: Message = [
  'Proxy settings or credentials changed. Reload before editing again.',
  '代理设置或凭据已变更。请重新加载后编辑。',
  '代理設定或憑證已變更。請重新載入後編輯。',
];
export const tui_network_unknown: Message = [
  'Save outcome is unknown. Check the original operation before trying again.',
  '保存结果未知。请先查询原操作。',
  '儲存結果未知。請先查詢原操作。',
];
export const tui_network_unavailable: Message = [
  'Host settings are unavailable. Retry loading.',
  '主机设置不可用。请重试加载。',
  '主機設定無法使用。請重試載入。',
];
export const tui_sessions_defaults_help: Message = [
  'Defaults for new sessions in this workspace. Existing sessions keep their permissions. Saving reconfigures the Agent; active runs may stop.',
  '此工作区中新会话的默认权限。已有会话保留原权限。保存会重新配置 Agent，正在执行的任务可能停止。',
  '此工作區中新工作階段的預設權限。既有工作階段保留原權限。儲存會重新設定 Agent，正在執行的任務可能停止。',
];
export const tui_sessions_access: Message = [
  'Default workspace access',
  '默认工作区访问权限',
  '預設工作區存取權限',
];
export const tui_sessions_read_only: Message = ['Read only', '只读', '唯讀'];
export const tui_sessions_workspace_write: Message = [
  'Read and write workspace',
  '读写工作区',
  '讀寫工作區',
];
export const tui_sessions_danger_full_access: Message = ['Sandbox off', '关闭沙箱', '關閉沙箱'];
export const tui_sessions_requests: Message = [
  'Allow permission requests',
  '允许请求额外权限',
  '允許請求額外權限',
];
export const tui_sessions_saved: Message = [
  'Defaults saved. New sessions use them after services finish applying the change.',
  '默认值已保存。服务应用变更后，新会话将使用此设置。',
  '預設值已儲存。服務套用變更後，新工作階段將使用此設定。',
];
export const tui_sessions_conflict: Message = [
  'Settings changed elsewhere. The current defaults have been reloaded.',
  '设置已在别处更改，已重新读取当前默认值。',
  '設定已在別處變更，已重新讀取目前預設值。',
];
export const tui_sessions_rejected: Message = [
  'The change was rejected. Review the current defaults.',
  '变更被拒绝，请检查当前默认值。',
  '變更遭拒，請檢查目前預設值。',
];
export const tui_sessions_unavailable: Message = [
  'Session defaults are unavailable.',
  '无法读取会话默认值。',
  '無法讀取工作階段預設值。',
];
export const tui_sessions_unknown: Message = [
  'The result is unresolved. Check the original operation before changing defaults again.',
  '操作结果尚未确认。再次更改前请检查原操作。',
  '操作結果尚未確認。再次變更前請檢查原操作。',
];
export const tui_settings_appearance: Message = ['Appearance', '外观', '外觀'];
export const tui_settings_assistant: Message = ['Assistant preferences', '助手偏好', '助理偏好'];
export const tui_assistant_name: Message = ['Your name', '你的称呼', '你的稱呼'];
export const tui_assistant_save: Message = ['Save personalization', '保存个性偏好', '儲存個人偏好'];
export const tui_assistant_shell_titles: Message = [
  'Shell command titles',
  'Shell 命令标题',
  'Shell 命令標題',
];

export const tui_assistant_instructions: Message = [
  'Read workspace instructions',
  '读取工作区指令',
  '讀取工作區指令',
];
export const tui_assistant_reload: Message = [
  'Reload saved preferences (discard edits)',
  '重新加载已保存偏好（放弃编辑）',
  '重新載入已儲存偏好（捨棄編輯）',
];
export const tui_assistant_saved: Message = ['Preferences saved.', '偏好已保存。', '偏好已儲存。'];
export const tui_assistant_conflict: Message = [
  'Preferences changed elsewhere. Reload saved preferences before saving again.',
  '偏好已在其他地方更改。请重新加载后再保存。',
  '偏好已在其他地方變更。請重新載入後再儲存。',
];
export const tui_assistant_invalid: Message = [
  'Check the name (256 characters) and tone (4096 characters), then try again.',
  '请检查称呼（最多 256 字符）和语气（最多 4096 字符）。',
  '請檢查稱呼（最多 256 字元）和語氣（最多 4096 字元）。',
];
export const tui_assistant_unavailable: Message = [
  'Preferences are unavailable. Try reloading.',
  '暂时无法读取偏好，请重新加载。',
  '暫時無法讀取偏好，請重新載入。',
];
export const tui_assistant_unknown: Message = [
  'The save result is unconfirmed. Check the original operation.',
  '保存结果尚未确认，请查询原操作。',
  '儲存結果尚未確認，請查詢原操作。',
];
export const tui_settings_interface: Message = ['Interface', '界面', '介面'];
export const tui_settings_models: Message = ['Models', '模型', '模型'];
export const tui_settings_sessions: Message = ['Sessions', '会话', '工作階段'];
export const tui_settings_palette: Message = ['Palette', '配色', '配色'];
export const tui_settings_language: Message = ['Language', '语言', '語言'];
export const tui_settings_symbols: Message = ['Icons', '图标', '圖示'];
export const tui_settings_motion: Message = ['Motion', '动态效果', '動態效果'];
export const tui_settings_palette_dark: Message = ['Maka dark', 'Maka 深色', 'Maka 深色'];
export const tui_settings_palette_dusk: Message = ['Dusk', '暮色', '暮色'];
export const tui_settings_palette_paper: Message = ['Paper', '晴纸', '晴紙'];
export const tui_settings_palette_default: Message = ['Terminal default', '终端默认', '終端機預設'];
export const tui_settings_palette_custom_fallback: Message = [
  'Custom unavailable · Maka fallback',
  '自定义不可用 · 暂用 Maka',
  '自訂無法使用 · 暫用 Maka',
];
export const tui_settings_symbols_unicode: Message = ['Unicode', 'Unicode', 'Unicode'];
export const tui_settings_symbols_ascii: Message = ['ASCII', 'ASCII', 'ASCII'];
export const tui_settings_motion_on: Message = ['Subtle activity', '轻柔活动', '輕柔活動'];
export const tui_settings_motion_off: Message = ['Reduced', '已减少', '已減少'];
export const tui_settings_choose: Message = [
  'Choose { $setting } · Enter',
  '选择{ $setting } · Enter',
  '選擇{ $setting } · Enter',
];
export const tui_thinking_steps: Message = [
  '{ $title } · { $count } steps',
  '{ $title } · { $count } 步',
  '{ $title } · { $count } 步',
];
export const tui_sidebar_new_session: Message = ['New session', '新建会话', '建立工作階段'];
export const tui_sidebar_empty: Message = ['No sessions yet', '还没有会话', '尚無工作階段'];

export const tui_home_needs_connection: Message = [
  'Start a task. Connect a model when you are ready to send.',
  '先开始任务，准备发送时再连接模型。',
  '先開始任務，準備傳送時再連接模型。',
];
export const tui_home_needs_default: Message = [
  'Start a task and choose a model before sending.',
  '先开始任务，发送前选择模型。',
  '先開始任務，傳送前選擇模型。',
];
export const tui_home_setup_failed: Message = [
  'Couldn’t load model connections.',
  '未能读取模型连接。',
  '無法讀取模型連線。',
];

export const tui_home_retry: Message = ['Try again', '重试', '重試'];

export const tui_settings_host_connected: Message = ['Connected', '已连接', '已連線'];
export const tui_settings_host_connecting: Message = ['Connecting…', '正在连接…', '正在連線…'];
export const tui_settings_host_disconnected: Message = ['Not connected', '未连接', '未連線'];
export const tui_settings_host_failed: Message = ['Unavailable', '不可用', '無法使用'];

export const tui_sidebar_all: Message = ['All', '全部', '全部'];

export const tui_route_plugins: Message = ['Plugins', '插件', '外掛'];

export const tui_model_profile_adapter: Message = ['Adapter', '适配器', '配接器'];
export const tui_model_profile_default_thinking: Message = [
  'Default thinking',
  '默认思考级别',
  '預設思考層級',
];

export const tui_session_actions: Message = ['Session actions', '会话操作', '對話操作'];
export const tui_connection_actions: Message = ['Connection actions', '连接操作', '連線操作'];

export const tui_providers_no_matches: Message = [
  'No matching providers',
  '没有匹配的提供商',
  '沒有符合的供應商',
];

export const tui_session_open: Message = ['Open conversation', '打开会话', '開啟對話'];
