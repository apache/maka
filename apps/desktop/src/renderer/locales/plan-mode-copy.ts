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
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface PlanModeCopy {
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
  zh: {
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
  en: {
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
    title: '이 계획을 포기하시겠습니까?',
    description: title => '“' + title + '”의 실행 기록은 유지되지만 다시 시작할 수 없습니다.',
    confirm: '계획 포기',
    cancel: '취소'
  },
  proposal: {
    ...{
      aria: "계획 제안",
      kicker: "계획 제안",
      revision: "개정",
      steps: "단계",
      risks: "위험",
      revise: "변경 요청",
      execute: "계획 실행",
      statuses: {
        pending_approval: "승인을 기다리는 중",
        approved: "승인됨",
        stale: "구식"
      }
    },
    aria: '계획 제안',
    kicker: '계획 제안',
    revision: '수정본',
    steps: '단계',
    risks: '위험',
    revise: '변경 요청',
    execute: '계획 실행',
    statuses: {
      pending_approval: '승인 대기 중',
      approved: '승인됨',
      stale: '오래됨'
    }
  },
  execution: {
    ...{
      aria: "계획 실행 현황",
      interrupted: "계획이 중단되었습니다",
      running: "계획 실행",
      approvedPlan: "승인된 계획",
      stepCount: (completed, total) => `${completed}/${total} ${total === 1 ? 'step' : 'steps'}`,
      resume: "재개하다",
      abandon: "계획 포기",
      stepStatuses: {
        pending: "시작되지 않음",
        in_progress: "진행중",
        completed: "완전한",
        skipped: "건너뛰었습니다."
      }
    },
    aria: '계획 실행 상태',
    interrupted: '계획 중단됨',
    running: '계획 실행 중',
    approvedPlan: '승인된 계획',
    stepCount: (completed, total) => completed + '/' + total + '단계',
    resume: '실행 재개',
    abandon: '계획 포기',
    stepStatuses: {
      pending: '시작되지 않음',
      in_progress: '진행 중',
      completed: '완료',
      skipped: '건너뜀'
    }
  }
}
} satisfies UiCatalog<PlanModeCopy>;

export function getPlanModeCopy(locale: UiLocale): PlanModeCopy {
  return COPY[locale];
}
