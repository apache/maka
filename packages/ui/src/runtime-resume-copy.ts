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

/**
 * Park reasons are locale-independent wire tokens; this record only supplies
 * their presentation copy. `resume_candidate_missing` is not a parked-reason
 * entry — it takes its own title/description pair below.
 */
interface ResumeParkReasonCopy {
  dangling_tool_state: string;
  pending_permission: string;
  background_operation_pending: string;
  workspace_identity_mismatch: string;
  workspace_identity_missing: string;
  workspace_cwd_mismatch: string;
  workspace_ref_missing: string;
  tool_catalog_mismatch: string;
  checkpoint_restore_failed: string;
  source_run_unreadable: string;
  runtime_ledger_unreadable: string;
  runtime_ledger_empty: string;
  terminal_repair_failed: string;
  provider_resume_head_unsupported: string;
  provider_resume_boundary_unsupported: string;
  provider_replay_non_suffix_gap: string;
  provider_replay_unsupported: string;
  runtime_lineage_cycle: string;
  runtime_lineage_depth_exceeded: string;
  runtime_lineage_missing: string;
  runtime_lineage_start_mismatch: string;
  runtime_lineage_replay_mismatch: string;
  runtime_lineage_claim_mismatch: string;
  source_prefix_digest_mismatch: string;
  continuation_already_exists: string;
  continuation_claim_repair_required: string;
  continuation_started_indeterminate: string;
  continuation_authority_unavailable: string;
  resume_feature_disabled: string;
}

interface ResumeParkCopy {
  title: string;
  fallbackDescription: string;
  missingCandidateTitle: string;
  missingCandidateDescription: string;
  reasons: ResumeParkReasonCopy;
}

const RESUME_PARK_COPY_BASE = {
  zh: {
    title: '暂时无法继续这一轮',
    fallbackDescription: '当前任务不满足继续的条件。',
    missingCandidateTitle: '没有可恢复的任务',
    missingCandidateDescription: '任务已是最新状态。',
    reasons: {
      dangling_tool_state: '上次工具执行中断，记录已保留，暂时不能自动继续。',
      pending_permission: '上次执行仍在等待权限确认。',
      background_operation_pending: '仍有后台操作没有结束，暂时不能继续。',
      workspace_identity_mismatch: '当前工作区与中断时不一致。',
      workspace_identity_missing: '无法确认中断时的工作区。',
      workspace_cwd_mismatch: '当前工作目录与中断时不一致。',
      workspace_ref_missing: '中断时的工作区已不可用。',
      tool_catalog_mismatch: '可用工具已发生变化，无法安全继续。',
      checkpoint_restore_failed: '工作区检查点恢复失败。',
      source_run_unreadable: '上次运行记录无法完整读取。',
      runtime_ledger_unreadable: '上次运行账本无法完整读取。',
      runtime_ledger_empty: '上次运行没有可回放的记录。',
      terminal_repair_failed: '上次运行记录修复失败。',
      provider_resume_head_unsupported: '当前模型不支持这个恢复起点。',
      provider_resume_boundary_unsupported: '当前模型不支持这个恢复边界。',
      provider_replay_non_suffix_gap: '上次模型输出的中断位置无法安全裁剪。',
      provider_replay_unsupported: '上次运行历史无法按当前模型协议安全回放。',
      runtime_lineage_cycle: '续跑链存在循环引用，已停止恢复。',
      runtime_lineage_depth_exceeded: '续跑链过长，已停止自动恢复。',
      runtime_lineage_missing: '续跑链缺少必要的历史记录。',
      runtime_lineage_start_mismatch: '续跑链的起点记录不一致，已停止恢复。',
      runtime_lineage_replay_mismatch: '续跑链记录的模型上下文与当前重建结果不一致。',
      runtime_lineage_claim_mismatch: '续跑链缺少匹配的恢复所有权记录，已停止恢复。',
      source_prefix_digest_mismatch: '上次运行的不可变边界已发生变化。',
      continuation_already_exists: '该中断任务已经创建过续跑。',
      continuation_claim_repair_required: '恢复所有权已保留，但续跑记录需要先修复。',
      continuation_started_indeterminate: '续跑已经开始，但尚未形成可证明的终态。',
      continuation_authority_unavailable: '当前存储不支持安全的续跑所有权。',
      resume_feature_disabled: '继续中断任务的功能尚未启用。',
    },
  },
  en: {
    title: 'This round cannot be resumed yet',
    fallbackDescription: 'This task does not currently meet the conditions to continue.',
    missingCandidateTitle: 'Nothing to resume',
    missingCandidateDescription: 'This task is already up to date.',
    reasons: {
      dangling_tool_state:
        'The previous tool run was interrupted; its records are preserved, so it cannot continue automatically yet.',
      pending_permission: 'The previous run is still waiting for a permission approval.',
      background_operation_pending: 'Background operations are still running, so this round cannot continue yet.',
      workspace_identity_mismatch: 'The current workspace does not match the one from the interrupted run.',
      workspace_identity_missing: 'The workspace from the interrupted run could not be identified.',
      workspace_cwd_mismatch: 'The current working directory does not match the one from the interrupted run.',
      workspace_ref_missing: 'The workspace from the interrupted run is no longer available.',
      tool_catalog_mismatch: 'The available tools have changed, so it is not safe to continue.',
      checkpoint_restore_failed: 'Restoring the workspace checkpoint failed.',
      source_run_unreadable: "The previous run's record could not be read in full.",
      runtime_ledger_unreadable: "The previous run's ledger could not be read in full.",
      runtime_ledger_empty: 'The previous run has no records to replay.',
      terminal_repair_failed: "Repairing the previous run's record failed.",
      provider_resume_head_unsupported: 'The current model does not support this resume point.',
      provider_resume_boundary_unsupported: 'The current model does not support this resume boundary.',
      provider_replay_non_suffix_gap: 'The interruption point in the previous model output cannot be trimmed safely.',
      provider_replay_unsupported:
        "The previous run's history cannot be replayed safely under the current model protocol.",
      runtime_lineage_cycle: 'The resume chain contains a cycle; resuming was stopped.',
      runtime_lineage_depth_exceeded: 'The resume chain is too long; automatic resuming was stopped.',
      runtime_lineage_missing: 'The resume chain is missing required history records.',
      runtime_lineage_start_mismatch: "The resume chain's starting record is inconsistent; resuming was stopped.",
      runtime_lineage_replay_mismatch:
        "The resume chain's recorded model context does not match what was rebuilt here.",
      runtime_lineage_claim_mismatch:
        'The resume chain lacks a matching resume-ownership record; resuming was stopped.',
      source_prefix_digest_mismatch: "The previous run's immutable boundary has changed.",
      continuation_already_exists: 'A continuation for this interrupted task already exists.',
      continuation_claim_repair_required:
        'Resume ownership was preserved, but the continuation record needs repair first.',
      continuation_started_indeterminate:
        'The continuation already started, but has not reached a provable terminal state.',
      continuation_authority_unavailable: 'The current storage does not support safe resume ownership.',
      resume_feature_disabled: 'Resuming interrupted tasks is not enabled.',
    },
  },
  ko: {
    title: '현재 이 작업을 계속할 수 없습니다',
    fallbackDescription: '이 작업은 계속하기 위한 조건을 충족하지 않습니다.',
    missingCandidateTitle: '복구할 작업이 없습니다',
    missingCandidateDescription: '작업이 이미 최신 상태입니다.',
    reasons: {
      dangling_tool_state: '도구 상태가 완료되지 않았습니다.', pending_permission: '대기 중인 권한 요청이 있습니다.', background_operation_pending: '백그라운드 작업이 아직 진행 중입니다.', workspace_identity_mismatch: '작업 공간 ID가 일치하지 않습니다.',
      workspace_identity_missing: '중단된 실행의 작업 공간을 확인할 수 없습니다.', workspace_cwd_mismatch: '현재 작업 디렉터리가 중단 당시와 일치하지 않습니다.', workspace_ref_missing: '중단 당시 작업 공간을 더 이상 사용할 수 없습니다.', tool_catalog_mismatch: '사용 가능한 도구가 변경되어 안전하게 계속할 수 없습니다.', checkpoint_restore_failed: '작업 공간 체크포인트를 복원하지 못했습니다.', source_run_unreadable: '이전 실행 기록을 완전히 읽을 수 없습니다.', runtime_ledger_unreadable: '이전 실행 원장을 완전히 읽을 수 없습니다.', runtime_ledger_empty: '이전 실행에 재생할 기록이 없습니다.', terminal_repair_failed: '이전 실행 기록을 복구하지 못했습니다.', provider_resume_head_unsupported: '현재 모델은 이 복구 지점을 지원하지 않습니다.', provider_resume_boundary_unsupported: '현재 모델은 이 복구 경계를 지원하지 않습니다.', provider_replay_non_suffix_gap: '이전 모델 출력의 중단 지점을 안전하게 잘라낼 수 없습니다.', provider_replay_unsupported: '현재 모델 프로토콜에서 이전 실행 기록을 안전하게 재생할 수 없습니다.', runtime_lineage_cycle: '복구 체인에 순환 참조가 있어 복구를 중지했습니다.', runtime_lineage_depth_exceeded: '복구 체인이 너무 길어 자동 복구를 중지했습니다.', runtime_lineage_missing: '복구 체인에 필요한 기록이 없습니다.', runtime_lineage_start_mismatch: '복구 체인의 시작 기록이 일치하지 않습니다.', runtime_lineage_replay_mismatch: '복구 체인의 모델 컨텍스트가 현재 재구성 결과와 일치하지 않습니다.',
      runtime_lineage_claim_mismatch: '복구 소유권 기록이 일치하지 않습니다.', source_prefix_digest_mismatch: '이전 실행의 변경 불가 경계가 변경되었습니다.', continuation_already_exists: '이 중단된 작업에 대한 계속 실행이 이미 있습니다.', continuation_claim_repair_required: '계속 실행 기록을 먼저 복구해야 합니다.', continuation_started_indeterminate: '계속 실행이 시작되었지만 종료 상태를 확인할 수 없습니다.', continuation_authority_unavailable: '현재 저장소는 안전한 계속 실행 소유권을 지원하지 않습니다.', resume_feature_disabled: '중단된 작업 계속 실행이 활성화되지 않았습니다.',
    },
  },
};

const RESUME_PARK_COPY = RESUME_PARK_COPY_BASE satisfies UiCatalog<ResumeParkCopy>;

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
