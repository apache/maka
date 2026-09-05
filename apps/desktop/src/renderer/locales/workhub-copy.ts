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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface WorkHubCopy {
  readonly locale: UiLocale;
  readonly subtitle: string;
  readonly emptyTitle: string;
  emptyBody(count: number): string;
  workCount(count: number): string;
  readonly clarification: string;
  readonly chooseWork: string;
  readonly confirmCommand: string;
  readonly stopTargetRequired: string;
  readonly stopTargetAmbiguous: string;
  readonly stopTargetUnavailable: string;
  readonly discussionStayed: string;
  readonly discussionHint: string;
  readonly answering: string;
  choseWork(name: string): string;
  readonly sentTo: string;
  readonly createdWork: string;
  readonly accepted: string;
  readonly sessionFallback: string;
  readonly newSessionFallbackTitle: string;
  readonly stoppingWork: string;
  readonly stopping: string;
  readonly stopRecorded: string;
  readonly openSessionToStop: string;
  readonly stopOutcomes: Record<
    'cancelled_pending' | 'stop_delivered' | 'already_terminal' | 'not_owned',
    string
  >;
  readonly waitingForDecision: string;
  readonly requestNotSent: string;
  readonly waitingSummary: string;
  readonly routing: string;
  readonly loadFailed: string;
  readonly loading: string;
  readonly preparing: string;
  readonly unavailable: string;
  readonly coordinationFailedTitle: string;
  readonly coordinationFailedBody: string;
  readonly retry: string;
  readonly submitFailures: Record<
    'candidates_changed' | 'linked_correction_unavailable' | 'target_waiting' | 'action_changed' | 'delivery_failed',
    string
  >;
  readonly scrollToBottom: string;
  readonly archived: string;
  readonly states: Record<'active' | 'running' | 'waiting_for_user' | 'blocked' | 'aborted', string>;
  readonly delegationStates: Record<
    'accepted' | 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'aborted' | 'recovering',
    string
  >;
  readonly assignmentLinkStates: {
    active(execution: string): string;
    readonly superseded: string;
    readonly aborted: string;
    readonly stopped: string;
  };
  readonly turnStates: Record<'running' | 'completed' | 'aborted' | 'failed', string>;
}

const WORKHUB_COPY = {
  'zh-CN': {
    locale: 'zh-CN',
    subtitle: '在一个入口里继续、创建和查看普通 Session',
    emptyTitle: '从这里继续所有工作',
    emptyBody: (count: number) => count > 0
      ? `WorkHub 会根据已有 ${count} 个 Session 判断目标；不确定时会先询问你。`
      : '提出一个明确目标，WorkHub 会创建普通 Session 并把结果带回这里。',
    workCount: (count: number) => `${count} 项工作`, clarification: '选择工作',
    chooseWork: '这条输入可能与多项工作有关，请选择目标：',
    confirmCommand: '没有开始新工作。如果需要我直接执行，请给出明确指令，例如“修复登录”。',
    stopTargetRequired: '请明确说出要停止的工作名称，例如“停止 支付任务”。',
    stopTargetAmbiguous: '这个名称对应多项工作；请打开具体的 Session 停止对应委托。',
    stopTargetUnavailable: '这项工作现在没有可以停止的单个 WorkHub 委托；请打开该 Session 查看。',
    discussionStayed: '这条内容暂时保留在 WorkHub，没有创建或改动 Session。',
    discussionHint: '提出明确的执行目标后，我会把它交给对应的 Session。',
    answering: '正在回答…',
    choseWork: (name: string) => `选择“${name}”`,
    sentTo: '已交给：', createdWork: '已创建新工作：', accepted: '已接收', sessionFallback: '普通 Session',
    newSessionFallbackTitle: '新工作',
    stoppingWork: '正在请求停止：', stopping: '正在处理', stopRecorded: '结果已记录',
    openSessionToStop: '这个 Turn 不由该委托独占；请打开 Session 处理',
    stopOutcomes: {
      cancelled_pending: '已取消尚未开始的工作：',
      stop_delivered: '已向运行中的工作发出停止请求：',
      already_terminal: '这项工作已经结束：',
      not_owned: '未停止共享或用户拥有的 Turn：',
    },
    waitingForDecision: '这项工作正在等待你的决定。',
    requestNotSent: '新请求尚未发送；处理原 Session 中的交互后可以再次发送。',
    waitingSummary: '这项工作正在等待你的决定。 新请求尚未发送；处理原 Session 中的交互后可以再次发送。',
    routing: '正在判断应该交给哪个 Session…', loadFailed: '无法读取已有工作。',
    loading: '正在读取已有工作…',
    preparing: '正在准备 WorkHub…', unavailable: '暂不可用',
    coordinationFailedTitle: 'WorkHub 暂时无法启动',
    coordinationFailedBody: '请检查当前 Runtime Host 的默认模型配置，然后重试。',
    retry: '重试',
    submitFailures: {
      candidates_changed: '工作列表已变化，请重新发送以使用最新目标。',
      linked_correction_unavailable: '找不到可更正的有效委托关联；请重新发送，或打开原 Session 确认当前工作。',
      target_waiting: '目标 Session 正在等待你的处理；请先打开并完成该交互。',
      action_changed: '这次操作已发生变化，请重新发送。',
      delivery_failed: '输入未能送达，请重试。',
    }, scrollToBottom: '滚动到底部', archived: '已归档',
    states: { active: '活跃', running: '进行中', waiting_for_user: '等待你', blocked: '受阻', aborted: '已中止' },
    delegationStates: {
      accepted: '已接收',
      running: '进行中',
      waiting_for_user: '等待你',
      completed: '已完成',
      failed: '失败',
      aborted: '已中止',
      recovering: '正在恢复',
    },
    assignmentLinkStates: {
      active: (execution: string) => `关联有效 · ${execution}`,
      superseded: '已被更正',
      aborted: '更正已中止',
      stopped: '已停止关联',
    },
    turnStates: { running: '进行中', completed: '已完成', aborted: '已中止', failed: '失败' },
  },
  'zh-TW': {
    locale: 'zh-TW',
    subtitle: '在一個入口繼續、建立和檢視一般 Session',
    emptyTitle: '從這裡繼續所有工作',
    emptyBody: (count: number) => count > 0
      ? `WorkHub 會根據現有 ${count} 個 Session 判斷目標；不確定時會先詢問你。`
      : '提出一個明確目標，WorkHub 會建立一般 Session 並將結果帶回這裡。',
    workCount: (count: number) => `${count} 項工作`, clarification: '選擇工作',
    chooseWork: '這則輸入可能與多項工作有關，請選擇目標：',
    confirmCommand: '沒有開始新工作。如果需要我直接執行，請給出明確指令，例如「修復登入」。',
    stopTargetRequired: '請明確說出要停止的工作名稱，例如「停止 支付任務」。',
    stopTargetAmbiguous: '這個名稱對應多項工作；請開啟具體的 Session 停止對應委派。',
    stopTargetUnavailable: '這項工作現在沒有可以停止的單一 WorkHub 委派；請開啟該 Session 檢視。',
    discussionStayed: '這則內容暫時保留在 WorkHub，沒有建立或變更 Session。',
    discussionHint: '提出明確的執行目標後，我會將它交給對應的 Session。',
    answering: '正在回答…',
    choseWork: (name: string) => `選擇「${name}」`,
    sentTo: '已交給：', createdWork: '已建立新工作：', accepted: '已接收', sessionFallback: '一般 Session',
    newSessionFallbackTitle: '新工作',
    stoppingWork: '正在請求停止：', stopping: '正在處理', stopRecorded: '結果已記錄',
    openSessionToStop: '這個 Turn 不由該委派獨佔；請開啟 Session 處理',
    stopOutcomes: {
      cancelled_pending: '已取消尚未開始的工作：',
      stop_delivered: '已向執行中的工作發出停止請求：',
      already_terminal: '這項工作已經結束：',
      not_owned: '未停止共享或使用者擁有的 Turn：',
    },
    waitingForDecision: '這項工作正在等待你的決定。',
    requestNotSent: '新請求尚未傳送；處理原 Session 中的互動後可以再次傳送。',
    waitingSummary: '這項工作正在等待你的決定。 新請求尚未傳送；處理原 Session 中的互動後可以再次傳送。',
    routing: '正在判斷應該交給哪個 Session…', loadFailed: '無法讀取現有工作。',
    loading: '正在讀取現有工作…',
    preparing: '正在準備 WorkHub…', unavailable: '暫時無法使用',
    coordinationFailedTitle: 'WorkHub 暫時無法啟動',
    coordinationFailedBody: '請檢查目前 Runtime Host 的預設模型設定，然後重試。',
    retry: '重試',
    submitFailures: {
      candidates_changed: '工作清單已變更，請重新傳送以使用最新目標。',
      linked_correction_unavailable: '找不到可更正的有效委派關聯；請重新傳送，或開啟原 Session 確認目前工作。',
      target_waiting: '目標 Session 正在等待你的處理；請先開啟並完成該互動。',
      action_changed: '這次操作已變更，請重新傳送。',
      delivery_failed: '輸入未能送達，請重試。',
    }, scrollToBottom: '捲動到底部', archived: '已封存',
    states: { active: '使用中', running: '進行中', waiting_for_user: '等待你', blocked: '受阻', aborted: '已中止' },
    delegationStates: {
      accepted: '已接收',
      running: '進行中',
      waiting_for_user: '等待你',
      completed: '已完成',
      failed: '失敗',
      aborted: '已中止',
      recovering: '正在恢復',
    },
    assignmentLinkStates: {
      active: (execution: string) => `關聯有效 · ${execution}`,
      superseded: '已被更正',
      aborted: '更正已中止',
      stopped: '已停止關聯',
    },
    turnStates: { running: '進行中', completed: '已完成', aborted: '已中止', failed: '失敗' },
  },
  en: {
    locale: 'en',
    subtitle: 'Continue, create, and review ordinary Sessions from one place',
    emptyTitle: 'Continue all work from here',
    emptyBody: (count: number) => count > 0
      ? `WorkHub routes against ${count} existing Session${count === 1 ? '' : 's'} and asks when the target is unclear.`
      : 'State a clear goal and WorkHub will create an ordinary Session and bring its result back here.',
    workCount: (count: number) => `${count} work item${count === 1 ? '' : 's'}`, clarification: 'Choose work',
    chooseWork: 'This input may relate to more than one task. Choose a target:',
    confirmCommand: 'I did not start new work. If you want me to do it, give a direct instruction, for example “Fix login”.',
    stopTargetRequired: 'Name the work explicitly, for example “Stop Payments”.',
    stopTargetAmbiguous:
      'That name matches more than one work item. Open the exact Session to stop its delegation.',
    stopTargetUnavailable:
      'This work has no single WorkHub delegation to stop right now. Open its Session to see what is running.',
    discussionStayed: 'This stayed in WorkHub without creating or changing a Session.',
    discussionHint: 'State an executable goal and I will hand it to the owning Session.',
    answering: 'Answering…',
    choseWork: (name: string) => `Choose “${name}”`,
    sentTo: 'Sent to:', createdWork: 'Created new work:', accepted: 'Accepted', sessionFallback: 'Ordinary Session',
    newSessionFallbackTitle: 'New work',
    stoppingWork: 'Requesting stop:', stopping: 'Stopping', stopRecorded: 'Result recorded',
    openSessionToStop: 'This Turn is shared or user-owned. Open the Session to stop it.',
    stopOutcomes: {
      cancelled_pending: 'Cancelled work that had not started:',
      stop_delivered: 'Asked the running work to stop:',
      already_terminal: 'This work had already ended:',
      not_owned: 'Did not stop a shared or user-owned Turn:',
    },
    waitingForDecision: 'This work is waiting for your decision.',
    requestNotSent: 'The new request was not sent. Resolve the interaction in its Session, then send again.',
    waitingSummary: 'This work is waiting for your decision. The new request was not sent. Resolve the interaction in its Session, then send again.',
    routing: 'Choosing the right Session…', loadFailed: 'Could not read existing work.',
    loading: 'Loading existing work…',
    preparing: 'Preparing WorkHub…', unavailable: 'Unavailable',
    coordinationFailedTitle: 'WorkHub could not start',
    coordinationFailedBody: 'Check the default model for the current Runtime Host, then retry.',
    retry: 'Retry',
    submitFailures: {
      candidates_changed: 'The work list changed. Send again to use the latest targets.',
      linked_correction_unavailable: 'No active delegation link is available to correct. Send again, or open the original Session to confirm its current work.',
      target_waiting: 'The target Session needs your input. Open it and resolve that interaction first.',
      action_changed: 'This action changed. Send it again.',
      delivery_failed: 'The input could not be delivered. Try again.',
    }, scrollToBottom: 'Scroll to bottom', archived: 'Archived',
    states: { active: 'Active', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Blocked', aborted: 'Aborted' },
    delegationStates: {
      accepted: 'Accepted',
      running: 'Running',
      waiting_for_user: 'Waiting for you',
      completed: 'Completed',
      failed: 'Failed',
      aborted: 'Aborted',
      recovering: 'Recovering',
    },
    assignmentLinkStates: {
      active: (execution: string) => `Active link · ${execution}`,
      superseded: 'Superseded link',
      aborted: 'Aborted replacement',
      stopped: 'Stopped link',
    },
    turnStates: { running: 'Running', completed: 'Completed', aborted: 'Aborted', failed: 'Failed' },
  },
} satisfies UiCatalog<WorkHubCopy>;

export function workHubAmbiguousCommandPrompt(locale: UiLocale): string {
  return WORKHUB_COPY[locale].confirmCommand;
}

export function getWorkHubCopy(locale: UiLocale): WorkHubCopy {
  return WORKHUB_COPY[locale];
}
