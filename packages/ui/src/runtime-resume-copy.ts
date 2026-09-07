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

export interface ResumeParkToastCopy {
  title: string;
  description: string;
}

type ResumeParkReasonKey =
  | 'source_run_unreadable'
  | 'safety_check_failed'
  | 'continuation_already_exists'
  | 'continuation_repair_required'
  | 'continuation_started_indeterminate'
  | 'resume_feature_disabled'
  | 'continuation_authority_unavailable'
  | 'safety_observation_unavailable'
  | 'session_busy';

type ResumeParkReasonCopy = Record<ResumeParkReasonKey, string>;

interface ResumeParkCopy {
  title: string;
  fallbackDescription: string;
  missingCandidateTitle: string;
  missingCandidateDescription: string;
  reasons: ResumeParkReasonCopy;
}

const RESUME_PARK_COPY = {
  'zh-CN': {
    title: '暂时无法继续这一轮',
    fallbackDescription: '当前任务不满足继续的条件。',
    missingCandidateTitle: '没有可恢复的任务',
    missingCandidateDescription: '任务已是最新状态。',
    reasons: {
      source_run_unreadable: '上次运行记录无法完整读取。',
      safety_check_failed: '继续执行所需的安全检查未通过。',
      continuation_already_exists: '该中断任务已经创建过续跑。',
      continuation_repair_required: '恢复所有权已保留，但续跑记录需要先修复。',
      continuation_started_indeterminate: '续跑已经开始，但尚未形成可证明的终态。',
      resume_feature_disabled: '继续中断任务的功能尚未启用。',
      continuation_authority_unavailable: '当前存储不支持安全的续跑所有权。',
      safety_observation_unavailable: '无法获取继续执行所需的安全检查结果。',
      session_busy: '该会话已经有正在进行的一轮。',
    },
  },
  'zh-TW': {
    title: '暫時無法繼續這一輪',
    fallbackDescription: '目前任務不滿足繼續的條件。',
    missingCandidateTitle: '沒有可恢復的任務',
    missingCandidateDescription: '任務已是最新狀態。',
    reasons: {
      source_run_unreadable: '上次執行的記錄無法完整讀取。',
      safety_check_failed: '繼續執行所需的安全檢查未通過。',
      continuation_already_exists: '該中斷任務已經建立過續跑。',
      continuation_repair_required: '恢復所有權已保留，但續跑記錄需要先修復。',
      continuation_started_indeterminate: '續跑已經開始，但尚未形成可證明的終態。',
      resume_feature_disabled: '繼續中斷任務的功能尚未啟用。',
      continuation_authority_unavailable: '目前儲存不支援安全的續跑所有權。',
      safety_observation_unavailable: '無法取得繼續執行所需的安全檢查結果。',
      session_busy: '該工作階段已經有進行中的一輪。',
    },
  },
  en: {
    title: 'This round cannot be resumed yet',
    fallbackDescription: 'This task does not currently meet the conditions to continue.',
    missingCandidateTitle: 'Nothing to resume',
    missingCandidateDescription: 'This task is already up to date.',
    reasons: {
      source_run_unreadable: "The previous run's record could not be read in full.",
      safety_check_failed: 'The safety checks required to continue did not pass.',
      continuation_already_exists: 'A continuation for this interrupted task already exists.',
      continuation_repair_required:
        'Resume ownership was preserved, but the continuation record needs repair first.',
      continuation_started_indeterminate:
        'The continuation already started, but has not reached a provable terminal state.',
      resume_feature_disabled: 'Resuming interrupted tasks is not enabled.',
      continuation_authority_unavailable: 'The current storage does not support safe resume ownership.',
      safety_observation_unavailable: 'The safety check needed to continue could not be obtained.',
      session_busy: 'This session already has an active turn.',
    },
  },
} satisfies UiCatalog<ResumeParkCopy>;

export function resumeParkToastCopy(reasons: readonly string[], locale: UiLocale): ResumeParkToastCopy {
  const copy = RESUME_PARK_COPY[locale];
  if (reasons.length === 1 && reasons[0] === 'resume_candidate_missing') {
    return {
      title: copy.missingCandidateTitle,
      description: copy.missingCandidateDescription,
    };
  }

  const descriptions = [...new Set(
    reasons
      .map((reason) => copy.reasons[reason as keyof ResumeParkReasonCopy])
      .filter((description): description is string => description !== undefined),
  )];

  return {
    title: copy.title,
    description: descriptions.length > 0
      ? descriptions.join(' ')
      : copy.fallbackDescription,
  };
}
