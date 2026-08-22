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

export interface ResumeParkToastCopy {
  title: string;
  description: string;
}

const RESUME_PARK_REASON_COPY: Readonly<Record<string, string>> = {
  dangling_tool_state: '上次工具执行中断，已安全保留记录，暂不能自动恢复。',
  pending_permission: '上次执行仍在等待权限确认。',
  background_operation_pending: '仍有后台操作未结束，暂不能安全恢复。',
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
  resume_feature_disabled: '安全恢复功能尚未启用。',
};

export function resumeParkToastCopy(reasons: readonly string[]): ResumeParkToastCopy {
  if (reasons.length === 1 && reasons[0] === 'resume_candidate_missing') {
    return {
      title: '没有可恢复的任务',
      description: '任务已是最新状态。',
    };
  }

  const descriptions = [...new Set(
    reasons
      .map((reason) => RESUME_PARK_REASON_COPY[reason])
      .filter((description): description is string => description !== undefined),
  )];

  return {
    title: '暂时无法安全恢复',
    description: descriptions.length > 0
      ? descriptions.join(' ')
      : '当前任务不满足安全恢复条件。',
  };
}
