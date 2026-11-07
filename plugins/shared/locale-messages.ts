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

export const msg_diagnosticsSessionBusy: Message = ['Session busy', '会话正忙', '對話忙碌中'];
export const msg_diagnosticsContinuationChanged: Message = [
  'Continuation changed',
  '续跑来源已变化',
  '續跑來源已變更',
];
export const msg_diagnosticsReconciliationRequired: Message = [
  'Original outcome needs reconciliation',
  '需要核对原操作结果',
  '需要核對原操作結果',
];
export const msg_diagnosticsInvalidInput: Message = ['Invalid input', '输入无效', '輸入無效'];
export const msg_diagnosticsCancelled: Message = ['Cancelled', '已取消', '已取消'];
export const msg_diagnosticsIncomplete: Message = [
  'Model response incomplete',
  '模型响应不完整',
  '模型回應不完整',
];
export const msg_diagnosticsPersistence: Message = [
  'Event commit failed',
  '事件提交失败',
  '事件提交失敗',
];
export const msg_diagnosticsStorage: Message = [
  'Event storage failed',
  '事件存储失败',
  '事件儲存失敗',
];
export const msg_diagnosticsProviderRejected: Message = [
  'Provider rejected the request',
  '提供方拒绝了请求',
  '供應方拒絕了請求',
];
export const msg_diagnosticsProviderFailed: Message = [
  'Model provider failed',
  '模型提供方失败',
  '模型供應方失敗',
];
export const msg_diagnosticsToolFailed: Message = [
  'Tool execution failed',
  '工具执行失败',
  '工具執行失敗',
];
export const msg_diagnosticsRuntimeFailed: Message = [
  'Runtime failed',
  '运行时失败',
  '執行環境失敗',
];
export const msg_diagnosticsCleanup: Message = [
  'Cleanup unconfirmed',
  '清理尚未确认',
  '清理尚未確認',
];
export const msg_diagnosticsExecutorFailed: Message = [
  'Executor failed',
  '执行器失败',
  '執行器失敗',
];
export const msg_diagnosticsHostInterrupted: Message = [
  'Host interrupted the execution',
  '主机中断了执行',
  '主機中斷了執行',
];
export const msg_diagnosticsOutcomeUnknown: Message = ['Outcome unknown', '结果未知', '結果未知'];
export const msg_diagnosticsTitlePreparationFailed: Message = [
  'Title preparation failed',
  '标题准备失败',
  '標題準備失敗',
];

export const msg_diagnosticsTitleLabel: Message = ['Diagnostics', '诊断', '診斷'];
export const msg_diagnosticsAnswer: Message = ['Answer', '回答', '回答'];
export const msg_diagnosticsPreparation: Message = ['Message preparation', '消息准备', '訊息準備'];
export const msg_diagnosticsModelStep: Message = ['Model step', '模型步骤', '模型步驟'];
export const msg_diagnosticsTitle: Message = ['Automatic title', '自动标题', '自動標題'];
export const msg_diagnosticsEmpty: Message = [
  'No recorded failures',
  '没有已记录的失败',
  '沒有已記錄的失敗',
];
export const msg_diagnosticsPreparationFailed: Message = [
  'Message preparation failed',
  '消息准备失败',
  '訊息準備失敗',
];
export const msg_diagnosticsExecutionFailed: Message = ['Execution failed', '执行失败', '執行失敗'];
export const msg_diagnosticsStepFailed: Message = [
  'Model step failed',
  '模型步骤失败',
  '模型步驟失敗',
];
export const msg_diagnosticsTimedOut: Message = ['Timed out', '请求超时', '請求逾時'];
export const msg_diagnosticsContextOverflow: Message = [
  'Context limit exceeded',
  '超过上下文限制',
  '超過上下文限制',
];
export const msg_diagnosticsAdapter: Message = [
  'Model adapter failed',
  '模型适配器失败',
  '模型配接器失敗',
];
export const msg_diagnosticsNetwork: Message = ['Network failure', '网络失败', '網路失敗'];
export const msg_diagnosticsRateLimit: Message = ['Rate limited', '请求被限流', '請求受到速率限制'];
export const msg_diagnosticsProviderUnavailable: Message = [
  'Provider unavailable',
  '提供方不可用',
  '供應方無法使用',
];
export const msg_diagnosticsStreamTruncated: Message = [
  'Response stream interrupted',
  '响应流中断',
  '回應串流中斷',
];
export const msg_diagnosticsInvalidOutput: Message = ['Invalid output', '输出无效', '輸出無效'];
export const msg_diagnosticsOutputLimit: Message = [
  'Output limit reached',
  '达到输出限制',
  '達到輸出限制',
];
export const msg_diagnosticsEmptyOutput: Message = ['Empty output', '输出为空', '輸出為空'];

export const msg_historyModel: Message = ['Model', '模型', '模型'];
export const msg_historyRequestedModel: Message = ['Requested model', '请求模型', '請求模型'];
export const msg_historyImportedModel: Message = ['Imported model', '导入来源模型', '匯入來源模型'];

export const msg_workhubTask: Message = ['WorkHub task', 'WorkHub 任务', 'WorkHub 任務'];
export const msg_workhubGraph: Message = ['WorkHub graph', 'WorkHub 图', 'WorkHub 圖'];

export const msg_graphEpoch: Message = ['View epoch', '查看轮次', '查看輪次'];
export const msg_graphChanged: Message = [
  'The epoch changed. Review the current state before trying again.',
  '轮次已变化，请查看当前状态后重试。',
  '輪次已變更，請查看目前狀態後重試。',
];
export const msg_graphBusy: Message = [
  'Stop the current epoch and wait for original work and queued messages to settle before restarting.',
  '请先停止当前轮次，等待原工作及排队消息结束后再重新开始。',
  '請先停止目前輪次，等待原工作及佇列訊息結束後再重新開始。',
];
export const msg_graphConflict: Message = [
  'Use an unarchived Agent conversation with no active Goal.',
  '请使用未归档、没有活动 Goal 的 Agent 对话。',
  '請使用未封存、沒有活動 Goal 的 Agent 對話。',
];
export const msg_graphIncognito: Message = [
  'Graph and Swarm require persistent conversation history.',
  'Graph 和 Swarm 需要持久保存对话历史。',
  'Graph 和 Swarm 需要持久保存對話歷史。',
];
export const msg_graphStatus_closing: Message = ['Stopping', '停止中', '停止中'];
export const msg_graphTitle: Message = ['Graph / Swarm', 'Graph / Swarm', 'Graph / Swarm'];
export const msg_graphMode: Message = ['Mode', '模式', '模式'];
export const msg_graphOrdinary: Message = ['Ordinary conversation', '普通对话', '一般對話'];
export const msg_graphSettling: Message = [
  'Waiting for original work to settle',
  '等待原工作结束',
  '等待原工作結束',
];
export const msg_graphRejected: Message = [
  'Action could not be applied',
  '操作未生效',
  '操作未生效',
];
export const msg_graphUnavailable: Message = [
  'Graph is unavailable. Retry the original operation.',
  'Graph 暂不可用，请检查原操作。',
  'Graph 暫不可用，請檢查原操作。',
];
export const msg_graphReadOnly: Message = [
  'Historical epoch · read only',
  '历史轮次 · 只读',
  '歷史輪次 · 唯讀',
];
export const msg_graphCurrent: Message = ['Current epoch', '当前轮次', '目前輪次'];
export const msg_graphRestart: Message = ['Restart Graph', '重新开始 Graph', '重新開始 Graph'];
export const msg_graphRestartSwarm: Message = ['Restart Swarm', '重新开始 Swarm', '重新開始 Swarm'];
export const msg_graphStart: Message = ['Start Graph', '启动 Graph', '啟動 Graph'];
export const msg_graphStartSwarm: Message = ['Start Swarm', '启动 Swarm', '啟動 Swarm'];
export const msg_graphStop: Message = ['Stop epoch', '停止本轮', '停止本輪'];
export const msg_graphLeave: Message = [
  'Use ordinary conversation',
  '切换普通对话',
  '切換一般對話',
];
export const msg_graphHelp: Message = [
  'Choose Graph or Swarm while idle, then send your request. Stop waits for original workers; restart keeps earlier results in history.',
  '空闲时选择 Graph 或 Swarm，再发送请求。停止会等待原工作结束；重新开始仍可查阅历史结果。',
  '閒置時選擇 Graph 或 Swarm，再傳送請求。停止會等待原工作結束；重新開始仍可查閱歷史結果。',
];
export const msg_graphHistory: Message = ['Epoch history', '轮次历史', '輪次歷史'];
export const msg_graphInstruction: Message = ['Full instruction', '完整指令', '完整指令'];
export const msg_graphResult: Message = ['Read result', '读取结果', '讀取結果'];
export const msg_graphSelected: Message = ['Selected final result', '已选最终结果', '已選最終結果'];
export const msg_graphFinal: Message = ['Final selection', '最终选择', '最終選擇'];
export const msg_graphEmpty: Message = [
  'No delegated work in this epoch.',
  '本轮尚无委派工作。',
  '本輪尚無委派工作。',
];
export const msg_graphStatus_empty: Message = ['Empty', '空', '空'];
export const msg_graphStatus_active: Message = ['Active', '进行中', '進行中'];
export const msg_graphStatus_waiting: Message = ['Waiting', '等待中', '等待中'];
export const msg_graphStatus_failed: Message = ['Failed', '失败', '失敗', '실패'];
export const msg_graphStatus_finished: Message = ['Finished', '已完成', '已完成'];
export const msg_graphStatus_stopped: Message = ['Stopped', '已停止', '已停止'];
export const msg_graphStatus_requested: Message = ['Requested', '已请求', '已請求'];
export const msg_graphStatus_running: Message = ['Running', '运行中', '執行中'];
export const msg_graphStatus_completed: Message = ['Completed', '已完成', '已完成'];
export const msg_graphStatus_cancelled: Message = ['Cancelled', '已取消', '已取消'];
export const msg_graphStatus_blocked: Message = ['Needs attention', '需要处理', '需要處理'];
export const msg_graphStatus_superseded: Message = ['Replaced', '已替换', '已替換'];
export const msg_goalTitle: Message = ['Goal', '持续目标', '持續目標'];
export const msg_goalConfirm: Message = ['Confirm Goal', '确认目标', '確認目標'];
export const msg_goalLoading: Message = ['Loading Goal…', '正在读取目标…', '正在讀取目標…'];
export const msg_goalUnavailable: Message = [
  'Unable to read or update this Goal. Check its saved status.',
  '无法读取或更新目标，请核对已保存的状态。',
  '無法讀取或更新目標，請核對已儲存的狀態。',
];
export const msg_goalDisabled: Message = [
  'Goals are disabled for this agent.',
  '此助手未启用持续目标。',
  '此助手未啟用持續目標。',
];
export const msg_goalChanged: Message = [
  'The Goal changed. Review its current status before applying this action.',
  '目标状态已变化，请核对后再操作。',
  '目標狀態已變更，請核對後再操作。',
];
export const msg_goalRejected: Message = [
  'The Goal was not changed. Check the current Goal, model and session permissions.',
  '目标未更改，请检查当前目标、模型和会话权限。',
  '目標未變更，請檢查目前目標、模型和工作階段權限。',
];
export const msg_goalInvalid: Message = [
  'Enter an objective, 1–100 iterations, and an optional token threshold from 1 to 1 billion.',
  '请填写目标、1–100 的轮数，以及可选的 1–10 亿 token 阈值。',
  '請填寫目標、1–100 的輪數，以及選填的 1–10 億 token 門檻。',
];
export const msg_goalObjective: Message = ['Objective', '目标内容', '目標內容'];
export const msg_goalIterations: Message = ['Iterations', '轮数上限', '輪數上限'];
export const msg_goalTokens: Message = [
  'Token threshold (optional)',
  'Token 阈值（可选）',
  'Token 門檻（選填）',
];
export const msg_goalUnknownTokens: Message = [
  'Some usage is unknown',
  '部分用量未知',
  '部分用量未知',
];
export const msg_goalNoBudget: Message = [
  'No token threshold',
  '未设 token 阈值',
  '未設 token 門檻',
];
export const msg_goalPending: Message = [
  'The current iteration is still settling. Pause stops later iterations.',
  '当前一轮尚未结束；暂停会停止后续轮次。',
  '目前一輪尚未結束；暫停會停止後續輪次。',
];
export const msg_goalChooseModel: Message = [
  'Select a model to create or resume a Goal.',
  '请选择模型后创建或继续目标。',
  '請選擇模型後建立或繼續目標。',
];
export const msg_goalStart: Message = ['Start Goal', '启动目标', '啟動目標'];
export const msg_goalSave: Message = ['Save for later', '保存，稍后启动', '儲存，稍後啟動'];
export const msg_goalBudgetNote: Message = [
  'The token threshold counts this conversation’s usage after creation. It is checked between iterations; an iteration may exceed it.',
  'Token 阈值计入目标创建后本会话的用量，在轮次之间检查；单轮可能超出。',
  'Token 門檻計入目標建立後本工作階段的用量，在輪次之間檢查；單輪可能超出。',
];
export const msg_goalApproval: Message = [
  'Allow this model to continue across turns using this conversation’s current workspace and permissions. Model charges may apply.',
  '允许此模型按本会话当前工作区和权限跨轮持续执行，可能产生模型费用。',
  '允許此模型依本工作階段目前工作區和權限跨輪持續執行，可能產生模型費用。',
];
export const msg_goalCancelNote: Message = [
  'Stop later iterations and request cancellation of the current Goal execution. Wait for its saved result before starting another Goal.',
  '停止后续轮次，并请求取消目标当前执行。请等待保存的结果后再创建新目标。',
  '停止後續輪次，並請求取消目標目前的執行。請等待儲存的結果後再建立新目標。',
];
export const msg_goalCompleteNote: Message = [
  'Mark this Goal achieved based on your review.',
  '根据你的检查，将目标标记为已达成。',
  '依你的檢查，將目標標記為已達成。',
];
export const msg_goalCheckCancel: Message = ['Check cancellation', '核对取消状态', '核對取消狀態'];
export const msg_goalAction_resume: Message = ['Resume Goal', '继续目标', '繼續目標'];
export const msg_goalAction_pause: Message = ['Pause Goal', '暂停目标', '暫停目標'];
export const msg_goalAction_cancel: Message = ['Cancel Goal', '取消目标', '取消目標'];
export const msg_goalAction_complete: Message = ['Mark achieved', '标记已达成', '標記已達成'];
export const msg_goalStatus_armed: Message = ['Ready to start', '待启动', '待啟動'];
export const msg_goalStatus_active: Message = ['Working', '进行中', '進行中'];
export const msg_goalStatus_paused: Message = ['Paused', '已暂停', '已暫停'];
export const msg_goalStatus_waiting: Message = ['Waiting for you', '等待你的回复', '等待你的回覆'];
export const msg_goalStatus_achieved: Message = ['Achieved', '已达成', '已達成'];
export const msg_goalStatus_impossible: Message = ['Not possible', '无法达成', '無法達成'];
export const msg_goalStatus_cancelled: Message = ['Cancelled', '已取消', '已取消'];
export const msg_goalStatus_cancellation_unknown: Message = [
  'Cancellation unconfirmed',
  '取消未确认',
  '取消未確認',
];
export const msg_goalStatus_max_iterations: Message = [
  'Iteration limit reached',
  '已达轮数上限',
  '已達輪數上限',
];
export const msg_goalStatus_budget_limited: Message = [
  'Token threshold reached',
  '已达 token 阈值',
  '已達 token 門檻',
];
export const msg_goalStatus_budget_unknown: Message = [
  'Token usage unknown',
  'Token 用量未知',
  'Token 用量未知',
];
export const msg_goalStatus_blocked: Message = ['Needs attention', '需要检查', '需要檢查'];
export const msg_recapTitle: Message = ['Session recap', '会话回顾', '對話回顧'];
export const msg_recapEmpty: Message = [
  'No saved recap yet.',
  '还没有保存的回顾。',
  '還沒有儲存的回顧。',
];
export const msg_recapLoading: Message = [
  'Reading saved recap…',
  '正在读取已保存的回顾…',
  '正在讀取已儲存的回顧…',
];
export const msg_recapPending: Message = [
  'Generation is pending or its outcome is unknown. Refresh reads the original result without generating again.',
  '生成尚未完成或结果未知。刷新只读取原始结果，不会再次生成。',
  '生成尚未完成或結果未知。重新整理僅讀取原始結果，不會再次生成。',
];
export const msg_recapFailed: Message = [
  'The recap is unavailable. Refresh to check the saved result.',
  '回顾暂不可用。请刷新检查已保存的结果。',
  '回顧暫不可用。請重新整理檢查已儲存的結果。',
];
export const msg_recapRefresh: Message = [
  'Refresh saved result',
  '刷新已保存的结果',
  '重新整理已儲存的結果',
];
export const msg_recapGenerate: Message = ['Generate a new recap', '生成新的回顾', '生成新的回顧'];
export const msg_recapConfirm: Message = ['Generate recap', '生成回顾', '生成回顧'];
export const msg_recapFee: Message = [
  'This sends conversation history to the selected model and may incur model charges:',
  '将会话历史发送给所选模型，可能产生模型费用：',
  '將對話歷史傳送給所選模型，可能產生模型費用：',
];
export const msg_recapModel: Message = [
  'Select a model to generate a recap.',
  '请选择模型以生成回顾。',
  '請選擇模型以生成回顧。',
];
export const msg_recapSaved: Message = ['Saved recap', '已保存的回顾', '已儲存的回顧'];
export const msg_checklistTitle: Message = ['Checklist', '清单', '清單'];
export const msg_checklistLoading: Message = [
  'Loading checklist…',
  '正在加载清单…',
  '正在載入清單…',
];
export const msg_checklistRetry: Message = ['Retry', '重试', '重試', '다시 시도'];
export const msg_checklistEmpty: Message = [
  'No checklist yet. The agent keeps one here as it works.',
  '还没有清单。智能体工作时会在这里维护。',
  '還沒有清單。智慧體工作時會在這裡維護。',
];
export const msg_checklistReported: Message = [
  'Progress reported by the agent.',
  '进度由智能体报告。',
  '進度由智慧體回報。',
];
export const msg_checklistFailed: Message = [
  'Unable to load the checklist.',
  '无法加载清单。',
  '無法載入清單。',
];
export const msg_scheduleTitle: Message = ['Scheduled tasks', '定时任务', '定時任務'];
export const msg_scheduleNew: Message = ['New task', '新建任务', '新增任務'];
export const msg_scheduleEmpty: Message = [
  'No scheduled tasks.',
  '暂无定时任务。',
  '尚無定時任務。',
];
export const msg_scheduleName: Message = ['Title', '标题', '標題'];
export const msg_scheduleBody: Message = [
  'Instructions or reminder',
  '执行指令或提醒内容',
  '執行指示或提醒內容',
];
export const msg_scheduleTiming: Message = ['Schedule', '时间安排', '時間安排'];
export const msg_scheduleOnce: Message = ['Once', '单次', '單次'];
export const msg_scheduleInterval: Message = ['Interval', '固定间隔', '固定間隔'];
export const msg_scheduleDaily: Message = ['Daily', '每天', '每天'];
export const msg_scheduleWeekly: Message = ['Weekly', '每周', '每週'];
export const msg_scheduleMonthly: Message = ['Monthly', '每月', '每月'];
export const msg_scheduleAt: Message = ['Start time', '开始时间', '開始時間'];
export const msg_scheduleTimeHint: Message = [
  'ISO time, e.g. 2026-10-12T09:00:00+08:00. Z means UTC.',
  '使用 ISO 时间，如 2026-10-12T09:00:00+08:00；Z 表示 UTC。',
  '使用 ISO 時間，如 2026-10-12T09:00:00+08:00；Z 表示 UTC。',
];
export const msg_scheduleSeconds: Message = ['Every (seconds)', '间隔（秒）', '間隔（秒）'];
export const msg_scheduleCron: Message = ['Cron expression', 'Cron 表达式', 'Cron 表達式'];
export const msg_scheduleZone: Message = ['Timezone', '时区', '時區'];
export const msg_scheduleMissed: Message = ['Missed triggers', '错过的触发', '錯過的觸發'];
export const msg_scheduleSkip: Message = ['Skip', '跳过', '略過'];
export const msg_scheduleLatest: Message = ['Run latest', '补执行最近一次', '補執行最近一次'];
export const msg_scheduleMax: Message = [
  'Maximum runs (optional)',
  '最多执行次数（可选）',
  '最多執行次數（選填）',
];
export const msg_scheduleExpiry: Message = [
  'Expires (optional)',
  '到期时间（可选）',
  '到期時間（選填）',
];
export const msg_scheduleEffect: Message = ['Action', '执行方式', '執行方式'];
export const msg_scheduleReminder: Message = ['Reminder', '提醒', '提醒'];
export const msg_scheduleSession: Message = ['Continue conversation', '继续对话', '繼續對話'];
export const msg_scheduleAgentRun: Message = ['New conversation', '新对话', '新對話'];
export const msg_scheduleSource: Message = [
  'Choose source conversation',
  '选择来源对话',
  '選擇來源對話',
];
export const msg_scheduleSourceHint: Message = [
  'A new conversation copies the chosen workspace and permissions.',
  '新对话使用所选对话的工作区和权限。',
  '新對話使用所選對話的工作區與權限。',
];
export const msg_scheduleReview: Message = ['Review task', '检查任务', '檢查任務'];
export const msg_scheduleConsent: Message = [
  'Allow this task to run in the background while Maka is running. Its displayed workspace, permissions and model apply to each trigger.',
  '允许此任务在 Maka 运行期间后台执行。每次触发使用此处展示的工作区、权限和模型。',
  '允許此任務在 Maka 執行期間於背景執行。每次觸發使用此處顯示的工作區、權限與模型。',
];
export const msg_scheduleReminderConsent: Message = [
  'Keep each reminder until you acknowledge it or choose a later time.',
  '每次提醒会保留到你确认或选择稍后提醒。',
  '每次提醒會保留到你確認或選擇稍後提醒。',
];
export const msg_scheduleEnable: Message = ['Approve and enable', '批准并启用', '核准並啟用'];
export const msg_scheduleSave: Message = ['Approve and save', '批准并保存', '核准並儲存'];
export const msg_schedulePause: Message = ['Pause', '暂停', '暫停'];
export const msg_scheduleResume: Message = ['Resume', '恢复', '恢復'];
export const msg_scheduleRun: Message = ['Run now', '立即执行', '立即執行'];
export const msg_scheduleHistory: Message = ['Run history', '执行历史', '執行歷史'];
export const msg_scheduleClear: Message = ['Clear history', '清除历史', '清除歷史'];
export const msg_scheduleDelete: Message = ['Delete task', '删除任务', '刪除任務'];
export const msg_scheduleDeleteHelp: Message = [
  'Delete this task and its history?',
  '删除此任务及其历史记录？',
  '刪除此任務及其歷史紀錄？',
];
export const msg_scheduleClearHelp: Message = [
  'Clear recorded history? The total run count stays unchanged.',
  '清除历史记录？累计执行次数仍会保留。',
  '清除歷史紀錄？累計執行次數仍會保留。',
];
export const msg_scheduleActive: Message = ['Active', '已启用', '已啟用'];
export const msg_schedulePaused: Message = ['Paused', '已暂停', '已暫停'];
export const msg_scheduleCompleted: Message = ['Completed', '已完成', '已完成'];
export const msg_scheduleExpired: Message = ['Expired', '已到期', '已到期'];
export const msg_scheduleApproval: Message = ['Needs approval', '待批准', '待核准'];
export const msg_schedulePending: Message = ['Trigger pending', '等待处理触发', '等待處理觸發'];
export const msg_scheduleNext: Message = ['Next', '下次', '下次'];
export const msg_scheduleCount: Message = ['Triggers', '触发次数', '觸發次數'];
export const msg_scheduleDone: Message = ['Acknowledge', '确认提醒', '確認提醒'];
export const msg_scheduleSnooze: Message = ['Remind in 5 minutes', '5 分钟后提醒', '5 分鐘後提醒'];
export const msg_scheduleSaved: Message = ['Task saved.', '任务已保存。', '任務已儲存。'];
export const msg_scheduleChanged: Message = [
  'The task changed. Reload it before making this change.',
  '任务已变化，请重新加载后操作。',
  '任務已變更，請重新載入後操作。',
];
export const msg_scheduleInvalid: Message = [
  'Check the title, instructions, time, interval and limits.',
  '请检查标题、指令、时间、间隔与次数限制。',
  '請檢查標題、指示、時間、間隔與次數限制。',
];
export const msg_scheduleUnavailable: Message = [
  'Scheduled tasks are unavailable. Try again.',
  '定时任务暂不可用，请重试。',
  '定時任務暫時無法使用，請重試。',
];
export const msg_scheduleTargetChanged: Message = [
  'The source conversation or model changed. Edit the task and choose its target again.',
  '来源对话或模型已变化，请编辑任务并重新选择目标。',
  '來源對話或模型已變更，請編輯任務並重新選擇目標。',
];
export const msg_scheduleChooseTarget: Message = [
  'Choose a source conversation and model.',
  '请选择来源对话和模型。',
  '請選擇來源對話與模型。',
];
export const msg_scheduleUnknown: Message = [
  'The result is not known yet. Check the original operation before making another change.',
  '结果尚不确定，请先查询原操作再进行其他更改。',
  '結果尚未確定，請先查詢原操作再進行其他變更。',
];
export const msg_scheduleAdmitted: Message = ['Message admitted', '消息已接收', '訊息已接收'];
export const msg_scheduleAcknowledged: Message = [
  'Reminder acknowledged',
  '提醒已确认',
  '提醒已確認',
];
export const msg_scheduleBlocked: Message = ['Blocked', '受阻', '受阻'];
export const msg_scheduleFailed: Message = ['Failed', '失败', '失敗'];
export const msg_scheduleNoHistory: Message = ['No triggers yet.', '尚未触发。', '尚未觸發。'];
export const msg_scheduleReadOnly: Message = ['Read-only workspace', '只读工作区', '唯讀工作區'];
export const msg_scheduleWorkspaceWrite: Message = [
  'Workspace write access',
  '可写工作区',
  '可寫入工作區',
];
export const msg_scheduleAdditional: Message = [
  'May request additional permissions',
  '可以申请额外权限',
  '可以申請額外權限',
];
export const msg_appsTitle: Message = ['Apps', '应用', '應用程式'];
export const msg_appsEmpty: Message = [
  'No apps yet. Add an app or install a package.',
  '还没有应用。添加应用或安装插件包。',
  '還沒有應用程式。加入應用程式或安裝外掛套件。',
];
export const msg_appsAdd: Message = ['Add app', '添加应用', '新增應用程式'];
export const msg_appsChoose: Message = ['Choose an app', '选择应用', '選擇應用程式'];
export const msg_appsInstall: Message = ['Install package', '安装插件包', '安裝套件'];
export const msg_appsName: Message = ['App name', '应用名称', '應用程式名稱'];
export const msg_appsConfigure: Message = ['Configure app', '配置应用', '設定應用程式'];
export const msg_appsBindings: Message = ['Connections', '连接能力', '連接能力'];
export const msg_appsBindingHelp: Message = [
  'Choose the capabilities this app can use.',
  '选择此应用可以使用的能力。',
  '選擇此應用程式可使用的能力。',
];
export const msg_appsNoCandidates: Message = [
  'No compatible apps. Install a package to add one.',
  '没有可添加的应用。请先安装插件包。',
  '沒有可加入的應用程式。請先安裝外掛套件。',
];
export const msg_appsClose: Message = ['Close app', '关闭应用', '關閉應用程式'];
export const msg_appsRemove: Message = ['Remove from Apps', '从应用列表移除', '從應用程式列表移除'];
export const msg_appsRemoveHelp: Message = [
  'Remove this app from the list. Its plugin and saved data remain installed.',
  '从列表移除此应用。插件和已保存的数据仍会保留。',
  '從列表移除此應用程式。外掛與已儲存資料仍會保留。',
];
export const msg_appsRemoved: Message = ['App removed.', '已移除应用。', '已移除應用程式。'];
export const msg_appsAdded: Message = ['App added.', '已添加应用。', '已新增應用程式。'];
export const msg_appsPackageAdded: Message = [
  'Package installed. Choose an app below.',
  '已安装插件包。请在下方选择应用。',
  '已安裝外掛套件。請在下方選擇應用程式。',
];
export const msg_appsManage: Message = ['Manage plugins', '管理插件', '管理外掛'];
export const msg_appsReview: Message = ['Review app', '检查应用', '檢查應用程式'];
export const msg_appsConfirm: Message = ['Add app', '添加应用', '新增應用程式'];
export const msg_appsUnknown: Message = [
  'The result is not known yet. Check the original operation before making another change.',
  '结果尚未确认。再次修改前请检查原操作。',
  '結果尚未確認。再次修改前請檢查原操作。',
];
export const msg_appsUnavailable: Message = [
  'This action is unavailable. Reload the app list and try again.',
  '暂时无法完成。请重新加载应用列表后重试。',
  '暫時無法完成。請重新載入應用程式列表後重試。',
];
export const msg_appsChanged: Message = [
  'The app configuration changed. Reload before editing.',
  '应用配置已变化，请重新加载后编辑。',
  '設定已變更，請重新載入後編輯。',
];
export const msg_appsInvalid: Message = [
  'Check the name, settings, and connections.',
  '请检查名称、设置和连接。',
  '請檢查名稱、設定與連接。',
];
export const msg_appsReload: Message = ['Refresh', '刷新', '重新整理'];
export const msg_appsNoSettings: Message = [
  'This app has no settings.',
  '此应用没有配置项。',
  '此應用程式沒有設定項目。',
];
export const msg_appsBindingClear: Message = ['Clear selection', '清除选择', '清除選擇'];
export const msg_appsContinue: Message = ['Continue', '继续', '繼續'];
export const msg_appsBindingsMissing: Message = [
  'Choose all required connections before adding the app.',
  '添加应用前请选择所有必需连接。',
  '新增應用程式前請選擇所有必要連接。',
];
export const msg_appsExistingHelp: Message = [
  'This adds an existing component to Apps. Its settings and connections stay with that instance.',
  '将已有组件添加到应用列表，沿用原实例的设置和连接。',
  '將現有元件加入應用程式清單，沿用原實例的設定與連接。',
];
export const msg_appsSetupHelp: Message = [
  'Settings and connections apply to this new instance only.',
  '设置和连接只应用于此新实例。',
  '設定與連接僅套用於此新實例。',
];
export const msg_appsConfirmHelp: Message = [
  'Add this component with the settings and connections shown.',
  '使用显示的设置和连接添加此组件。',
  '使用顯示的設定與連接新增此元件。',
];
export const msg_recallTitle: Message = ['Search conversations', '搜索对话', '搜尋對話'];
export const msg_recallIntro: Message = [
  'Find what was said in earlier conversations.',
  '在以前的对话中查找说过的内容。',
  '在以前的對話中尋找說過的內容。',
];
export const msg_recallFind: Message = ['Find', '查找', '尋找'];
export const msg_recallAll: Message = ['All conversations', '全部对话', '全部對話'];
export const msg_recallChoose: Message = ['Choose conversation', '选择对话', '選擇對話'];
export const msg_recallSince: Message = ['From (UTC date)', '起始日期（UTC）', '起始日期（UTC）'];
export const msg_recallUntil: Message = [
  'Through (UTC date)',
  '结束日期（UTC）',
  '結束日期（UTC）',
];
export const msg_recallDateHint: Message = [
  'YYYY-MM-DD; leave blank for no date bound.',
  '使用 YYYY-MM-DD；留空表示不限制日期。',
  '使用 YYYY-MM-DD；留空表示不限制日期。',
];
export const msg_recallInvalid: Message = [
  'Use 1–8 words and valid UTC dates. From must not follow Through.',
  '请输入 1–8 个词和有效的 UTC 日期；起始日期不得晚于结束日期。',
  '請輸入 1–8 個詞和有效的 UTC 日期；起始日期不得晚於結束日期。',
];
export const msg_recallUnavailable: Message = [
  'History search is unavailable. Try again.',
  '暂时无法搜索历史，请重试。',
  '暫時無法搜尋歷史，請重試。',
];
export const msg_recallEmpty: Message = [
  'Nothing matched.',
  '没有匹配的内容。',
  '沒有符合的內容。',
];
export const msg_recallPartial: Message = [
  'Some history could not be searched.',
  '部分历史未能搜索。',
  '部分歷史未能搜尋。',
];
export const msg_recallOpen: Message = ['Open conversation', '打开对话', '開啟對話'];
export const msg_importsTitle: Message = ['Import conversations', '导入对话', '匯入對話'];

export const msg_importsAdd: Message = ['Add source', '添加来源', '新增來源'];
export const msg_importsEdit: Message = ['Edit source', '编辑来源', '編輯來源'];
export const msg_importsRemove: Message = ['Remove source', '移除来源', '移除來源'];
export const msg_importsRemoveHelp: Message = [
  'Remove this source? Imported conversations remain in Maka.',
  '移除此来源？已导入的对话会保留在 Maka 中。',
  '移除此來源？已匯入的對話會保留在 Maka 中。',
];
export const msg_importsEmpty: Message = [
  'No sources yet. Choose where another tool stores its conversations.',
  '尚无来源。请选择其它工具保存对话的目录。',
  '尚無來源。請選擇其他工具儲存對話的目錄。',
];
export const msg_importsName: Message = ['Source name', '来源名称', '來源名稱'];
export const msg_importsDatabase: Message = ['Database filename', '数据库文件名', '資料庫檔案名稱'];
export const msg_importsChooseSource: Message = [
  'Choose source directory',
  '选择来源目录',
  '選擇來源目錄',
];
export const msg_importsSourceHelp: Message = [
  'Select the Codex or Claude Code data directory, or the directory containing the OpenCode database.',
  '选择 Codex 或 Claude Code 数据目录，或 OpenCode 数据库所在目录。',
  '選擇 Codex 或 Claude Code 資料目錄，或 OpenCode 資料庫所在目錄。',
];
export const msg_importsHistory: Message = [
  'Imported conversations',
  '已导入的对话',
  '已匯入的對話',
];
export const msg_importsHistoryEmpty: Message = [
  'No conversations have been imported yet.',
  '尚未导入对话。',
  '尚未匯入對話。',
];
export const msg_importsCatalogEmpty: Message = [
  'No matching conversations in this source.',
  '此来源中没有匹配的对话。',
  '此來源中沒有符合的對話。',
];
export const msg_importsSearch: Message = ['Search conversations', '搜索对话', '搜尋對話'];
export const msg_importsArchived: Message = ['Include archived', '包含已归档', '包含已封存'];
export const msg_importsPreview: Message = ['Preview conversation', '预览对话', '預覽對話'];
export const msg_importsDestination: Message = ['Destination directory', '目标目录', '目標目錄'];
export const msg_importsChooseDestination: Message = [
  'Choose destination',
  '选择目标目录',
  '選擇目標目錄',
];
export const msg_importsConversationName: Message = ['Conversation name', '对话名称', '對話名稱'];
export const msg_importsConfirm: Message = ['Import conversation', '导入对话', '匯入對話'];
export const msg_importsReview: Message = ['Review import', '确认导入内容', '確認匯入內容'];
export const msg_importsHelp: Message = [
  'Source files stay in place. Source paths, models and tool calls are historical information; they do not authorize or run anything.',
  '来源文件保留原位。来源路径、模型和工具调用仅作为历史信息，不授予权限或执行操作。',
  '來源檔案保留原位。來源路徑、模型和工具呼叫僅作為歷史資訊，不授予權限或執行操作。',
];
export const msg_importsChanged: Message = [
  'The source or destination changed. Refresh and review it again.',
  '来源或目标已变化，请刷新后重新核对。',
  '來源或目標已變更，請重新整理後再次核對。',
];
export const msg_importsUnavailable: Message = [
  'The selected source or directory is unavailable. Choose it again.',
  '所选来源或目录不可用，请重新选择。',
  '所選來源或目錄無法使用，請重新選擇。',
];
export const msg_importsInvalid: Message = [
  'This source cannot be imported. Check its format and the selected conversation.',
  '无法导入此来源，请检查格式和所选对话。',
  '無法匯入此來源，請檢查格式與所選對話。',
];
export const msg_importsLimit: Message = [
  'The source exceeds the import limit. No partial conversation was published.',
  '来源超过导入上限，未发布不完整的对话。',
  '來源超過匯入上限，未發布不完整的對話。',
];
export const msg_importsUnknown: Message = [
  'The result is not confirmed. Read the original receipt before continuing.',
  '结果尚未确认，请读取原操作回执后再继续。',
  '結果尚未確認，請讀取原操作回執後再繼續。',
];
export const msg_importsSaved: Message = ['Source saved.', '来源已保存。', '來源已儲存。'];
export const msg_importsRemoved: Message = ['Source removed.', '来源已移除。', '來源已移除。'];
export const msg_importsDone: Message = ['Conversation imported.', '对话已导入。', '對話已匯入。'];
export const msg_importsOpen: Message = ['Open conversation', '打开对话', '開啟對話'];
export const msg_importsRecords: Message = ['Records', '记录数', '紀錄數'];
export const msg_importsIncomplete: Message = [
  'The source ends with an unfinished write. That incomplete final record will be omitted.',
  '来源末尾存在未完成的写入，将忽略该条不完整记录。',
  '來源末尾存在未完成的寫入，將略過該筆不完整紀錄。',
];
export const msg_importsTruncated: Message = [
  'Preview shortened; the complete text is preserved on import.',
  '预览已缩短，导入时会保留完整正文。',
  '預覽已縮短，匯入時會保留完整內文。',
];
export const msg_importsUser: Message = ['User', '用户', '使用者'];
export const msg_importsAssistant: Message = ['Assistant', '助手', '助理'];
export const msg_importsToolCall: Message = ['Tool call', '工具调用', '工具呼叫'];
export const msg_importsToolResult: Message = ['Tool result', '工具结果', '工具結果'];
export const msg_importsNote: Message = ['Note', '备注', '備註'];
export const msg_projectsUseDirectory: Message = ['Use this directory', '使用此目录', '使用此目錄'];
export const msg_projectsTitle: Message = ['Projects', '项目', '專案'];
export const msg_projectsAdd: Message = ['Add directory', '登记目录', '登記目錄'];
export const msg_projectsEmpty: Message = [
  'No projects yet. Add a working directory to begin.',
  '还没有项目，请先登记工作目录。',
  '尚無專案，請先登記工作目錄。',
];
export const msg_projectsRename: Message = ['Rename', '重命名', '重新命名'];
export const msg_projectsName: Message = ['Project name', '项目名称', '專案名稱'];
export const msg_projectsArchive: Message = ['Archive', '归档', '封存'];
export const msg_projectsRestore: Message = ['Restore', '恢复', '還原'];
export const msg_projectsRelocate: Message = ['Relocate', '重新定位', '重新定位'];
export const msg_projectsArchived: Message = ['Archived', '已归档', '已封存'];
export const msg_projectsUnavailable: Message = [
  'Directory unavailable',
  '目录不可用',
  '目錄無法使用',
];
export const msg_projectsArchiveHelp: Message = [
  'Existing conversations remain readable. Restore this project before creating a conversation.',
  '现有会话仍可阅读。恢复项目后才能创建会话。',
  '現有對話仍可閱讀。還原專案後才能建立對話。',
];
export const msg_projectsRelocateHelp: Message = [
  'Project conversations will use this directory. Previous directory grants will expire.',
  '项目会话将改用此目录，旧目录授权随之失效。',
  '專案對話將改用此目錄，舊目錄授權隨之失效。',
];
export const msg_projectsMergeHelp: Message = [
  'This directory belongs to another project. Its conversations will join this project.',
  '此目录已属于另一个项目，其会话将合并到当前项目。',
  '此目錄已屬於另一專案，其對話將合併至目前專案。',
];
export const msg_projectsChanged: Message = [
  'Projects changed. Refresh and review before trying again.',
  '项目已变化，请刷新核对后再操作。',
  '專案已變更，請重新整理並確認後再操作。',
];
export const msg_projectsBusy: Message = [
  'Finish or cancel running and queued work before relocating.',
  '请先结束或取消运行中及排队的任务，再重新定位。',
  '請先結束或取消執行中及排隊的工作，再重新定位。',
];
export const msg_projectsInvalid: Message = [
  'Enter a name of 1–256 characters without control characters.',
  '名称须为 1–256 个字符，不能包含控制字符。',
  '名稱須為 1–256 個字元，且不能包含控制字元。',
];
export const msg_projectsFailed: Message = [
  'Could not read projects. Refresh to try again.',
  '无法读取项目，请刷新重试。',
  '無法讀取專案，請重新整理重試。',
];
export const msg_projectsUnknown: Message = [
  'The original result is unconfirmed. Check its receipt.',
  '原操作结果尚未确认，请查询回执。',
  '原操作結果尚未確認，請查詢回執。',
];
export const msg_projectsSaved: Message = ['Project updated.', '项目已更新。', '專案已更新。'];

export const msg_projectsChecking: Message = [
  'Checking original operations…',
  '正在核对原操作…',
  '正在核對原操作…',
];
export const msg_projectsActions: Message = ['Project actions', '项目操作', '專案操作'];
export const msg_executionBackend: Message = ['Execution backend', '执行后端', '執行後端'];
export const msg_executionCheck: Message = ['Check backend', '检查后端', '檢查後端'];
export const msg_executionAuthenticate: Message = ['Sign in', '登录', '登入'];
export const msg_executionUnsupported: Message = [
  'This method requires an unsupported login flow.',
  '此方法需要尚未支持的登录流程。',
  '此方法需要尚未支援的登入流程。',
];
export const msg_executionNoAuth: Message = [
  'The backend offers no login methods.',
  '后端未提供登录方法。',
  '後端未提供登入方法。',
];
export const msg_executionChecking: Message = [
  'Checking / signing in…',
  '正在检查／登录…',
  '正在檢查／登入…',
];
export const msg_executionCancelling: Message = [
  'Stopping; waiting for cleanup…',
  '正在停止，等待清理完成…',
  '正在停止，等待清理完成…',
];
export const msg_executionCancel: Message = ['Cancel setup', '取消设置', '取消設定'];
export const msg_executionCopyUrl: Message = [
  'Copy authorization URL',
  '复制授权链接',
  '複製授權連結',
];
export const msg_executionAuthenticated: Message = [
  'Authentication confirmed.',
  '登录已确认。',
  '登入已確認。',
];
export const msg_executionUnresolved: Message = [
  'The original result or cleanup is unconfirmed. Check its receipt before attempting another login.',
  '原操作结果或清理尚未确认，请查询原回执后再决定是否重新登录。',
  '原操作結果或清理尚未確認，請查詢原回執後再決定是否重新登入。',
];
export const msg_executionReceipt: Message = ['View result', '查看结果', '檢視結果'];
export const msg_executionModel: Message = ['Connected model', '已连接模型', '已連接模型'];
export const msg_executionModelName: Message = [
  'Backend model (optional)',
  '后端模型（可选）',
  '後端模型（可選）',
];
export const msg_executionModelHint: Message = [
  'Leave empty to use the backend default.',
  '留空使用后端默认模型。',
  '留空使用後端預設模型。',
];
export const msg_executionDefault: Message = ['Backend default', '后端默认', '後端預設'];
export const msg_executionUnavailable: Message = [
  'Could not read execution backends.',
  '无法读取执行后端。',
  '無法讀取執行後端。',
];
export const msg_executionSettingsFailed: Message = [
  'Backend settings could not be read. Your selection was kept.',
  '无法读取后端设置，原选择已保留。',
  '無法讀取後端設定，原選擇已保留。',
];
export const msg_workhubChat: Message = ['Coordinator', '协调对话', '協調對話'];
export const msg_workhubTasks: Message = ['Tasks', '任务', '任務'];
export const msg_workhubSessions: Message = ['Agent sessions', 'Agent 会话', 'Agent 會話'];
export const msg_workhubSetup: Message = [
  'Choose a working directory for the coordinator.',
  '选择协调器的工作目录。',
  '選擇協調器的工作目錄。',
];
export const msg_workhubStart: Message = ['Set up WorkHub', '设置 WorkHub', '設定 WorkHub'];
export const msg_workhubContinue: Message = ['Continue original setup', '继续原设置', '繼續原設定'];
export const msg_workhubSetupPending: Message = [
  'Setup has an original directory selection and is not complete.',
  '设置已保留原目录选择，尚未完成。',
  '設定已保留原目錄選擇，尚未完成。',
];
export const msg_workhubOriginal: Message = [
  'An earlier setup result is unresolved. Check its original result.',
  '先前设置的结果尚未确认，请检查原操作。',
  '先前設定的結果尚未確認，請檢查原操作。',
];
export const msg_workhubCleanup: Message = [
  'The original operation has not confirmed cleanup.',
  '原操作尚未确认清理完成。',
  '原操作尚未確認清理完成。',
];
export const msg_workhubEmpty: Message = [
  'No delegated tasks yet.',
  '尚无委派任务。',
  '尚無委派任務。',
];
export const msg_workhubAccepted: Message = ['Accepted', '受理时间', '受理時間'];
export const msg_workhubUntitled: Message = ['Untitled task', '未命名任务', '未命名任務'];

export const msg_workhubFirst: Message = ['First tasks', '首批任务', '首批任務'];
export const msg_workhubOpen: Message = ['Open target session', '打开目标会话', '開啟目標會話'];
export const msg_workhubPending: Message = ['Awaiting admission', '等待接纳', '等待接納'];
export const msg_workhubUnknown: Message = [
  'Original result is unknown',
  '原结果未知',
  '原結果未知',
];
export const msg_workhubUnavailable: Message = [
  'Original progress is unavailable',
  '原进度暂不可用',
  '原進度暫不可用',
];
export const msg_workhubRejected: Message = [
  'Preparation or admission was rejected',
  '准备或接纳被拒绝',
  '準備或接納被拒絕',
];
export const msg_workhubCreating: Message = [
  'Preparing a worker session',
  '正在准备 worker 会话',
  '正在準備 worker 會話',
];
export const msg_workhubUploading: Message = [
  'Transferring original attachments',
  '正在转交原附件',
  '正在轉交原附件',
];
export const msg_workhubDelivering: Message = [
  'Preparing delivery',
  '正在准备派发',
  '正在準備派發',
];
export const msg_workhubCapture: Message = [
  'Waiting for the original attachment submission result',
  '等待原附件提交结果',
  '等待原附件提交結果',
];
export const msg_workhubQueued: Message = ['Queued', '已排队', '已排隊'];
export const msg_workhubRunning: Message = ['Running', '运行中', '執行中'];
export const msg_workhubWaiting: Message = ['Needs your input', '需要你的输入', '需要你的輸入'];
export const msg_workhubDependencies: Message = [
  'Waiting for task results',
  '等待前置任务结果',
  '等待前置任務結果',
];
export const msg_workhubPaused: Message = ['Paused', '已暂停', '已暫停'];
export const msg_workhubCompleted: Message = ['Execution completed', '执行已完成', '執行已完成'];
export const msg_workhubFailed: Message = ['Execution failed', '执行失败', '執行失敗'];
export const msg_workhubCancelled: Message = ['Cancelled', '已取消', '已取消'];
export const msg_workhubChanged: Message = [
  'Work changed; read the answer from its beginning',
  '工作已变化，请从头读取答案',
  '工作已變化，請從頭讀取答案',
];
export const msg_workhubShared: Message = [
  'This input joined shared work.',
  '此输入加入了共享工作。',
  '此輸入加入了共用工作。',
];
export const msg_workhubAnswer: Message = ['Original answer', '原答案', '原答案'];
export const msg_workhubAnswerFirst: Message = ['Answer beginning', '答案开头', '答案開頭'];

export const msg_workhubNoAnswer: Message = [
  'No terminal answer is available yet.',
  '尚无可读取的终态答案。',
  '尚無可讀取的終態答案。',
];
export const msg_recoveryTitle: Message = ['Recover application', '恢复应用', '復原應用程式'];
export const msg_recoveryRefreshFailed: Message = [
  'Could not refresh. The last observation has been kept.',
  '刷新失败，已保留上次查询结果。',
  '重新整理失敗，已保留上次查詢結果。',
];
export const msg_recoveryHelp: Message = [
  'The main view is unavailable. Check original results or repair plugins. Changes may wait for earlier work to finish.',
  '主界面暂不可用。可检查原操作结果或修复插件配置；变更可能需要等待先前工作结束。',
  '主介面暫時無法使用。可檢查原操作結果或修復外掛設定；變更可能需要等待先前工作結束。',
];
export const msg_recoveryOperations: Message = ['Change history', '变更记录', '變更紀錄'];
export const msg_recoveryUnknown: Message = [
  'The original result is still unknown.',
  '原操作结果仍未知。',
  '原操作結果仍未知。',
];
export const msg_recoveryEmpty: Message = [
  'No changes recorded yet.',
  '尚无变更记录。',
  '尚無變更紀錄。',
];
export const msg_toolProcessRef: Message = ['Process reference', '进程标识', '程序參照'];
export const msg_toolProcessCwd: Message = ['Working directory', '工作目录', '工作目錄'];
export const msg_toolStdout: Message = ['Standard output', '标准输出', '標準輸出'];
export const msg_toolStderr: Message = ['Standard error', '标准错误', '標準錯誤'];
export const msg_toolScreen: Message = [
  'Recorded terminal screen',
  '记录的终端画面',
  '記錄的終端畫面',
];
export const msg_toolScrollback: Message = [
  'Recorded terminal history',
  '记录的终端历史',
  '記錄的終端歷史',
];
export const msg_toolProcessFailure: Message = ['Process failure', '进程失败信息', '程序失敗資訊'];
export const msg_toolProcessControl: Message = [
  'Recorded control result',
  '记录的控制结果',
  '記錄的控制結果',
];
export const msg_toolProcessRead: Message = ['Read process output', '读取进程输出', '讀取程序輸出'];
export const msg_toolProcessInput: Message = [
  'Write process input',
  '写入进程输入',
  '寫入程序輸入',
];
export const msg_toolProcessRecorded: Message = [
  'Recorded process status',
  '记录的进程状态',
  '記錄的程序狀態',
];
export const msg_toolProcessStarting: Message = ['Starting', '正在启动', '正在啟動'];
export const msg_toolProcessRunning: Message = ['Running', '正在运行', '正在執行'];
export const msg_toolProcessFailed: Message = ['Failed', '执行失败', '執行失敗'];
export const msg_toolProcessTimedOut: Message = ['Timed out', '已超时', '已逾時'];
export const msg_toolProcessCancelled: Message = ['Cancelled', '已取消', '已取消'];
export const msg_toolProcessOrphaned: Message = [
  'Owner lost',
  '进程所有者已丢失',
  '程序擁有者已遺失',
];
export const msg_toolExitCode: Message = ['Exit code', '退出码', '結束代碼'];
export const msg_toolOutputRedacted: Message = [
  'Output was redacted in the recorded result.',
  '记录的结果中部分输出已隐藏。',
  '記錄的結果中部分輸出已隱藏。',
];
export const msg_toolSearchAction: Message = ['Search', '搜索', '搜尋'];
export const msg_toolSearchPattern: Message = ['Pattern', '搜索条件', '搜尋條件'];
export const msg_toolMatchingFiles: Message = [
  'Recorded matching files',
  '记录的匹配文件',
  '記錄的相符檔案',
];
export const msg_toolMatchingLines: Message = [
  'Recorded matching lines',
  '记录的匹配行',
  '記錄的相符行',
];
export const msg_toolSearchIncomplete: Message = [
  'Some paths or matches were not scanned.',
  '部分路径或匹配项未被扫描。',
  '部分路徑或相符項目未被掃描。',
];
export const msg_terminalTitle: Message = ['Terminals & tasks', '终端与任务', '終端與任務'];
export const msg_terminalNew: Message = ['New terminal', '新建终端', '新增終端'];
export const msg_terminalCommand: Message = ['Run command', '运行命令', '執行命令'];
export const msg_terminalRun: Message = ['Run', '运行', '執行'];
export const msg_terminalConnect: Message = ['Connect input', '连接输入', '連接輸入'];
export const msg_terminalRelease: Message = ['Release control', '释放控制', '釋放控制'];
export const msg_terminalReconnect: Message = ['Reconnect', '重新连接', '重新連接'];

export const msg_terminalHelp: Message = [
  'Focus the terminal to type. Ctrl+] returns to controls. Ctrl+Shift+C copies the screen (⌘C on macOS). Shift+wheel scrolls history. Closing keeps the task running.',
  '聚焦终端后输入。Ctrl+] 返回控制区，Ctrl+Shift+C 复制屏幕（macOS 使用 ⌘C），Shift+滚轮查看历史。关闭面板不会结束任务。',
  '聚焦終端後輸入。Ctrl+] 返回控制區，Ctrl+Shift+C 複製畫面（macOS 使用 ⌘C），Shift+滾輪查看歷史。關閉面板不會結束任務。',
];
export const msg_terminalUnavailable: Message = [
  'Terminals require an installation process configuration.',
  '终端需要安装配置中明确提供进程权限。',
  '終端需要安裝設定中明確提供程序權限。',
];
export const msg_terminalEmpty: Message = [
  'No tasks in this conversation.',
  '当前会话没有任务。',
  '目前對話沒有任務。',
];
export const msg_terminalLoading: Message = ['Loading tasks…', '正在读取任务…', '正在讀取任務…'];
export const msg_terminalFailed: Message = [
  'The terminal request failed.',
  '终端请求失败。',
  '終端請求失敗。',
];
export const msg_terminalUnknown: Message = [
  'The result is unknown. Check the original operation before retrying.',
  '结果尚不确定。重试前请检查原操作。',
  '結果尚不確定。重試前請檢查原操作。',
];
export const msg_terminalOriginalSession: Message = [
  'Original conversation:',
  '原会话：',
  '原對話：',
];
export const msg_terminalRecorded: Message = ['Result recorded', '结果已记录', '結果已記錄'];
export const msg_terminalStopConfirm: Message = [
  'Stop this task? This ends the process.',
  '停止此任务？这会结束进程。',
  '停止此任務？這會結束程序。',
];
export const msg_terminalForgetConfirm: Message = [
  'Leave this unknown operation unresolved? It may already have taken effect. Its original receipt remains in operation history.',
  '保留此操作为未确认状态并继续？操作可能已经生效，原回执仍保留在操作历史中。',
  '保留此操作為未確認狀態並繼續？操作可能已經生效，原回執仍保留在操作歷史中。',
];
export const msg_terminalForget: Message = ['Leave unresolved', '保留未确认', '保留未確認'];
export const msg_terminalHistory: Message = ['Terminal operations', '终端操作历史', '終端操作歷史'];
export const msg_terminalSelect: Message = [
  'Select a task to inspect its output.',
  '选择任务以查看输出。',
  '選擇任務以查看輸出。',
];

export const msg_terminalControlled: Message = ['Input connected', '已连接输入', '已連接輸入'];
export const msg_terminalConnecting: Message = [
  'Connecting input…',
  '正在连接输入…',
  '正在連接輸入…',
];
export const msg_terminalInputFull: Message = [
  'Input queue is full. Wait for the pending input.',
  '输入队列已满，请等待当前输入完成。',
  '輸入佇列已滿，請等待目前輸入完成。',
];
export const msg_terminalInputFailed: Message = [
  'Input stopped. Check its operation before reconnecting.',
  '输入已停止，请先检查原操作再重新连接。',
  '輸入已停止，請先檢查原操作再重新連接。',
];
export const msg_terminalCommandLabel: Message = ['Shell command', 'Shell 命令', 'Shell 命令'];
export const msg_terminalTruncated: Message = [
  'Output is truncated by the canonical resource limit.',
  '输出受原资源投影上限限制，已截断。',
  '輸出受原資源投影上限限制，已截斷。',
];
export const msg_terminalCleanupUnknown: Message = [
  'The result is recorded; native cleanup is not confirmed.',
  '结果已记录，但原生清理尚未确认。',
  '結果已記錄，但原生清理尚未確認。',
];
export const msg_terminalSourceOwned: Message = [
  'This task belongs to another conversation and is read only.',
  '此任务属于另一个会话，只能读取。',
  '此任務屬於另一個對話，只能讀取。',
];
export const msg_helpTitle: Message = ['Keyboard shortcuts', '键盘快捷键', '鍵盤快捷鍵'];
export const msg_helpSend: Message = ['Send message', '发送消息', '傳送訊息'];
export const msg_helpNewline: Message = ['Insert a new line', '插入换行', '插入換行'];
export const msg_helpClipboard: Message = [
  'Paste local clipboard files, image or text',
  '粘贴本机剪贴板文件、图片或文字',
  '貼上本機剪貼簿檔案、圖片或文字',
];
export const msg_helpFocus: Message = ['Move focus', '移动焦点', '移動焦點'];
export const msg_helpListNavigation: Message = [
  'Move within a list',
  '在列表内移动',
  '在清單內移動',
];
export const msg_helpEditorSelection: Message = [
  'Select all / undo in editor',
  '编辑器内全选 / 撤销',
  '編輯器內全選 / 復原',
];
export const msg_helpTranscriptScroll: Message = [
  'Scroll conversation outside editor',
  '编辑器外滚动正文',
  '編輯器外捲動內文',
];
export const msg_helpTextSelection: Message = [
  'Extend conversation text selection',
  '扩展正文选区',
  '擴展內文選取範圍',
];
export const msg_helpLineSelection: Message = [
  'Extend to visual line start / end',
  '扩选到视觉行首 / 行尾',
  '擴選至視覺行首 / 行尾',
];
export const msg_helpPageSelection: Message = [
  'Extend selection by a page',
  '按页扩展选区',
  '按頁擴展選取範圍',
];
export const msg_helpMouseSelection: Message = [
  'Extend from the selection start after scrolling (Option on macOS)',
  '从原起点扩选，可先滚动再点击（macOS 使用 Option）',
  '從原起點擴選，可先捲動再點擊（macOS 使用 Option）',
];
export const msg_helpShiftSelection: Message = [
  'Extend selection when the terminal forwards Shift mouse events',
  '终端转发 Shift 鼠标事件时扩展选区',
  '終端轉送 Shift 滑鼠事件時擴展選取範圍',
];
export const msg_helpCopySelection: Message = [
  'Copy selected text',
  '复制选中文字',
  '複製選取文字',
];
export const msg_helpActivate: Message = ['Activate a button', '激活按钮', '啟動按鈕'];
export const msg_helpCommands: Message = ['Open commands', '打开命令', '開啟命令'];
export const msg_helpNavigation: Message = [
  'Show / hide conversations',
  '显示 / 隐藏对话列表',
  '顯示 / 隱藏對話清單',
];
export const msg_helpNew: Message = ['New conversation', '新建对话', '新增對話', '새 대화'];
export const msg_helpBack: Message = [
  'Close dialog / return to conversation',
  '关闭弹窗 / 返回对话',
  '關閉彈窗 / 返回對話',
];
export const msg_helpClose: Message = ['Close help', '关闭帮助', '關閉說明'];
export const msg_detailsTitle: Message = ['Conversation details', '对话详情', '對話詳情'];
export const msg_detailsOpen: Message = ['Details', '详情', '詳情'];
export const msg_detailsName: Message = ['Title', '标题', '標題'];
export const msg_detailsLabels: Message = ['Labels', '标签', '標籤'];
export const msg_detailsLabelsHelp: Message = [
  'One label per line; leave empty for no labels.',
  '每行一个标签，留空表示无标签。',
  '每行一個標籤，留空表示無標籤。',
];
export const msg_permissionsTitle: Message = ['Workspace permissions', '工作区权限', '工作區權限'];
export const msg_permissionReadOnly: Message = ['Read only', '只读', '唯讀'];
export const msg_permissionWorkspaceWrite: Message = [
  'Write in workspace',
  '允许工作区写入',
  '允許工作區寫入',
];
export const msg_sandboxTitle: Message = ['Sandbox', '沙箱', '沙箱'];
export const msg_sandboxWorkspace: Message = ['Workspace write', '工作区写入', '工作區寫入'];
export const msg_permissionFullAccess: Message = ['Sandbox off', '关闭沙箱', '關閉沙箱'];
export const msg_sandboxHelp: Message = [
  'Disables filesystem and process isolation for this conversation. Commands can access files outside the workspace and the network.',
  '关闭此对话的文件与进程隔离，命令可以访问工作区外文件和网络。',
  '關閉此對話的檔案與行程隔離，命令可以存取工作區外檔案和網路。',
];
export const msg_sandboxSaveFailed: Message = [
  'The sandbox setting changed elsewhere. Review the current mode and try again.',
  '沙箱设置已在别处更改，请检查当前模式后重试。',
  '沙箱設定已在別處變更，請檢查目前模式後重試。',
];
export const msg_permissionAsk: Message = [
  'Ask for additional access',
  '询问额外权限',
  '詢問額外權限',
];
export const msg_permissionNoAsk: Message = [
  'Do not ask for access',
  '不询问额外权限',
  '不詢問額外權限',
];
export const msg_permissionRevoke: Message = [
  'Clear additional approvals on save',
  '保存时清除额外授权',
  '儲存時清除額外授權',
];
export const msg_permissionPolicyHelp: Message = [
  'Changing permission settings clears prior additional approvals. Workspace write access remains until you choose Read only.',
  '更改权限设置会清除先前的额外授权。选择“只读”才能关闭工作区写入权限。',
  '變更權限設定會清除先前的額外授權。選擇「唯讀」才能關閉工作區寫入權限。',
];
export const msg_permissionApprovalTitle: Message = ['Approve permissions', '审批权限', '審批權限'];
export const msg_computerApprovalTitle: Message = [
  'Computer Use access',
  '电脑操作授权',
  '電腦操作授權',
];
export const msg_computerApprovalDescription: Message = [
  'Allow this conversation to observe and control applications and configured browsers, including typing, clicking and screenshots. This approval lasts until you change or revoke its permissions.',
  '允许此会话观察并操作应用和已配置的浏览器，包括输入、点击和截图。授权持续到你修改或撤销会话权限。',
  '允許此對話觀察並操作應用程式和已設定的瀏覽器，包括輸入、點擊和螢幕截圖。授權持續到你修改或撤銷對話權限。',
];
export const msg_permissionOnce: Message = ['Once', '仅这一次', '僅這一次'];
export const msg_permissionTurn: Message = ['This turn', '本轮', '本輪'];
export const msg_permissionSession: Message = ['This conversation', '本会话', '本對話'];
export const msg_permissionRequested: Message = ['Requested access', '请求的权限', '請求的權限'];
export const msg_permissionGranted: Message = ['Approved access', '已批准的权限', '已批准的權限'];
export const msg_permissionDenied: Message = ['Access denied', '权限已拒绝', '權限已拒絕'];
export const msg_permissionRead: Message = ['Read', '读取', '讀取'];
export const msg_permissionWrite: Message = ['Write', '写入', '寫入'];
export const msg_permissionDeny: Message = ['Deny', '拒绝', '拒絕'];
export const msg_permissionExact: Message = ['Exact path', '精确路径', '精確路徑'];
export const msg_permissionSubtree: Message = [
  'Path and descendants',
  '路径及其子项',
  '路徑及其子項',
];
export const msg_permissionNetwork: Message = ['Network', '网络', '網路'];
export const msg_detailsSave: Message = ['Save details', '保存详情', '儲存詳情'];
export const msg_detailsRetry: Message = [
  'Retry loading this field',
  '重新载入此字段',
  '重新載入此欄位',
];
export const msg_detailsSaved: Message = [
  'Conversation details saved.',
  '对话详情已保存。',
  '對話詳情已儲存。',
];
export const msg_detailsDraftKept: Message = [
  'Could not read these fields. Your draft has been kept.',
  '无法读取字段，已保留草稿。',
  '無法讀取欄位，草稿已保留。',
];
export const msg_detailsInvalid: Message = [
  'Check the title and labels. Your draft has been kept.',
  '请检查标题和标签，已保留草稿。',
  '請檢查標題與標籤，草稿已保留。',
];
export const msg_detailsConflict: Message = [
  'This conversation changed. Review its current version before saving.',
  '对话发生了变化，请先复核当前版本再保存。',
  '對話發生變化，儲存前請先複核目前版本。',
];
export const msg_detailsRejected: Message = [
  'Details were not saved. Your draft has been kept.',
  '详情未保存，已保留草稿。',
  '詳情未儲存，草稿已保留。',
];
export const msg_detailsUnknown: Message = [
  'Result not yet known. Check the original change before saving again.',
  '结果尚未确认，请先查询原修改操作再保存。',
  '結果尚未確認，請先查詢原修改操作再儲存。',
];
export const msg_detailsReview: Message = [
  'Review current details',
  '复核当前详情',
  '複核目前詳情',
];
export const msg_detailsReviewFailed: Message = [
  'Could not read the current details. Your draft has been kept.',
  '无法读取当前详情，已保留草稿。',
  '無法讀取目前詳情，草稿已保留。',
];
export const msg_detailsUseVersion: Message = ['Use this version', '使用此版本', '使用此版本'];
export const msg_detailsReload: Message = [
  'Discard draft and reload',
  '放弃草稿并重新载入',
  '捨棄草稿並重新載入',
];
export const msg_detailsReloadHelp: Message = [
  'Discard the current fields and load the details shown below?',
  '放弃当前字段，载入下方显示的详情？',
  '捨棄目前欄位，載入下方顯示的詳情？',
];
export const msg_detailsRebaseHelp: Message = [
  'Review these saved details. Continuing keeps your draft and uses this version for the next save.',
  '请复核已保存的详情。继续将保留草稿，下一次保存使用此版本。',
  '請複核已儲存詳情。繼續會保留草稿，下次儲存使用此版本。',
];
export const msg_detailsTargetChanged: Message = [
  'Your draft belongs to another conversation. Review and reload to edit this one.',
  '草稿属于另一段对话，请复核并重新载入以编辑当前对话。',
  '草稿屬於另一段對話，請複核並重新載入以編輯目前對話。',
];
export const msg_detailsHistory: Message = ['Conversation changes', '对话设置记录', '對話設定紀錄'];
export const msg_detailsHistoryHelp: Message = [
  'Check original changes here. Results never replace your fields.',
  '在这里查询原修改操作，结果不会替换当前字段。',
  '在這裡查詢原修改操作，結果不會替換目前欄位。',
];
export const msg_newWorkspace: Message = [
  'New conversation in another folder',
  '在其他目录新建对话',
  '在其他目錄新增對話',
];
export const msg_skillsTitle: Message = ['Skills', '技能库', '技能庫'];
export const msg_skillsSearch: Message = ['Search skills…', '搜索技能…', '搜尋技能…'];
export const msg_skillsSubmit: Message = ['Search', '搜索', '搜尋'];
export const msg_skillsInstalled: Message = ['Installed', '已安装', '已安裝'];
export const msg_skillsBundled: Message = ['Built-in', '内置', '內建'];
export const msg_skillsInstall: Message = ['Install', '安装', '安裝'];
export const msg_skillsUpdate: Message = [
  'Update installed copy',
  '更新已安装副本',
  '更新已安裝副本',
];
export const msg_skillsDelete: Message = [
  'Delete installed copy',
  '删除已安装副本',
  '刪除已安裝副本',
];
export const msg_skillsConfirmTitle: Message = [
  'Review skill change',
  '确认技能变更',
  '確認技能變更',
];
export const msg_skillsConfirm: Message = ['Confirm change', '确认变更', '確認變更'];
export const msg_skillsInstallDetail: Message = [
  'Copy this skill and its resources into this library. The source stays unchanged.',
  '将此技能及资源复制到本技能库，保留原始来源。',
  '將此技能及資源複製到本技能庫，保留原始來源。',
];
export const msg_skillsUpdateDetail: Message = [
  'Replace the installed instructions with this source. Keep existing resource files.',
  '用此来源替换已安装技能的正文，保留现有资源文件。',
  '以此來源取代已安裝技能的正文，保留現有資源檔案。',
];
export const msg_skillsDeleteDetail: Message = [
  'Delete this installed skill and all its resource files.',
  '删除此已安装技能及其全部资源文件。',
  '刪除此已安裝技能及其全部資源檔案。',
];
export const msg_skillsPathsTruncated: Message = [
  'The path list is shortened. This review includes every path and its contents.',
  '路径列表已节选，本次确认仍包含全部路径及内容。',
  '路徑清單已節錄，本次確認仍包含全部路徑及內容。',
];
export const msg_skillsEntryCount: Message = ['Directory entries', '目录条目', '目錄項目'];
export const msg_skillsLocalModified: Message = [
  'The installed instructions have local changes. Confirming replaces those changes.',
  '已安装的正文有本地修改，确认后将替换这些修改。',
  '已安裝的正文有本機修改，確認後將取代這些修改。',
];
export const msg_skillsAlreadyInstalled: Message = [
  'Already installed. Use Update installed copy to review a replacement.',
  '已安装。请使用“更新已安装副本”查看替换预览。',
  '已安裝。請使用「更新已安裝副本」查看替換預覽。',
];
export const msg_skillsNotInstalled: Message = [
  'No installed copy exists. Install the skill first.',
  '尚无已安装副本，请先安装技能。',
  '尚無已安裝副本，請先安裝技能。',
];
export const msg_skillsChangeRejected: Message = [
  'This skill change is unavailable. Refresh the library and review the selected source.',
  '无法执行此变更，请刷新技能库并检查所选来源。',
  '無法執行此變更，請重新整理技能庫並檢查所選來源。',
];
export const msg_skillsUnknown: Message = [
  'The change result is not confirmed. Check the original result before making another change.',
  '变更结果尚未确认，请查询原操作结果后再进行新的变更。',
  '變更結果尚未確認，請查詢原操作結果後再進行新的變更。',
];
export const msg_skillsCleanupUnknown: Message = [
  'The operation result is known, but resource cleanup is not confirmed.',
  '操作结果已确认，但资源清理尚未确认。',
  '操作結果已確認，但資源清理尚未確認。',
];
export const msg_skillsCheckResult: Message = [
  'Check original result',
  '查询原操作结果',
  '查詢原操作結果',
];
export const msg_skillsResultConfirmed: Message = [
  'Original skill result confirmed. Resource cleanup is shown separately.',
  '原技能操作结果已确认；资源清理状态单独显示。',
  '原技能操作結果已確認；資源清理狀態單獨顯示。',
];
export const msg_skillsImport: Message = ['Import source', '导入来源', '匯入來源'];
export const msg_skillsImported: Message = [
  'Imported source · install to enable',
  '已导入来源 · 安装后可用',
  '已匯入來源 · 安裝後可用',
];
export const msg_skillsFilePath: Message = ['Skill file path', '技能文件路径', '技能檔案路徑'];
export const msg_skillsChooseFile: Message = ['Choose skill file', '选择技能文件', '選擇技能檔案'];
export const msg_skillsSourceId: Message = ['Source ID', '来源 ID', '來源 ID'];
export const msg_skillsSourceIdHelp: Message = [
  'Letters, digits, dots, underscores or dashes; start with a letter or digit.',
  '使用字母、数字、点、下划线或短横线；以字母或数字开头。',
  '使用字母、數字、點、底線或短橫線；以字母或數字開頭。',
];
export const msg_skillsImportHelp: Message = [
  'Import one SKILL.md file (up to 1 MiB). Supporting files are not copied. Install the source separately to make it available to the agent.',
  '导入一个 SKILL.md 文件（最多 1 MiB），不复制配套文件。另行安装此来源后，Agent 才能使用。',
  '匯入一個 SKILL.md 檔案（最多 1 MiB），不複製配套檔案。另行安裝此來源後，Agent 才能使用。',
];
export const msg_skillsImportConfirm: Message = [
  'Import this file under the source ID shown above?',
  '使用上方来源 ID 导入这个文件？',
  '使用上方來源 ID 匯入這個檔案？',
];
export const msg_skillsSourceExists: Message = [
  'That source ID already exists. Choose another ID.',
  '该来源 ID 已存在，请使用其他 ID。',
  '該來源 ID 已存在，請使用其他 ID。',
];
export const msg_skillsSourceIdInvalid: Message = [
  'Enter a valid source ID of at most 81 characters.',
  '请输入有效的来源 ID，最多 81 个字符。',
  '請輸入有效的來源 ID，最多 81 個字元。',
];
export const msg_skillsImportInvalid: Message = [
  'The selected file must be a valid UTF-8 SKILL.md file, at most 1 MiB.',
  '所选文件必须是有效的 UTF-8 SKILL.md 文件，最多 1 MiB。',
  '所選檔案必須是有效的 UTF-8 SKILL.md 檔案，最多 1 MiB。',
];
export const msg_skillsDeleteSource: Message = ['Delete source', '删除来源', '刪除來源'];
export const msg_skillsDeleteSourceHelp: Message = [
  'Delete this imported source? Installed copies remain available.',
  '删除此导入来源？已安装的副本仍然可用。',
  '刪除此匯入來源？已安裝的副本仍然可用。',
];
export const msg_skillsEmpty: Message = [
  'No matching skills.',
  '没有匹配的技能。',
  '沒有符合的技能。',
];
export const msg_skillsLoading: Message = ['Loading skills…', '正在读取技能…', '正在讀取技能…'];
export const msg_skillsFailed: Message = [
  'Unable to read skills. Retry the search.',
  '无法读取技能，请重新搜索。',
  '無法讀取技能，請重新搜尋。',
];
export const msg_skillsChanged: Message = [
  'Skills changed. Refresh the list before continuing.',
  '技能已变化，请刷新列表后继续。',
  '技能已變更，請重新整理列表後繼續。',
];
export const msg_skillsEnabled: Message = ['Enabled', '已启用', '已啟用'];
export const msg_skillsDisabled: Message = ['Disabled', '已停用', '已停用'];
export const msg_skillsPinned: Message = ['Pinned', '已置顶', '已置頂'];
export const msg_skillsEnable: Message = ['Enable', '启用', '啟用'];
export const msg_skillsDisable: Message = ['Disable', '停用', '停用'];
export const msg_skillsPin: Message = ['Pin', '置顶', '置頂'];
export const msg_skillsUnpin: Message = ['Unpin', '取消置顶', '取消置頂'];
export const msg_skillsInvalid: Message = ['Invalid skill', '无效技能', '無效技能'];
export const msg_skillsShadowed: Message = ['Shadowed by', '被此技能覆盖', '被此技能覆蓋'];
export const msg_skillsTruncated: Message = ['Metadata excerpt', '元数据节选', '中繼資料節選'];

export const msg_directoryTitle: Message = ['Choose a workspace', '选择工作区', '選擇工作區'];
export const msg_directoryFilter: Message = [
  'Filter folders on this page',
  '筛选本页目录',
  '篩選本頁目錄',
];
export const msg_directoryHelp: Message = [
  'Open a folder, then select it.',
  '打开目录，然后选择该目录。',
  '開啟目錄，然後選取該目錄。',
];
export const msg_directoryLoading: Message = ['Loading folders…', '正在读取目录…', '正在讀取目錄…'];
export const msg_directoryFailed: Message = [
  'Could not read this folder. Refresh to try again.',
  '无法读取目录，请刷新后重试。',
  '無法讀取目錄，請重新整理後重試。',
];
export const msg_directoryEmpty: Message = [
  'No folders here.',
  '这里没有子目录。',
  '這裡沒有子目錄。',
];
export const msg_directoryParent: Message = ['Parent', '上一级', '上一層'];

export const msg_directoryRefresh: Message = [
  'Refresh / first page',
  '刷新／首页',
  '重新整理／首頁',
];
export const msg_directoryChoose: Message = ['Create here', '在此新建', '在此新增'];
export const msg_paletteTitle: Message = ['Commands', '命令', '命令'];
export const msg_paletteFilter: Message = [
  'Search commands or conversations',
  '搜索命令或对话',
  '搜尋命令或對話',
];
export const msg_paletteSession: Message = ['Conversation', '对话', '對話'];
export const msg_paletteSearching: Message = [
  'Searching conversations…',
  '正在搜索对话…',
  '正在搜尋對話…',
];
export const msg_paletteSearchFailed: Message = [
  'Conversation search is unavailable.',
  '暂时无法搜索对话。',
  '暫時無法搜尋對話。',
];
export const msg_paletteEmpty: Message = [
  'No matching commands or conversations.',
  '没有匹配的命令或对话。',
  '沒有匹配的命令或對話。',
];

export const msg_paletteRefresh: Message = ['Refresh search', '刷新搜索', '重新整理搜尋'];
export const msg_paletteClose: Message = ['Close commands', '关闭命令面板', '關閉命令面板'];
export const msg_studioTitle: Message = ['Configuration Studio', '配置工作台', '設定工作台'];
export const msg_studioOverview: Message = ['Overview', '概览', '總覽'];
export const msg_studioIntro: Message = [
  'A quieter place to configure your workspace.',
  '专注整理工作区的连接、模型与插件。',
  '專注整理工作區的連線、模型與外掛。',
];
export const msg_studioConnections: Message = ['Connect a provider', '连接提供商', '連接供應商'];
export const msg_studioConnectionsHelp: Message = [
  'Manage endpoints and credentials. Existing drafts stay here when you change pages.',
  '管理端点与凭据，切换页面时保留当前草稿。',
  '管理端點與憑證，切換頁面時保留目前草稿。',
];
export const msg_studioModelsHelp: Message = [
  'Browse available models and choose a default for new work.',
  '浏览可用模型，为新的工作选择默认模型。',
  '瀏覽可用模型，為新的工作選擇預設模型。',
];
export const msg_studioPluginsHelp: Message = [
  'Install packages and shape the product’s components and connections.',
  '安装插件包，调整产品的组件与连接。',
  '安裝外掛套件，調整產品的元件與連線。',
];
export const msg_viewImage: Message = ['View image', '查看图片', '查看圖片'];
export const msg_deploymentInstall: Message = ['Install plugin', '安装插件', '安裝外掛'];
export const msg_deploymentInstallHelp: Message = [
  'Save a plugin package for this product. Installation does not enable it or grant permissions.',
  '为此产品保存插件包。安装不会启用插件，也不会授予权限。',
  '為此產品儲存外掛套件。安裝不會啟用外掛，也不會授予權限。',
];
export const msg_attachmentPasting: Message = [
  'Attaching files…',
  '正在添加附件…',
  '正在加入附件…',
];
export const msg_clipboardUnavailable: Message = [
  'The clipboard could not be read. Paste again to try another selection.',
  '无法读取剪贴板。请重新粘贴所需内容。',
  '無法讀取剪貼簿。請重新貼上所需內容。',
];
export const msg_clipboardPasteRejected: Message = [
  'The clipboard text could not be inserted into the original draft. Paste again at the intended location.',
  '无法将剪贴板文字插入原草稿。请在目标位置重新粘贴。',
  '無法將剪貼簿文字插入原草稿。請在目標位置重新貼上。',
];
export const msg_attachmentSkip: Message = ['Skip file', '跳过文件', '跳過檔案'];
export const msg_fileBrowse: Message = ['Browse…', '浏览…', '瀏覽…'];
export const msg_fileListEmpty: Message = [
  'No regular files or folders here.',
  '这里没有普通文件或文件夹。',
  '這裡沒有一般檔案或資料夾。',
];
export const msg_fileListTruncated: Message = [
  'Showing the first 2048 entries.',
  '仅显示前 2048 个目录项。',
  '僅顯示前 2048 個目錄項目。',
];
export const msg_attachmentTitle: Message = ['Attachments', '附件', '附件'];
export const msg_attachmentHelp: Message = [
  'Choose a local file to attach to this message.',
  '选择本机文件后，将其加入当前会话的消息。',
  '選取本機檔案後，將其加入目前對話的訊息。',
];
export const msg_attachmentChoose: Message = ['Choose file…', '选择文件…', '選擇檔案…'];
export const msg_attachmentPath: Message = ['Local file path', '本机文件路径', '本機檔案路徑'];
export const msg_attachmentPathPlaceholder: Message = [
  'Absolute path on this device',
  '本机文件的绝对路径',
  '本機檔案的絕對路徑',
];
export const msg_attachmentAdd: Message = ['Attach to message', '加入消息', '加入訊息'];
export const msg_attachmentRemove: Message = ['Remove from message', '从消息移除', '從訊息移除'];
export const msg_attachmentTooLarge: Message = [
  'The file exceeds 50 MiB.',
  '文件超过 50 MiB。',
  '檔案超過 50 MiB。',
];
export const msg_attachmentFailed: Message = [
  'The file was not attached. Select a file and try again.',
  '未添加附件，请选择文件后重试。',
  '未新增附件，請選取檔案後重試。',
];
export const msg_deploymentChooseFile: Message = [
  'Choose plugin file…',
  '选择插件文件…',
  '選擇外掛檔案…',
];
export const msg_deploymentLocal: Message = ['Local file', '本地文件', '本機檔案'];
export const msg_deploymentUrl: Message = ['Install from URL', '从 URL 安装', '從 URL 安裝'];
export const msg_deploymentUrlInvalid: Message = [
  'Enter an HTTP(S) URL to a .maka-plugin bundle.',
  '请输入 .maka-plugin 包的 HTTP(S) 下载链接。',
  '請輸入 .maka-plugin 套件的 HTTP(S) 下載連結。',
];
export const msg_deploymentFilePath: Message = ['Plugin file path', '插件文件路径', '外掛檔案路徑'];
export const msg_deploymentFilePlaceholder: Message = [
  'Absolute path to a .maka-plugin file',
  '.maka-plugin 文件的绝对路径',
  '.maka-plugin 檔案的絕對路徑',
];
export const msg_deploymentFileTooLarge: Message = [
  'This file exceeds 50 MiB. Choose a smaller plugin package.',
  '文件超过 50 MiB，请选择更小的插件包。',
  '檔案超過 50 MiB，請選擇較小的外掛套件。',
];
export const msg_deploymentFileBusy: Message = [
  'File memory is in use. Wait for other native work and try again.',
  '文件内存正在使用，请等待其他原生任务完成后重试。',
  '檔案記憶體正在使用，請等待其他原生工作完成後重試。',
];
export const msg_deploymentFileFailed: Message = [
  'Could not read this file. Choose a readable regular file.',
  '无法读取文件，请选择可读的普通文件。',
  '無法讀取檔案，請選擇可讀的普通檔案。',
];
export const msg_deploymentFileLoading: Message = [
  'Reading the selected file…',
  '正在读取选中的文件…',
  '正在讀取選取的檔案…',
];
export const msg_deploymentInstallQuestion: Message = [
  'Install this plugin package?',
  '安装这个插件包？',
  '安裝這個外掛套件？',
];
export const msg_deploymentInstalled: Message = [
  'Plugin package saved. Component enablement and permissions are unchanged.',
  '插件包已保存，组件启用状态和权限未改变。',
  '外掛套件已儲存，元件啟用狀態與權限未改變。',
];
export const msg_deploymentActivateHelp: Message = [
  'Edit the product composition to select this package and its required connections. Reload a retained draft to include the saved package.',
  '编辑产品组合，选择此插件包及其所需连接。如有保留的草稿，请重新加载以包含已保存的插件包。',
  '編輯產品組合，選擇此套件及其所需連線。如有保留的草稿，請重新載入以包含已儲存的套件。',
];
export const msg_deploymentInstallRejected: Message = [
  'Could not install this package. Check the plugin file and try again.',
  '无法安装此插件包，请检查插件文件后重试。',
  '無法安裝此套件，請檢查外掛檔案後重試。',
];
export const msg_restoringView: Message = [
  'Restoring your place…',
  '正在恢复界面状态…',
  '正在恢復介面狀態…',
];
export const msg_viewSaveFailed: Message = [
  'Couldn’t save or restore your place.',
  '无法保存或恢复界面状态。',
  '無法儲存或恢復介面狀態。',
];
export const msg_reloadView: Message = [
  'Read saved state again',
  '重新读取已保存状态',
  '重新讀取已儲存狀態',
];
export const msg_pluginSearch: Message = [
  'Search plugins by name or purpose',
  '搜索插件名称或用途',
  '搜尋外掛名稱或用途',
];
export const msg_deploymentTitle: Message = ['Plugins', '插件', '外掛'];
export const msg_advancedSettings: Message = ['Advanced settings', '高级设置', '進階設定'];
export const msg_basicSettings: Message = ['Basic settings', '基础设置', '基本設定'];
export const msg_configureInstance: Message = ['Configure', '配置', '設定'];
export const msg_instanceConfiguration: Message = ['Plugin settings', '插件设置', '外掛設定'];
export const msg_settingsEmpty: Message = [
  'No settings in this section.',
  '此分组没有设置项。',
  '此群組沒有設定項目。',
];
export const msg_settingsPreparing: Message = [
  'Preparing your changes…',
  '正在准备更改…',
  '正在準備變更…',
];
export const msg_settingUnset: Message = ['Not set', '未设置', '未設定'];
export const msg_settingNone: Message = ['None', '无', '無'];
export const msg_settingUnsupported: Message = [
  'This setting needs a dedicated plugin control.',
  '此设置需要插件提供专用控件。',
  '此設定需要外掛提供專用控制項。',
];
export const msg_settingRemove: Message = ['Clear value', '清除值', '清除值'];
export const msg_settingApply: Message = ['Apply', '应用', '套用'];
export const msg_settingsSave: Message = ['Save changes', '保存更改', '儲存變更'];
export const msg_settingsDiscard: Message = ['Discard changes', '放弃更改', '捨棄變更'];
export const msg_settingsDiscardQuestion: Message = [
  'Discard these unsaved changes?',
  '放弃这些尚未保存的更改？',
  '捨棄這些尚未儲存的變更？',
];

export const msg_settingsLimit: Message = [
  'Save these changes before editing more fields.',
  '请先保存这些更改，再编辑更多字段。',
  '請先儲存這些變更，再編輯更多欄位。',
];
export const msg_settingsReadFailed: Message = [
  'Could not read this field. Your changes are kept.',
  '无法读取此字段，已保留你的更改。',
  '無法讀取此欄位，已保留你的變更。',
];
export const msg_settingsInvalidNumber: Message = [
  'Enter a valid number.',
  '请输入有效数字。',
  '請輸入有效數字。',
];
export const msg_settingsChanged: Message = [
  'Settings changed elsewhere. Reload before saving.',
  '设置已被其他操作修改，请重新载入后再保存。',
  '設定已被其他操作修改，請重新載入後再儲存。',
];
export const msg_settingsReload: Message = ['Reload settings', '重新载入设置', '重新載入設定'];
export const msg_settingsBack: Message = ['Back to plugins', '返回插件', '返回外掛'];
export const msg_settingOn: Message = ['On', '开启', '開啟'];
export const msg_settingOff: Message = ['Off', '关闭', '關閉'];
export const msg_deploymentInterface: Message = [
  'Apps and display',
  '应用与显示',
  '應用程式與顯示',
];
export const msg_deploymentServices: Message = ['Models and tools', '模型与工具', '模型與工具'];
export const msg_deploymentInterfaceHelp: Message = [
  'Apps and controls installed on this device.',
  '安装在本机的应用和界面组件。',
  '安裝在本機的應用程式和介面元件。',
];
export const msg_deploymentServicesHelp: Message = [
  'Plugins on the connected host that run tasks, access files, and connect to models. Changes may interrupt running tasks.',
  '连接的主机上负责执行任务、访问文件和连接模型的插件。更改可能中断正在运行的任务。',
  '連線的主機上負責執行任務、存取檔案和連接模型的外掛。變更可能中斷正在執行的任務。',
];
export const msg_deploymentHelp: Message = [
  'Components selected by this product. Saved changes appear automatically.',
  '当前产品选择的组件，保存后自动更新。',
  '目前產品選擇的元件，儲存後自動更新。',
];
export const msg_deploymentRefresh: Message = [
  'Refresh components',
  '刷新插件列表',
  '重新整理外掛列表',
];

export const msg_deploymentEnable: Message = ['Enable', '启用', '啟用'];
export const msg_deploymentDisable: Message = ['Disable', '停用', '停用'];
export const msg_deploymentConfirmEnable: Message = [
  'Enable this component?',
  '启用这个组件？',
  '啟用這個元件？',
];
export const msg_deploymentConfirmDisable: Message = [
  'Disable this component?',
  '停用这个组件？',
  '停用這個元件？',
];
export const msg_deploymentChangeHelp: Message = [
  'Changes must keep the product’s required connections valid.',
  '变更必须保留产品所需的有效连接。',
  '變更必須保留產品所需的有效連線。',
];
export const msg_deploymentParentDisabled: Message = [
  'The parent component is disabled.',
  '父组件已停用。',
  '父元件已停用。',
];
export const msg_deploymentSaved: Message = [
  'Changes saved. The product is updating.',
  '变更已保存，产品正在更新。',
  '變更已儲存，產品正在更新。',
];
export const msg_deploymentConflict: Message = [
  'Components changed. Refresh and confirm again.',
  '组件已变化，请刷新后重新确认。',
  '元件已變更，請重新整理後再次確認。',
];
export const msg_deploymentRejected: Message = [
  'This change is not allowed by the composition. Review its required connections.',
  '组合不允许此变更，请检查组件所需的连接。',
  '組合不允許此變更，請檢查元件所需的連線。',
];
export const msg_deploymentUnknown: Message = [
  'Result not yet known. Check the original operation.',
  '结果尚未确认，请查询原操作。',
  '結果尚未確認，請查詢原操作。',
];
export const msg_deploymentUnavailable: Message = [
  'Could not load components. The current page has been kept.',
  '无法加载组件，已保留当前页面。',
  '無法載入元件，已保留目前頁面。',
];
export const msg_deploymentHistory: Message = ['Plugin changes', '插件变更记录', '外掛變更紀錄'];
export const msg_deploymentHistoryHelp: Message = [
  'Checking an earlier operation never repeats the change.',
  '查询原操作不会重复执行变更。',
  '查詢原操作不會重複執行變更。',
];
export const msg_deploymentRecorded: Message = [
  'Original result recorded.',
  '原操作结果已记录。',
  '原操作結果已記錄。',
];
export const msg_deploymentEmpty: Message = [
  'No plugins found.',
  '没有找到插件。',
  '沒有找到外掛。',
];
export const msg_deploymentEdit: Message = [
  'Advanced: edit composition',
  '高级：编辑产品组合',
  '進階：編輯產品組合',
];
export const msg_deploymentEditHelp: Message = [
  'Advanced: edit the complete source, including configuration, bindings and the product root.',
  '高级编辑：修改完整来源，包括配置、绑定和产品根。',
  '進階編輯：修改完整來源，包括設定、繫結和產品根。',
];
export const msg_deploymentDocument: Message = [
  'Product composition source',
  '产品组合来源',
  '產品組合來源',
];
export const msg_deploymentDocumentRejected: Message = [
  'Could not save this composition. Review the validation details.',
  '无法保存这份组合，请查看校验详情。',
  '無法儲存這份組合，請查看驗證詳情。',
];
export const msg_deploymentEnvironment: Message = [
  'Keep the current execution location and presentation when editing this product.',
  '编辑当前产品时，请保留现有的执行位置和呈现端。',
  '編輯目前產品時，請保留現有的執行位置和呈現端。',
];
export const msg_deploymentPackageUnavailable: Message = [
  'The composition must use installed package revisions.',
  '组合必须使用已经安装的包版本。',
  '組合必須使用已安裝的套件版本。',
];
export const msg_deploymentLoading: Message = [
  'Loading the complete source…',
  '正在加载完整来源…',
  '正在載入完整來源…',
];
export const msg_deploymentLoadFailed: Message = [
  'The complete source could not be loaded. The draft has been kept; saving is disabled.',
  '无法加载完整来源，已保留草稿并禁止保存。',
  '無法載入完整來源，已保留草稿並禁止儲存。',
];
export const msg_deploymentSave: Message = ['Save composition', '保存组合', '儲存組合'];
export const msg_deploymentReload: Message = [
  'Reload saved source',
  '重新加载已保存来源',
  '重新載入已儲存來源',
];
export const msg_deploymentSaveQuestion: Message = [
  'Replace this product’s composition?',
  '替换当前产品的组合？',
  '替換目前產品的組合？',
];
export const msg_deploymentSaveHelp: Message = [
  'The full source will be validated before saving. This can change the current interface.',
  '保存前会校验完整来源，此操作可能改变当前界面。',
  '儲存前會驗證完整來源，此操作可能改變目前介面。',
];
export const msg_deploymentReloadQuestion: Message = [
  'Discard this draft and reload?',
  '放弃草稿并重新加载？',
  '放棄草稿並重新載入？',
];
export const msg_deploymentReloadHelp: Message = [
  'The latest saved source will replace this editor’s entire draft.',
  '编辑器中的整份草稿将替换为最新的已保存来源。',
  '編輯器中的整份草稿將替換為最新的已儲存來源。',
];
export const msg_imageTitle: Message = ['Image', '图片', '圖片'];
export const msg_imageLoading: Message = ['Loading image…', '正在加载图片…', '正在載入圖片…'];
export const msg_imageFailed: Message = [
  'This image could not be displayed.',
  '暂时无法显示这张图片。',
  '暫時無法顯示這張圖片。',
];
export const msg_imageTerminal: Message = [
  'Image preview is available in the desktop app.',
  '可在桌面应用中查看图片预览。',
  '可在桌面應用程式中查看圖片預覽。',
];
export const msg_defaultModel: Message = ['Default model', '默认模型', '預設模型'];
export const msg_modelApply: Message = ['Apply', '应用', '套用'];
export const msg_thinking: Message = ['Thinking', '思考等级', '思考等級'];
export const msg_thinkingUnavailable: Message = [
  'Unavailable',
  '不可用',
  '無法使用',
  '사용할 수 없음',
];
export const msg_thinkingDefault: Message = ['Model default', '模型默认', '模型預設'];
export const msg_thinkingOff: Message = ['Off', '关闭', '關閉'];
export const msg_thinkingMinimal: Message = ['Minimal', '最低', '最低'];
export const msg_thinkingLow: Message = ['Low', '低', '低'];
export const msg_thinkingMedium: Message = ['Medium', '中', '中'];
export const msg_thinkingHigh: Message = ['High', '高', '高'];
export const msg_thinkingXhigh: Message = ['Extra high', '很高', '很高'];
export const msg_thinkingMax: Message = ['Maximum', '最高', '最高'];
export const msg_thinkingUltra: Message = ['Ultra', '极高', '極高'];
export const msg_makeDefault: Message = [
  'Set selected as default',
  '将已选模型设为默认',
  '將已選模型設為預設',
];
export const msg_clearDefault: Message = ['Clear default', '清除默认项', '清除預設項'];
export const msg_noDefault: Message = [
  'No default model.',
  '尚未设置默认模型。',
  '尚未設定預設模型。',
];
export const msg_defaultUnavailable: Message = [
  'The saved default is unavailable.',
  '已保存的默认模型不可用。',
  '已儲存的預設模型無法使用。',
];
export const msg_defaultHelp: Message = [
  'Suggested when no model is selected. Your current choice stays unchanged.',
  '未选模型时建议默认项，当前选择保持不变。',
  '未選模型時建議預設項，目前選擇維持不變。',
];
export const msg_confirmDefault: Message = ['Confirm', '确认', '確認'];
export const msg_confirmSetDefault: Message = [
  'Use this model as the default?',
  '将此模型设为默认？',
  '將此模型設為預設？',
];
export const msg_confirmClearDefault: Message = [
  'Clear this saved default?',
  '清除此已保存默认项？',
  '清除此已儲存預設項？',
];
export const msg_modelSettings: Message = ['Model settings', '模型设置', '模型設定'];
export const msg_modelToolsAuto: Message = ['Auto', '自动', '自動'];
export const msg_modelToolsOn: Message = ['On', '开启', '開啟'];
export const msg_modelToolsOff: Message = ['Off', '关闭', '關閉'];
export const msg_modelCodeModeHelp: Message = [
  'Use JavaScript to coordinate tool calls.',
  '用 JavaScript 编排工具调用。',
  '用 JavaScript 編排工具呼叫。',
];
export const msg_modelApplyPatchHelp: Message = [
  'Edit files with patches instead of Edit/Write.',
  '通过补丁编辑文件，替代 Edit/Write。',
  '透過補丁編輯檔案，取代 Edit/Write。',
];
export const msg_modelToolsScope: Message = [
  'Saved for this model on this connection. Applies from the next turn; Auto follows model defaults.',
  '仅作用于此连接中的该模型，从下一轮生效。“自动”遵循模型默认策略。',
  '僅作用於此連線中的該模型，從下一輪生效。「自動」遵循模型預設策略。',
];
export const msg_modelContextWindow: Message = [
  'Context window (tokens)',
  '上下文窗口（tokens）',
  '上下文視窗（tokens）',
];
export const msg_modelInputLimit: Message = [
  'Input limit (tokens)',
  '输入上限（tokens）',
  '輸入上限（tokens）',
];
export const msg_modelMaxOutput: Message = [
  'Maximum output (tokens)',
  '最大输出（tokens）',
  '最大輸出（tokens）',
];
export const msg_modelCompactionThreshold: Message = [
  'Compaction threshold (tokens)',
  '压缩阈值（tokens）',
  '壓縮閾值（tokens）',
];
export const msg_modelLimitsHelp: Message = [
  'Leave blank for automatic values. Limits apply from the next request; output is also bounded by model capacity and remaining context.',
  '留空使用自动值，从下一次请求生效。实际输出还受模型容量和剩余上下文约束。',
  '留空使用自動值，從下一次請求生效。實際輸出仍受模型容量及剩餘上下文約束。',
];
export const msg_modelCurrentLimit: Message = ['Current value', '当前生效值', '目前生效值'];
export const msg_modelOutputCapacity: Message = [
  'Model output capacity',
  '模型输出容量',
  '模型輸出容量',
];
export const msg_modelLimitsInvalid: Message = [
  'Enter positive whole token counts, or leave blank for automatic values. Reload if the model configuration changed.',
  '请输入正整数，或留空使用自动值。若模型配置已变化，请重新打开设置。',
  '請輸入正整數，或留空使用自動值。若模型設定已變更，請重新開啟設定。',
];
export const msg_modelToolsSave: Message = ['Save model settings', '保存模型设置', '儲存模型設定'];
export const msg_modelToolsSaved: Message = [
  'Model settings saved.',
  '模型设置已保存。',
  '模型設定已儲存。',
];
export const msg_modelToolsRejected: Message = [
  'Model settings were not changed.',
  '模型设置未更改。',
  '模型設定未變更。',
];
export const msg_defaultSaved: Message = [
  'Default model saved.',
  '默认模型已保存。',
  '預設模型已儲存。',
];
export const msg_defaultCleared: Message = [
  'Default model cleared.',
  '默认模型已清除。',
  '預設模型已清除。',
];
export const msg_defaultRejected: Message = [
  'The default was not changed.',
  '默认项未更改。',
  '預設項未變更。',
];
export const msg_defaultConflict: Message = [
  'Saved settings changed. Refresh models and confirm again.',
  '已保存设置发生变化，请刷新模型并重新确认。',
  '已儲存設定發生變化，請重新整理模型並再次確認。',
];
export const msg_defaultUnknown: Message = [
  'Result not yet known. Check the original operation.',
  '结果尚未确定，请查询原操作。',
  '結果尚未確定，請查詢原操作。',
];
export const msg_earlierDefaultOperations: Message = [
  'Model settings changes',
  '模型设置变更记录',
  '模型設定變更紀錄',
];
export const msg_refreshDefaultOperations: Message = [
  'Refresh operations',
  '刷新操作记录',
  '重新整理操作紀錄',
];
export const msg_earlierDefaultHelp: Message = [
  'Earlier operations may refer to other models. Checking them never changes your current choice.',
  '先前操作可能属于其他模型，查询不会更改当前选择。',
  '先前操作可能屬於其他模型，查詢不會變更目前選擇。',
];
export const msg_defaultHistorySaved: Message = [
  'Default setting saved.',
  '默认设置已保存。',
  '預設設定已儲存。',
];
export const msg_fieldPlaceholder: Message = ['Enter: ', '填写：', '填寫：'];
export const msg_createConnection: Message = ['Add connection', '添加连接', '新增連線'];
export const msg_connectionProvider: Message = ['Provider', '服务商', '供應商'];
export const msg_removeConnection: Message = ['Remove connection', '移除连接', '移除連線'];
export const msg_confirmRemoveConnection: Message = [
  'Remove this saved connection, its API keys and its default model? Unsaved fields will be discarded. Earlier conversations are kept.',
  '移除此已保存连接、它的密钥及默认模型？未保存字段将丢弃，已有会话会保留。',
  '移除此已儲存連線、它的金鑰及預設模型？未儲存欄位將捨棄，已有對話會保留。',
];
export const msg_connectionRemoved: Message = [
  'Connection removed.',
  '连接已移除。',
  '連線已移除。',
];
export const msg_useDefaultField: Message = ['Use default value', '使用默认值', '使用預設值'];
export const msg_defaultFieldKept: Message = [
  'The default value will be used.',
  '将使用默认值。',
  '將使用預設值。',
];
export const msg_newCollectionHelp: Message = [
  'Use one model ID per line; overrides and body overlay use a JSON object or null for no override.',
  '每行一个模型 ID；模型覆盖与请求体附加配置使用 JSON 对象，null 表示不覆盖。',
  '每行一個模型 ID；模型覆寫與請求內容附加設定使用 JSON 物件，null 表示不覆寫。',
];
export const msg_defaultPrefillFailed: Message = [
  'The default value could not be put in this editor. Your draft has been kept.',
  '默认值未能放入编辑器，草稿已保留。',
  '預設值未能放入編輯器，草稿已保留。',
];
export const msg_editConnection: Message = ['Edit connection', '编辑连接', '編輯連線'];
export const msg_saveConnection: Message = ['Save connection', '保存连接', '儲存連線'];
export const msg_connectionName: Message = ['Name', '名称', '名稱'];
export const msg_connectionSlug: Message = ['Connection ID', '连接标识', '連線識別碼'];
export const msg_connectionEndpoint: Message = ['Endpoint', '端点', '端點'];
export const msg_connectionModels: Message = ['Model IDs', '模型 ID', '模型 ID'];
export const msg_connectionConfiguration: Message = [
  'Provider configuration',
  '提供商配置',
  '提供商設定',
];
export const msg_connectionOverrides: Message = ['Model overrides', '模型覆盖配置', '模型覆寫設定'];
export const msg_connectionOverlay: Message = [
  'Request body overlay',
  '请求体附加配置',
  '請求本文附加設定',
];
export const msg_connectionEnabled: Message = ['Enabled', '已启用', '已啟用'];
export const msg_connectionDisabled: Message = ['Disabled', '已停用', '已停用'];
export const msg_chooseProvider: Message = ['Choose a provider', '选择提供商', '選擇提供商'];
export const msg_searchProviders: Message = [
  'Search providers or sign-in methods…',
  '搜索提供商或登录方式…',
  '搜尋提供商或登入方式…',
];
export const msg_loginStarting: Message = ['Starting sign-in…', '正在开始登录…', '正在開始登入…'];
export const msg_loginInstructions: Message = [
  'Open this address in your browser and enter the device code:',
  '在浏览器打开以下地址并输入设备码：',
  '在瀏覽器開啟以下網址並輸入裝置碼：',
];

export const msg_loginWaiting: Message = [
  'Waiting for browser sign-in…',
  '等待浏览器授权…',
  '等待瀏覽器授權…',
];
export const msg_loginSaved: Message = [
  'Signed in. Credentials saved.',
  '登录成功，凭据已保存。',
  '登入成功，憑據已儲存。',
];
export const msg_loginCancelling: Message = [
  'Cancelling sign-in…',
  '正在取消登录…',
  '正在取消登入…',
];
export const msg_loginCancelled: Message = ['Sign-in cancelled.', '已取消登录。', '已取消登入。'];
export const msg_loginExpired: Message = [
  'The device code expired. Start sign-in again.',
  '设备码已过期，请重新登录。',
  '裝置碼已過期，請重新登入。',
];
export const msg_loginTransportFailed: Message = [
  'Could not connect to the sign-in service. Check your network and proxy settings.',
  '无法连接登录服务，请检查网络和代理设置。',
  '無法連線至登入服務，請檢查網路和代理設定。',
];
export const msg_loginFailed: Message = ['Sign-in failed.', '登录失败。', '登入失敗。'];
export const msg_searchConnections: Message = ['Search connections…', '搜索连接…', '搜尋連線…'];

export const msg_searchUnavailable: Message = [
  'Could not read the search. Edit it to retry.',
  '无法读取搜索内容，请修改后重试。',
  '無法讀取搜尋內容，請修改後重試。',
];
export const msg_noSearchResults: Message = [
  'No matching results.',
  '没有匹配的结果。',
  '沒有符合的結果。',
];

export const msg_providersUnavailable: Message = [
  'Could not load providers.',
  '无法加载提供商。',
  '無法載入提供商。',
];
export const msg_noProviders: Message = [
  'No providers are installed.',
  '尚未安装提供商。',
  '尚未安裝提供商。',
];
export const msg_setupDone: Message = ['Done', '完成', '完成'];
export const msg_loadingConnectionModels: Message = [
  'Loading models…',
  '正在加载模型…',
  '正在載入模型…',
];
export const msg_loadConnectionModels: Message = ['Load models', '加载模型', '載入模型'];
export const msg_connectionModelsFailed: Message = [
  'Sign-in is saved. Models could not be loaded. Check your network or API key, then retry.',
  '登录已保存，但模型加载失败。请检查网络或 API Key 后重试。',
  '登入已儲存，但模型載入失敗。請檢查網路或 API Key 後重試。',
];
export const msg_connectionReady: Message = [
  'Connection ready. You can now select a model and start chatting.',
  '连接已就绪，可以选择模型并开始对话。',
  '連線已就緒，可以選擇模型並開始對話。',
];
export const msg_changeProvider: Message = ['Change service', '更换服务', '更換服務'];
export const msg_continueSignIn: Message = ['Continue to sign in', '继续登录', '繼續登入'];
export const msg_signInConnection: Message = [
  'Sign in / API key',
  '登录 / API Key',
  '登入 / API Key',
];
export const msg_copyLoginLink: Message = ['Copy link', '复制链接', '複製連結'];
export const msg_copyLoginCode: Message = ['Copy code', '复制设备码', '複製裝置碼'];
export const msg_connectionSetupHelp: Message = [
  'Next: sign in or enter an API key. Models will be loaded automatically.',
  '下一步：登录或填写 API Key，随后自动加载模型。',
  '下一步：登入或填寫 API Key，隨後自動載入模型。',
];
export const msg_replaceField: Message = ['Edit / replace', '编辑／替换', '編輯／替換'];
export const msg_keepSavedField: Message = ['Keep saved value', '保留已保存值', '保留已儲存值'];
export const msg_savedFieldKept: Message = [
  'The saved value will be kept.',
  '将保留已保存的值。',
  '將保留已儲存的值。',
];
export const msg_replaceCollectionHelp: Message = [
  'Editing replaces the entire saved collection. Use one model ID per line; overrides and body overlay use a JSON object or null to clear.',
  '编辑将替换整个已保存集合。模型 ID 每行一个；覆盖配置和请求体使用 JSON 对象，null 表示清除。',
  '編輯將替換整個已儲存集合。模型 ID 每行一個；覆寫設定與請求本文使用 JSON 物件，null 表示清除。',
];
export const msg_configurationHelp: Message = [
  'Public settings only. API keys belong in the separate API key form. Endpoint and complete configuration are edited separately.',
  '仅填写公开配置。API 密钥请使用单独的密钥表单。端点与完整配置分别编辑。',
  '僅填寫公開設定。API 金鑰請使用獨立的金鑰表單。端點與完整設定分別編輯。',
];
export const msg_fieldPrefillFailed: Message = [
  'The saved value could not be put in this editor. It has not been changed.',
  '无法将已保存值放入此编辑器，原值未改变。',
  '無法將已儲存值放入此編輯器，原值未改變。',
];
export const msg_replaceFromEmpty: Message = [
  'Replace with a new value',
  '重新填写替换值',
  '重新填寫替換值',
];
export const msg_noConnectionChanges: Message = [
  'No changes to save.',
  '没有需要保存的修改。',
  '沒有需要儲存的修改。',
];
export const msg_invalidConnectionFields: Message = [
  'Check the name, connection ID, model IDs and JSON. Your draft has been kept.',
  '请检查名称、连接标识、模型 ID 和 JSON，草稿已保留。',
  '請檢查名稱、連線識別碼、模型 ID 和 JSON，草稿已保留。',
];
export const msg_connectionDraftKept: Message = [
  'The fields changed or could not be read. All drafts have been kept.',
  '字段发生变化或无法读取，所有草稿已保留。',
  '欄位發生變化或無法讀取，所有草稿已保留。',
];
export const msg_connectionConflict: Message = [
  'The saved connection changed. Your draft has been kept. Review the current connection before saving.',
  '已保存连接发生变化，草稿已保留。保存前请复核当前连接。',
  '已儲存連線發生變化，草稿已保留。儲存前請複核目前連線。',
];
export const msg_connectionRejected: Message = [
  'The connection was not saved. Your draft has been kept.',
  '连接未保存，草稿已保留。',
  '連線未儲存，草稿已保留。',
];
export const msg_connectionUnknown: Message = [
  'The result is not yet known. Check this operation before trying again.',
  '结果暂未确认，请先查询此操作再重试。',
  '結果暫未確認，請先查詢此操作再重試。',
];
export const msg_connectionSaved: Message = [
  'Connection saved for',
  '连接已保存：',
  '連線已儲存：',
];
export const msg_discardConnection: Message = [
  'Discard these unsaved changes and leave?',
  '放弃这些未保存的修改并离开？',
  '捨棄這些未儲存的修改並離開？',
];
export const msg_connectionLeaveUnknown: Message = [
  'Leave? The operation may still finish. Check its result in earlier connection operations.',
  '离开？操作仍可能完成，可在之前的连接操作中查询结果。',
  '離開？操作仍可能完成，可在先前的連線操作中查詢結果。',
];
export const msg_connectionRebaseHelp: Message = [
  'Review the full current connection below. Continuing will use its version and apply every field you chose to edit or replace. Complete configuration replaces all saved keys, including keys added by others.',
  '请复核下方完整的当前连接。继续后将使用此版本，并应用所有选择编辑或替换的字段。完整配置会替换所有已保存键，包括其他人新增的键。',
  '請複核下方完整的目前連線。繼續後將使用此版本，並套用所有選擇編輯或替換的欄位。完整設定會替換所有已儲存鍵，包括其他人新增的鍵。',
];
export const msg_earlierConnectionOperations: Message = [
  'Connection changes',
  '连接变更记录',
  '連線變更紀錄',
];
export const msg_earlierConnectionHelp: Message = [
  'These operations may belong to another connection. Checking them never changes these fields.',
  '这些操作可能属于其他连接，查询不会改变当前字段。',
  '這些操作可能屬於其他連線，查詢不會改變目前欄位。',
];

export const msg_reviewConnection: Message = [
  'Review current connection',
  '复核当前连接',
  '複核目前連線',
];
export const msg_reviewReady: Message = [
  'Use this connection and saved-key version for this draft?',
  '将此草稿用于这个连接及已保存的密钥版本？',
  '將此草稿用於這個連線及已儲存的金鑰版本？',
];
export const msg_useConnection: Message = ['Use this connection', '使用此连接', '使用此連線'];
export const msg_leaveUnknown: Message = [
  'Leave? The operation may still finish. Check its result in earlier key operations.',
  '离开？操作仍可能完成，可在之前的密钥操作中查询结果。',
  '離開？操作仍可能完成，可在先前的金鑰操作中查詢結果。',
];
export const msg_leave: Message = ['Leave', '离开', '離開'];
export const msg_settings: Message = ['Connections', '连接', '連線'];
export const msg_back: Message = ['Back', '返回', '返回'];
export const msg_noConnections: Message = ['No connections yet.', '暂无连接。', '尚無連線。'];
export const msg_connectionsUnavailable: Message = [
  'Could not load connections.',
  '无法加载连接。',
  '無法載入連線。',
];
export const msg_refreshConnections: Message = ['Refresh connections', '刷新连接', '重新整理連線'];

export const msg_credentials: Message = ['Credentials', '凭据', '憑據'];
export const msg_keyPlaceholder: Message = ['Enter an API key', '输入 API 密钥', '輸入 API 金鑰'];
export const msg_keyHelp: Message = [
  'The key is saved to this connection. It is never shown again.',
  '密钥将保存到此连接，保存后不会再次显示。',
  '金鑰將儲存到此連線，儲存後不會再次顯示。',
];
export const msg_keyConfigured: Message = [
  'Credentials are saved.',
  '已保存凭据。',
  '已儲存憑據。',
];
export const msg_keyAbsent: Message = [
  'No credentials are saved.',
  '尚未保存凭据。',
  '尚未儲存憑據。',
];
export const msg_keyLoading: Message = [
  'Checking saved credentials…',
  '正在检查已保存的凭据…',
  '正在檢查已儲存的憑據…',
];
export const msg_keyUnavailable: Message = [
  'Could not check saved credentials.',
  '无法检查已保存的凭据。',
  '無法檢查已儲存的憑據。',
];
export const msg_keyRefresh: Message = ['Check credentials', '检查凭据', '檢查憑據'];
export const msg_saveKey: Message = ['Save key', '保存密钥', '儲存金鑰'];
export const msg_removeKey: Message = [
  'Remove saved credentials',
  '移除已保存的凭据',
  '移除已儲存的憑據',
];
export const msg_confirmRemoveKey: Message = [
  'Remove this connection’s saved credentials?',
  '移除此连接已保存的凭据？',
  '移除此連線已儲存的憑據？',
];
export const msg_confirmRemove: Message = ['Remove credentials', '移除凭据', '移除憑據'];
export const msg_cancel: Message = ['Cancel', '取消', '取消', '취소'];
export const msg_discardKey: Message = [
  'Discard the unsaved key and leave?',
  '放弃未保存的密钥并离开？',
  '捨棄未儲存的金鑰並離開？',
];
export const msg_discard: Message = ['Discard and leave', '放弃并离开', '捨棄並離開'];
export const msg_keepEditing: Message = ['Keep editing', '继续编辑', '繼續編輯'];
export const msg_keySaved: Message = ['API key saved.', 'API 密钥已保存。', 'API 金鑰已儲存。'];
export const msg_keyRemoved: Message = [
  'Saved credentials removed.',
  '已移除保存的凭据。',
  '已移除儲存的憑據。',
];
export const msg_keyRejected: Message = [
  'Credentials were not saved.',
  '凭据未保存。',
  '憑據未儲存。',
];
export const msg_keyConflict: Message = [
  'The connection or saved key changed. Your draft has been kept. Reopen this connection to review it.',
  '连接或已保存的密钥发生变化，草稿已保留。请重新打开此连接查看。',
  '連線或已儲存的金鑰發生變化，草稿已保留。請重新開啟此連線查看。',
];
export const msg_keyUnknown: Message = [
  'The result is unconfirmed. Check the original receipt before retrying.',
  '结果尚未确认，请先查询原操作结果，再决定是否重试。',
  '結果尚未確認，請先查詢原操作結果，再決定是否重試。',
];
export const msg_keyTooLarge: Message = [
  'Use a key of at most 64 KiB.',
  '密钥最多为 64 KiB。',
  '金鑰最多為 64 KiB。',
];
export const msg_earlierOperations: Message = [
  'API key changes',
  'API 密钥变更记录',
  'API 金鑰變更紀錄',
];
export const msg_earlierHelp: Message = [
  'These operations may belong to another connection. Checking them never changes this draft.',
  '这些操作可能属于其他连接。查询结果不会改变当前草稿。',
  '這些操作可能屬於其他連線。查詢結果不會改變目前草稿。',
];
export const msg_historyUnavailable: Message = [
  'Could not load the change history.',
  '无法加载变更记录。',
  '無法載入變更紀錄。',
];

export const msg_historySaved: Message = ['Credentials saved for', '凭据已保存至', '憑據已儲存至'];
export const msg_historyRemoved: Message = [
  'Credentials removed for',
  '已移除此连接的凭据：',
  '已移除此連線的憑據：',
];
export const msg_historyRejected: Message = [
  'Operation was rejected.',
  '操作已被拒绝。',
  '操作已被拒絕。',
];
export const msg_historyUnknown: Message = [
  'Result not yet known.',
  '结果暂未确认。',
  '結果暫未確認。',
];
export const msg_connectionChanged: Message = [
  'This connection changed. Your draft still belongs to the connection you opened.',
  '此连接发生变化。草稿仍属于打开时的连接。',
  '此連線發生變化。草稿仍屬於開啟時的連線。',
];
export const msg_nextModelPage: Message = ['Next', '下一页', '下一頁'];
export const msg_previousModels: Message = ['Previous', '上一页', '上一頁'];
export const msg_renameSession: Message = ['Rename…', '重命名…', '重新命名…'];
export const msg_archiveSession: Message = ['Archive conversation', '归档会话', '封存對話'];
export const msg_restoreSession: Message = ['Restore conversation', '恢复会话', '還原對話'];
export const msg_deleteSession: Message = ['Delete conversation…', '删除会话…', '刪除對話…'];
export const msg_deleteSessionTitle: Message = ['Delete conversation?', '删除会话？', '刪除對話？'];
export const msg_deleteSessionHelp: Message = [
  'This permanently removes this conversation from Maka. Workspace files and independent copies are kept.',
  '将从 Maka 永久移除此会话。工作区文件和独立副本会保留。',
  '將從 Maka 永久移除此對話。保留工作區檔案和獨立副本。',
];
export const msg_sessionChangeBusy: Message = [
  'Stop this conversation and clear its queued messages before archiving or deleting it.',
  '请先停止此会话并处理排队消息，再归档或删除。',
  '請先停止此對話並處理佇列訊息，再封存或刪除。',
];
export const msg_sessionChangeFailed: Message = [
  'The conversation changed or could not be updated. Refresh and try again.',
  '会话已变化或操作未能完成，请刷新后重试。',
  '對話已變更或操作未能完成，請重新整理後重試。',
];
export const msg_archivedSessions: Message = ['Archived', '已归档', '已封存'];
export const msg_noArchivedSessions: Message = [
  'No archived conversations',
  '没有已归档会话',
  '沒有已封存對話',
];
export const msg_deleteAction: Message = ['Delete', '删除', '刪除'];
export const msg_chooseModel: Message = ['Choose model', '选择模型', '選擇模型'];
export const msg_savedModelUnavailable: Message = [
  'Saved model unavailable — choose another',
  '原模型不可用，请重新选择',
  '原模型無法使用，請重新選擇',
];
export const msg_modelSaveFailed: Message = [
  'Could not save the model choice. Select it again to retry.',
  '模型选择未能保存，请重新选择以重试。',
  '模型選擇未能儲存，請重新選擇以重試。',
];
export const msg_models: Message = ['Models', '模型', '模型', '모델'];
export const msg_findNoResults: Message = ['No matches', '无匹配结果', '無符合結果'];
export const msg_findFieldBody: Message = ['Message', '消息', '訊息'];
export const msg_findFieldThinking: Message = ['Thinking', '思考', '思考'];
export const msg_findFieldTool: Message = ['Tool', '工具', '工具'];
export const msg_findFieldArguments: Message = ['Tool arguments', '工具参数', '工具參數'];
export const msg_findFieldResult: Message = ['Tool result', '工具结果', '工具結果'];
export const msg_findFieldReceipt: Message = ['Operation receipt', '操作回执', '操作回執'];
export const msg_findFieldFailure: Message = ['Failure', '失败原因', '失敗原因'];
export const msg_findFieldError: Message = ['Error class', '错误类型', '錯誤類型'];
export const msg_browseMessages: Message = ['Browse messages', '浏览消息', '瀏覽訊息'];
export const msg_copyMessage: Message = ['Copy message', '复制消息', '複製訊息'];
export const msg_copySource: Message = ['Copy message source', '复制消息原文', '複製訊息原文'];
export const msg_copyToolResultSource: Message = [
  'Copy raw tool result',
  '复制工具结果原文',
  '複製工具結果原文',
];
export const msg_copyToolArgumentsSource: Message = [
  'Copy raw tool arguments',
  '复制工具参数原文',
  '複製工具參數原文',
];
export const msg_copyLoading: Message = [
  'Loading full message…',
  '正在读取完整消息…',
  '正在讀取完整訊息…',
];
export const msg_copyEmpty: Message = ['Empty message', '消息为空', '訊息為空'];
export const msg_copyUnavailable: Message = ['Message unavailable', '消息不可用', '訊息無法取得'];
export const msg_copyStreaming: Message = [
  'Message is still streaming',
  '消息尚未结束',
  '訊息尚未結束',
];
export const msg_browseHint: Message = [
  '↑↓ messages · Space/Enter toggle · Shift+arrows select · Esc compose',
  '↑↓ 消息 · Space/Enter 展开收起 · Shift+方向键选择 · Esc 返回输入',
  '↑↓ 訊息 · Space/Enter 展開收合 · Shift+方向鍵選取 · Esc 返回輸入',
];
export const msg_findConversation: Message = [
  'Find in conversation',
  '在会话中查找',
  '在對話中尋找',
];
export const msg_findPlaceholder: Message = ['Find…', '查找…', '尋找…'];
export const msg_findFailed: Message = ['Search unavailable', '搜索暂不可用', '搜尋暫不可用'];
export const msg_findNavigate: Message = [
  'Next match / previous match',
  '下一个匹配 / 上一个匹配',
  '下一個符合項目 / 上一個符合項目',
];
export const msg_findHistory: Message = ['History', '全部历史', '全部歷史'];
export const msg_findLocal: Message = ['Current content', '当前内容', '目前內容'];
export const msg_searchModels: Message = [
  'Search models or connections…',
  '搜索模型或连接…',
  '搜尋模型或連線…',
];
export const msg_noMatchingModels: Message = [
  'No matching models.',
  '没有匹配的模型。',
  '沒有符合的模型。',
];
export const msg_searchTooLong: Message = [
  'Search is limited to 256 characters.',
  '搜索最多 256 个字符。',
  '搜尋最多 256 個字元。',
];
export const msg_loadingModels: Message = ['Loading models…', '正在加载模型…', '正在載入模型…'];
export const msg_modelsUnavailable: Message = [
  'Could not load models.',
  '无法加载模型。',
  '無法載入模型。',
];
export const msg_noModels: Message = [
  'Add a connection to choose a model.',
  '添加连接后即可选择模型。',
  '新增連線後即可選擇模型。',
];
export const msg_refreshModels: Message = ['Refresh models', '刷新模型', '重新整理模型'];

export const msg_closeModels: Message = ['Close', '关闭', '關閉', '닫기'];
export const msg_approvalTitle: Message = ['Confirm service call', '确认服务调用', '確認服務呼叫'];
export const msg_approvalDeny: Message = ['Deny this call', '拒绝本次调用', '拒絕本次呼叫'];
export const msg_approvalAllow: Message = ['Allow this call', '允许本次调用', '允許本次呼叫'];
export const msg_computerApprovalAllow: Message = [
  'Allow for this conversation',
  '允许此会话使用',
  '允許此對話使用',
];
export const msg_computerApprovalDeny: Message = ['Deny access', '拒绝授权', '拒絕授權'];

export const msg_approvalAllowed: Message = [
  'This call was approved',
  '已允许本次调用',
  '已允許本次呼叫',
];
export const msg_approvalDenied: Message = [
  'This call was denied',
  '已拒绝本次调用',
  '已拒絕本次呼叫',
];
export const msg_questionsTitle: Message = ['Questions', '待回答问题', '待回答問題'];
export const msg_reviewRequest: Message = ['Review request', '审核请求', '審核請求'];
export const msg_questionText: Message = ['Write an answer', '填写答案', '填寫答案'];
export const msg_formTitle: Message = ['Form', '表单', '表單'];
export const msg_formSubmit: Message = ['Submit form', '提交表单', '提交表單'];
export const msg_formDecline: Message = ['Decline', '拒绝填写', '拒絕填寫'];
export const msg_formCancel: Message = ['Cancel request', '取消请求', '取消請求'];
export const msg_formInclude: Message = ['Include field', '填写此项', '填寫此項'];
export const msg_formOmit: Message = ['Omit field', '省略此项', '省略此項'];
export const msg_formRequired: Message = ['Required', '必填', '必填'];
export const msg_formYes: Message = ['Yes', '是', '是'];
export const msg_formNo: Message = ['No', '否', '否'];
export const msg_formInvalid: Message = [
  'Check required fields, types, limits and formats before submitting again.',
  '请检查必填项、类型、范围和格式后重新提交。',
  '請檢查必填項、類型、範圍和格式後重新提交。',
];
export const msg_formReadFailed: Message = [
  'The draft changed or could not be read. Review it and submit again.',
  '草稿已变化或无法读取，请检查后重新提交。',
  '草稿已變化或無法讀取，請檢查後重新提交。',
];
export const msg_questionSkip: Message = ['Skip this question', '跳过此题', '跳過此題'];
export const msg_questionSubmit: Message = ['Submit answers', '提交答案', '提交答案'];
export const msg_questionAnswered: Message = ['Answers recorded', '答案已记录', '答案已記錄'];
export const msg_questionClosed: Message = [
  'This request is closed',
  '此请求已关闭',
  '此請求已關閉',
];
export const msg_questionLoading: Message = ['Loading request…', '正在读取请求…', '正在讀取請求…'];
export const msg_interactionUnavailable: Message = [
  'The request could not be read. Check again.',
  '暂时无法读取请求，请重新检查。',
  '暫時無法讀取請求，請重新檢查。',
];
export const msg_interactionChanged: Message = [
  'This request is no longer available for a response.',
  '此请求已无法响应。',
  '此請求已無法回應。',
];
export const msg_interactionUnknown: Message = [
  'The response result is unknown. Check its original receipt before trying again.',
  '响应提交结果未知，请先检查原操作回执。',
  '回應提交結果未知，請先檢查原操作回執。',
];
export const msg_questionInvalid: Message = [
  'Complete each question or choose Skip. Text answers must be 1–2048 bytes.',
  '请回答每个问题或选择跳过。文字答案需为 1–2048 字节。',
  '請回答每個問題或選擇跳過。文字答案需為 1–2048 位元組。',
];
export const msg_new: Message = ['New conversation', '新建对话', '新增對話'];
export const msg_conversations: Message = ['Conversations', '对话', '對話'];
export const msg_archivedConversation: Message = [
  'This conversation is archived.',
  '此对话已归档。',
  '此對話已封存。',
];

export const msg_refreshSessions: Message = ['Refresh', '刷新', '重新整理'];
export const msg_allSessions: Message = ['All', '全部', '全部'];
export const msg_needsYou: Message = ['Needs You', '需要你', '需要你'];
export const msg_noneNeedsYou: Message = [
  'No conversations need you',
  '没有对话需要你处理',
  '沒有對話需要你處理',
];
export const msg_sessionsUnavailable: Message = [
  'Conversations changed or could not be loaded. Refresh to continue.',
  '对话列表已变化或加载失败。请刷新后继续。',
  '對話列表已變更或載入失敗。請重新整理後繼續。',
];
export const msg_send: Message = ['Send', '发送', '傳送'];
export const msg_stop: Message = ['Stop', '停止', '停止'];
export const msg_queueEdit: Message = ['Edit queued message', '编辑队列消息', '編輯佇列訊息'];
export const msg_queueSave: Message = ['Save message', '保存消息', '儲存訊息'];
export const msg_queueEditHint: Message = [
  'Enter: new line · Ctrl+S / Ctrl+Enter: save',
  'Enter 换行 · Ctrl+S / Ctrl+Enter 保存',
  'Enter 換行 · Ctrl+S / Ctrl+Enter 儲存',
];
export const msg_queueLoading: Message = [
  'Loading queued message…',
  '正在读取队列消息…',
  '正在讀取佇列訊息…',
];
export const msg_queueChanged: Message = [
  'The queue changed. Review the current messages and try again.',
  '队列已变化，请确认当前消息后重试。',
  '佇列已變更，請確認目前訊息後重試。',
];
export const msg_placeholder: Message = [
  'What would you like to work on?',
  '你想一起完成什么？',
  '你想一起完成什麼？',
];
export const msg_draft: Message = ['Message', '消息', '訊息'];
export const msg_edit: Message = ['Edit message', '编辑消息', '編輯訊息'];
export const msg_undo: Message = ['Undo', '撤销', '復原'];
export const msg_redo: Message = ['Redo', '重做', '重做'];
export const msg_cut: Message = ['Cut', '剪切', '剪下'];
export const msg_copy: Message = ['Copy', '复制', '複製'];
export const msg_paste: Message = ['Paste', '粘贴', '貼上'];
export const msg_selectAll: Message = ['Select all', '全选', '全選'];
export const msg_welcome: Message = [
  'A place to think.',
  '留一点空间，想点新东西。',
  '留一點空間，想點新東西。',
];
export const msg_welcomeCopy: Message = [
  'Start a conversation and make room for the next idea.',
  '开启一段对话，让想法慢慢成形。',
  '開啟一段對話，讓想法慢慢成形。',
];
export const msg_configureModels: Message = ['Set up models', '配置模型', '設定模型'];
export const msg_setupConnectionHint: Message = [
  'Add a connection and enable a chat model to start a conversation.',
  '添加连接并启用聊天模型，即可开始对话。',
  '新增連線並啟用聊天模型，即可開始對話。',
];
export const msg_setupModelHint: Message = [
  'Choose a model to start a conversation. Existing conversations are still available.',
  '选择模型以开始对话。仍可查看已有会话。',
  '選擇模型以開始對話。仍可查看現有會話。',
];
export const msg_loading: Message = ['Loading conversation…', '正在加载对话…', '正在載入對話…'];
export const msg_older: Message = ['Earlier messages', '较早的消息', '較早的訊息'];
export const msg_newer: Message = ['Next messages', '后续消息', '後續訊息'];
export const msg_latest: Message = ['Latest messages', '最新消息', '最新訊息'];
export const msg_toEnd: Message = ['Scroll to end', '滚动到底部', '捲動到底部'];
export const msg_partial: Message = [
  'Message not fully loaded',
  '消息尚未完整加载',
  '訊息尚未完整載入',
];
export const msg_markRead: Message = ['Mark read through here', '标记已读至此', '標記已讀至此'];
export const msg_unread: Message = ['Unread', '未读', '未讀'];
export const msg_readSource: Message = ['Read message source', '阅读消息原文', '閱讀訊息原文'];
export const msg_toolFilePath: Message = ['File', '文件', '檔案'];
export const msg_toolCopyPath: Message = ['Copy file path', '复制文件路径', '複製檔案路徑'];
export const msg_toolReadAction: Message = ['Read file', '读取文件', '讀取檔案'];
export const msg_toolWriteAction: Message = ['Write file', '写入文件', '寫入檔案'];
export const msg_toolEditAction: Message = ['Edit file', '替换文本', '取代文字'];
export const msg_toolPatchAction: Message = ['Apply patch', '应用补丁', '套用修補'];
export const msg_toolRequestedBefore: Message = [
  'Requested replacement · original',
  '请求替换 · 原内容',
  '請求替換 · 原內容',
];
export const msg_toolRequestedAfter: Message = [
  'Requested content',
  '请求写入内容',
  '請求寫入內容',
];
export const msg_toolRecordedBefore: Message = [
  'Recorded original content',
  '已记录的原文件内容',
  '已記錄的原檔案內容',
];
export const msg_toolReadContent: Message = [
  'Recorded file content',
  '已记录的文件内容',
  '已記錄的檔案內容',
];
export const msg_toolPatch: Message = ['Requested patch', '请求的补丁', '請求的補丁'];
export const msg_toolPatchOperation: Message = ['File operation', '文件操作', '檔案操作'];
export const msg_toolBusinessFailure: Message = [
  'File operation failed',
  '文件操作失败',
  '檔案操作失敗',
];
export const msg_toolOriginalUnavailable: Message = [
  'Original file content is unavailable.',
  '原文件内容不可用。',
  '原檔案內容無法取得。',
];
export const msg_toolByteRange: Message = ['bytes', '字节', '位元組'];
export const msg_toolReadLines: Message = ['Recorded lines', '已记录的行', '已記錄的行'];
export const msg_toolArguments: Message = ['Tool arguments', '工具参数', '工具參數'];
export const msg_toolResult: Message = ['Tool result', '工具结果', '工具結果'];
export const msg_sourceBack: Message = ['Back to conversation', '返回对话', '返回對話'];
export const msg_sourceTitle: Message = ['Message source', '消息原文', '訊息原文'];
export const msg_sourceFirst: Message = ['Beginning', '开头', '開頭'];
export const msg_sourcePrevious: Message = ['Previous excerpt', '上一段', '上一段'];
export const msg_sourceNext: Message = ['Next excerpt', '下一段', '下一段'];
export const msg_sourceLast: Message = ['End', '末尾', '末尾'];
export const msg_sourceRetry: Message = ['Retry', '重试', '重試'];
export const msg_sourceComplete: Message = ['Complete source', '完整原文', '完整原文'];
export const msg_sourceBeginning: Message = ['Beginning of source', '原文开头', '原文開頭'];
export const msg_sourceEnding: Message = ['End of source', '原文末尾', '原文末尾'];
export const msg_sourceFailed: Message = [
  'Could not load this excerpt. Your current text is kept.',
  '未能读取这一段，当前原文已保留。',
  '未能讀取這一段，目前原文已保留。',
];
export const msg_you: Message = ['You', '你', '你'];
export const msg_assistant: Message = ['Maka', 'Maka', 'Maka'];
export const msg_toolActivity: Message = ['Tool activity', '工具活动', '工具活動'];
export const msg_toolOutput: Message = ['Tool output', '工具输出', '工具輸出'];
export const msg_toolReportedError: Message = [
  'Tool reported an error',
  '工具报告错误',
  '工具回報錯誤',
];
export const msg_toolPending: Message = ['Awaiting tool result', '等待工具结果', '等待工具結果'];
export const msg_toolReturned: Message = ['Returned', '已返回结果', '已返回結果'];
export const msg_toolFailed: Message = ['Tool execution failed', '工具执行失败', '工具執行失敗'];
export const msg_toolUnknown: Message = ['Tool outcome is unknown', '工具结果未知', '工具結果未知'];
export const msg_toolRejected: Message = ['Not executed', '未执行', '未執行'];
export const msg_toolDispatched: Message = [
  'Dispatched · awaiting result',
  '已派发 · 等待结果',
  '已派發 · 等待結果',
];
export const msg_toolDispatchedMissing: Message = [
  'Dispatched · no recorded result',
  '已派发 · 未记录结果',
  '已派發 · 未記錄結果',
];
export const msg_toolMissing: Message = ['No recorded result', '未记录结果', '未記錄結果'];
export const msg_toolNoText: Message = ['No text summary', '无文本摘要', '無文字摘要'];
export const msg_expandTool: Message = ['Show details', '展开详情', '展開詳情'];
export const msg_collapseTool: Message = ['Hide details', '收起详情', '收起詳情'];
export const msg_working: Message = ['Working…', '正在处理…', '正在處理…'];
export const msg_waiting: Message = ['Waiting for your input', '等待你的输入', '等待你的輸入'];
export const msg_stopping: Message = ['Stopping…', '正在停止…', '正在停止…'];
export const msg_unknown: Message = [
  'The result is not yet known. Your message has been kept.',
  '结果暂未确认，消息已保留。',
  '結果暫未確認，訊息已保留。',
];
export const msg_check: Message = ['Check result', '查询结果', '查詢結果'];
export const msg_unavailable: Message = [
  'Could not load the conversation.',
  '无法加载对话。',
  '無法載入對話。',
];
export const msg_createRejected: Message = [
  'Could not create a conversation.',
  '无法创建对话。',
  '無法建立對話。',
];

export const msg_empty: Message = ['Write a message first.', '请先输入消息。', '請先輸入訊息。'];
export const msg_draftKept: Message = [
  'A newer draft was kept.',
  '已保留后来编辑的草稿。',
  '已保留後來編輯的草稿。',
];
export const msg_skillInputUnavailable: Message = [
  'Requested skills are unavailable. Check the skill library or edit the /skill: references. Your draft was kept.',
  '请求的技能不可用。请检查技能库或修改 /skill: 引用；草稿已保留。',
  '請求的技能不可用。請檢查技能庫或修改 /skill: 引用；草稿已保留。',
];
export const msg_draftRestoring: Message = ['Restoring draft…', '正在恢复草稿…', '正在恢復草稿…'];
export const msg_draftPersistenceFailed: Message = [
  'Draft could not be saved or restored. Its existing contents are preserved.',
  '草稿无法保存或恢复，已有内容仍保留。',
  '草稿無法儲存或恢復，既有內容仍保留。',
];
export const msg_draftUncertain: Message = [
  'A previous send is unresolved. Check its result before restoring this draft.',
  '上次发送结果未知，请先查询结果再恢复草稿。',
  '上次傳送結果未知，請先查詢結果再恢復草稿。',
];
export const msg_draftCapacity: Message = [
  '32 drafts are open. Send or clear an existing draft before opening another.',
  '已保留 32 份草稿。请先发送或清空一份已有草稿，再打开新草稿。',
  '已保留 32 份草稿。請先傳送或清空一份已有草稿，再開啟新草稿。',
];
export const msg_completed: Message = ['Finished', '已完成', '已完成'];
export const msg_failed: Message = [
  'The response was interrupted.',
  '回复已中断。',
  '回覆已中斷。',
];
export const msg_enterHint: Message = [
  '⌘/Ctrl+Enter to send · Enter for a new line',
  '⌘/Ctrl+Enter 发送 · Enter 换行',
  '⌘/Ctrl+Enter 傳送 · Enter 換行',
];

export const msg_toggleSidebar: Message = ['Toggle sidebar', '切换侧栏', '切換側欄'];
export const msg_showSidebar: Message = ['Show sidebar', '显示侧栏', '顯示側欄'];
export const msg_hideSidebar: Message = ['Hide sidebar', '收起侧栏', '收起側欄'];
export const msg_connecting: Message = ['Connecting…', '正在连接…', '正在連線…'];

export const msg_diagnosticsConversation: Message = ['Conversation', '对话', '對話'];
export const msg_hostLogsLabel: Message = ['Host logs', 'Host 日志', 'Host 日誌'];
export const msg_hostLogsMissing: Message = [
  'Host log capture file is currently missing.',
  '当前没有 Host 日志捕获文件。',
  '目前沒有 Host 日誌擷取檔案。',
];
export const msg_hostLogsOmitted: Message = [
  'Earlier log bytes omitted.',
  '已省略较早的日志。',
  '已省略較早的日誌。',
];
export const msg_hostLogsReplaced: Message = [
  'Log file replaced; showing the new file.',
  '日志文件已替换，正在显示新文件。',
  '日誌檔案已替換，正在顯示新檔案。',
];
export const msg_hostLogsTruncated: Message = [
  'Log file truncated; showing the current tail.',
  '日志文件已截断，正在显示当前末尾。',
  '日誌檔案已截斷，正在顯示目前末尾。',
];
export const msg_hostLogsFollow: Message = ['Follow', '跟随', '跟隨'];
