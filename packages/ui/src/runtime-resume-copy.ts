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

import type { UiLocale } from '@maka/core/ui-locale';

export interface ResumeParkToastCopy {
  title: string;
  description: string;
}

interface ResumeParkCopyTable {
  readonly reasons: Readonly<Record<string, string>>;
  readonly resumeCandidateMissingTitle: string;
  readonly resumeCandidateMissingDescription: string;
  readonly title: string;
  readonly fallbackDescription: string;
}

const RESUME_PARK_COPY: Record<UiLocale, ResumeParkCopyTable> = {
  zh: {
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
    resumeCandidateMissingTitle: '没有可恢复的任务',
    resumeCandidateMissingDescription: '任务已是最新状态。',
    title: '暂时无法继续这一轮',
    fallbackDescription: '当前任务不满足继续的条件。',
  },
  en: {
    reasons: {
      dangling_tool_state: 'The last tool call was interrupted; its record is kept, so this turn cannot resume automatically yet.',
      pending_permission: 'The last run is still waiting for permission approval.',
      background_operation_pending: 'A background operation is still running, so this turn cannot continue yet.',
      workspace_identity_mismatch: 'The current workspace does not match the one that was interrupted.',
      workspace_identity_missing: 'The workspace from the interrupted run cannot be confirmed.',
      workspace_cwd_mismatch: 'The current working directory differs from the one that was interrupted.',
      workspace_ref_missing: 'The workspace from the interrupted run is no longer available.',
      tool_catalog_mismatch: 'The available tools have changed, so it is not safe to continue.',
      checkpoint_restore_failed: 'Failed to restore the workspace checkpoint.',
      source_run_unreadable: 'The last run record could not be read in full.',
      runtime_ledger_unreadable: 'The last run ledger could not be read in full.',
      runtime_ledger_empty: 'The last run has no records to replay.',
      terminal_repair_failed: 'Failed to repair the last run record.',
      provider_resume_head_unsupported: 'The current model does not support this resume point.',
      provider_resume_boundary_unsupported: 'The current model does not support this resume boundary.',
      provider_replay_non_suffix_gap: "The last model output can't be safely trimmed at the interruption point.",
      provider_replay_unsupported: "The last run's history can't be safely replayed under the current model protocol.",
      runtime_lineage_cycle: 'The resume chain has a circular reference, so recovery stopped.',
      runtime_lineage_depth_exceeded: 'The resume chain is too long, so automatic recovery stopped.',
      runtime_lineage_missing: 'The resume chain is missing required history.',
      runtime_lineage_start_mismatch: 'The resume chain start records disagree, so recovery stopped.',
      runtime_lineage_replay_mismatch: "The resume chain's recorded model context does not match the rebuilt result.",
      runtime_lineage_claim_mismatch: 'The resume chain has no matching recovery-ownership record, so recovery stopped.',
      source_prefix_digest_mismatch: "The last run's immutable boundary has changed.",
      continuation_already_exists: 'A continuation was already created for this interrupted task.',
      continuation_claim_repair_required: 'Recovery ownership is kept, but the continuation record needs repair first.',
      continuation_started_indeterminate: 'The continuation started but has no provable final state yet.',
      continuation_authority_unavailable: 'The current store does not support safe continuation ownership.',
      resume_feature_disabled: 'Resuming interrupted tasks is not enabled yet.',
    },
    resumeCandidateMissingTitle: 'Nothing to resume',
    resumeCandidateMissingDescription: 'This task is already up to date.',
    title: "This turn can't continue yet",
    fallbackDescription: 'This task does not currently meet the conditions to continue.',
  },
};

// Exported for tests so the locale tables cannot drift apart in key coverage.
export const RESUME_PARK_REASON_KEYS = [
  'dangling_tool_state',
  'pending_permission',
  'background_operation_pending',
  'workspace_identity_mismatch',
  'workspace_identity_missing',
  'workspace_cwd_mismatch',
  'workspace_ref_missing',
  'tool_catalog_mismatch',
  'checkpoint_restore_failed',
  'source_run_unreadable',
  'runtime_ledger_unreadable',
  'runtime_ledger_empty',
  'terminal_repair_failed',
  'provider_resume_head_unsupported',
  'provider_resume_boundary_unsupported',
  'provider_replay_non_suffix_gap',
  'provider_replay_unsupported',
  'runtime_lineage_cycle',
  'runtime_lineage_depth_exceeded',
  'runtime_lineage_missing',
  'runtime_lineage_start_mismatch',
  'runtime_lineage_replay_mismatch',
  'runtime_lineage_claim_mismatch',
  'source_prefix_digest_mismatch',
  'continuation_already_exists',
  'continuation_claim_repair_required',
  'continuation_started_indeterminate',
  'continuation_authority_unavailable',
  'resume_feature_disabled',
] as const;

export function resumeParkToastCopy(
  reasons: readonly string[],
  locale: UiLocale,
): ResumeParkToastCopy {
  const copy = RESUME_PARK_COPY[locale];
  if (reasons.length === 1 && reasons[0] === 'resume_candidate_missing') {
    return {
      title: copy.resumeCandidateMissingTitle,
      description: copy.resumeCandidateMissingDescription,
    };
  }

  const descriptions = [...new Set(
    reasons
      .map((reason) => copy.reasons[reason])
      .filter((description): description is string => description !== undefined),
  )];

  return {
    title: copy.title,
    description: descriptions.length > 0
      ? descriptions.join(' ')
      : copy.fallbackDescription,
  };
}
