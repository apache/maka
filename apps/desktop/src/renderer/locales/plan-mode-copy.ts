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

import type { PlanExecutionStep, PlanProposal } from '@maka/core/plan';
import { lookupCopy, type UiCatalog, type UiLocale } from '@maka/core/ui-locale';
import type { PlanControlErrorCode } from '@maka/runtime-host/protocol';
import type { PlanControlIpcResult } from '../../shared/plan-mode-ipc.js';

export type { PlanControlErrorCode, PlanControlIpcResult };

export interface PlanModeCopy {
  readonly operationFailed: string;
  /** Actionable copy for the structured `plan.control` / `plan.turn.start`
   * rejection codes; anything else keeps `operationFailed`. */
  readonly controlFailure: Record<PlanControlErrorCode, string>;
  readonly abandonConfirmation: {
    readonly title: string;
    description(title: string): string;
    readonly confirm: string;
    readonly cancel: string;
  };
  readonly proposal: {
    readonly aria: string;
    readonly kicker: string;
    readonly revision: string;
    readonly steps: string;
    readonly risks: string;
    readonly revise: string;
    readonly execute: string;
    readonly statuses: Record<PlanProposal['status'], string>;
  };
  readonly execution: {
    readonly aria: string;
    readonly interrupted: string;
    readonly running: string;
    readonly approvedPlan: string;
    stepCount(completed: number, total: number): string;
    readonly resume: string;
    readonly abandon: string;
    readonly stepStatuses: Record<PlanExecutionStep['status'], string>;
  };
}

const COPY = {
  'zh-CN': {
    operationFailed: '计划操作失败，请稍后重试。',
    controlFailure: {
      not_found: '计划方案已不存在，请刷新后重试',
      session_busy: '当前任务正在运行，等结束后再切换计划',
      operation_conflict: '计划已发生变化，请刷新后重试',
      persistence_failed: '计划状态暂时无法保存，请稍后重试',
      host_not_ready: '模型服务尚未就绪，请稍后重试',
      unauthorized: '没有操作这个计划的权限',
      host_draining: '模型服务正在维护，请稍后重试',
      operation_unavailable: '计划服务暂时不可用，请稍后重试',
      session_archived: '会话已归档，不能修改计划',
      invalid_request: '计划操作无效，请刷新后重试',
      internal_failure: '计划操作失败，请稍后重试',
    },
    abandonConfirmation: {
      title: '放弃这个计划？',
      description: (title) => `“${title}”的执行记录会保留，但之后不能继续恢复。`,
      confirm: '放弃计划',
      cancel: '取消',
    },
    proposal: {
      aria: '计划方案', kicker: '计划方案', revision: '修订版', steps: '执行步骤',
      risks: '风险', revise: '继续修改', execute: '执行计划',
      statuses: { pending_approval: '等待确认', approved: '已批准', stale: '已过期' },
    },
    execution: {
      aria: '计划执行状态', interrupted: '计划已中断', running: '正在执行计划',
      approvedPlan: '已批准计划', stepCount: (completed, total) => `${completed}/${total} 步`,
      resume: '恢复执行', abandon: '放弃计划',
      stepStatuses: { pending: '未开始', in_progress: '正在执行', completed: '已完成', skipped: '已跳过' },
    },
  },
  'zh-TW': {
    operationFailed: '計劃操作失敗，請稍後重試。',
    controlFailure: {
      not_found: '計劃方案已不存在，請重新整理後重試',
      session_busy: '目前任務正在執行，等結束後再切換計劃',
      operation_conflict: '計劃已發生變化，請重新整理後重試',
      persistence_failed: '計劃狀態暫時無法儲存，請稍後重試',
      host_not_ready: '模型服務尚未就緒，請稍後重試',
      host_draining: '模型服務正在維護，請稍後重試',
      unauthorized: '沒有操作這個計劃的權限',
      operation_unavailable: '計劃服務暫時無法使用，請稍後重試',
      session_archived: '會話已封存，不能修改計劃',
      invalid_request: '計劃操作無效，請重新整理後重試',
      internal_failure: '計劃操作失敗，請稍後重試',
    },
    abandonConfirmation: {
      title: '放棄這個計劃？',
      description: (title) => `“${title}”的執行記錄會保留，但之後不能繼續恢復。`,
      confirm: '放棄計劃',
      cancel: '取消',
    },
    proposal: {
      aria: '計劃方案', kicker: '計劃方案', revision: '修訂版', steps: '執行步驟',
      risks: '風險', revise: '繼續修改', execute: '執行計劃',
      statuses: { pending_approval: '等待確認', approved: '已批准', stale: '已過期' },
    },
    execution: {
      aria: '計劃執行狀態', interrupted: '計劃已中斷', running: '正在執行計劃',
      approvedPlan: '已批准計劃', stepCount: (completed, total) => `${completed}/${total} 步`,
      resume: '恢復執行', abandon: '放棄計劃',
      stepStatuses: { pending: '未開始', in_progress: '正在執行', completed: '已完成', skipped: '已跳過' },
    },
  },
  en: {
    operationFailed: 'The plan action failed. Try again later.',
    controlFailure: {
      not_found: 'This plan proposal no longer exists. Refresh and try again.',
      session_busy: 'A task is running in this Session. Wait for it to finish before changing the plan.',
      operation_conflict: 'The plan changed. Refresh and try again.',
      persistence_failed: 'The plan state could not be saved. Try again later.',
      host_not_ready: 'The model service is not ready yet. Try again later.',
      host_draining: 'The model service is under maintenance. Try again later.',
      operation_unavailable: 'The plan service is temporarily unavailable. Try again later.',
      unauthorized: 'This connection is not authorized to change the plan.',
      session_archived: 'This Session is archived; its plan cannot change.',
      invalid_request: 'This plan action is invalid. Refresh and try again.',
      internal_failure: 'The plan action failed. Try again later.',
    },
    abandonConfirmation: {
      title: 'Abandon this plan?',
      description: (title) => `The execution record for “${title}” will remain, but it cannot be resumed.`,
      confirm: 'Abandon plan',
      cancel: 'Cancel',
    },
    proposal: {
      aria: 'Plan proposal', kicker: 'Plan proposal', revision: 'Revision', steps: 'Steps',
      risks: 'Risks', revise: 'Request changes', execute: 'Execute plan',
      statuses: { pending_approval: 'Waiting for approval', approved: 'Approved', stale: 'Outdated' },
    },
    execution: {
      aria: 'Plan execution status', interrupted: 'Plan interrupted', running: 'Executing plan',
      approvedPlan: 'Approved plan',
      stepCount: (completed, total) => `${completed}/${total} ${total === 1 ? 'step' : 'steps'}`,
      resume: 'Resume', abandon: 'Abandon plan',
      stepStatuses: { pending: 'Not started', in_progress: 'In progress', completed: 'Completed', skipped: 'Skipped' },
    },
  },
  ko: {
    abandonConfirmation: {
      title: 'Abandon this plan?',
      description: (title) => `The execution record for “${title}” will remain, but it cannot be resumed.`,
      confirm: 'Abandon plan',
      cancel: 'Cancel',
    },
    proposal: {
      aria: 'Plan proposal', kicker: 'Plan proposal', revision: 'Revision', steps: 'Steps',
      risks: 'Risks', revise: 'Request changes', execute: 'Execute plan',
      statuses: { pending_approval: 'Waiting for approval', approved: 'Approved', stale: 'Outdated' },
    },
    execution: {
      aria: 'Plan execution status', interrupted: 'Plan interrupted', running: 'Executing plan',
      approvedPlan: 'Approved plan',
      stepCount: (completed, total) => `${completed}/${total} ${total === 1 ? 'step' : 'steps'}`,
      resume: 'Resume', abandon: 'Abandon plan',
      stepStatuses: { pending: 'Not started', in_progress: 'In progress', completed: 'Completed', skipped: 'Skipped' },
    },
  }
} satisfies UiCatalog<PlanModeCopy>;

export function getPlanModeCopy(locale: UiLocale): PlanModeCopy {
  return COPY[locale];
}

/** Lives in the copy catalog because a validated catalog's bare package
 * imports are exempt from the dependency-debt ratchet. */
export function planControlFailureCopy(
  error: Extract<PlanControlIpcResult<unknown>, { ok: false }>['error'],
  copy: PlanModeCopy,
): string {
  return lookupCopy(copy.controlFailure, error.code) ?? copy.operationFailed;
}
