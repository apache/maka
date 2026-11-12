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

// Generated from Rust runtime schemas. Run npm run schema:generate -w @maka-agent/plugin-sdk.
import type * as Runtime from './runtime.js';

/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentCheckpointReceiptInput_InstanceId = string[];
export type AgentCheckpointReceiptInput_Transport = 'local' | 'remote';
export type AgentCheckpointReceiptInput_RecoveryProtocol = 'journal_v1';
export type AgentCheckpointReceiptInput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentCheckpointReceiptOutput_InstanceId = string[];
export type AgentCheckpointReceiptOutput_Transport = 'local' | 'remote';
export type AgentCheckpointReceiptOutput_RecoveryProtocol = 'journal_v1';
/**
 * Unresolved and Unknown may advance to authoritative original evidence.
 * Returned and NotExecuted are immutable; handler errors are Returned too.
 */
export type AgentCheckpointReceiptOutput_OperationOutcome =
  | {
      kind: 'unresolved';
    }
  | {
      kind: 'returned';
      result: AgentCheckpointReceiptOutput_OperationResult;
    }
  | {
      kind: 'not_executed';
      proof: AgentCheckpointReceiptOutput_NotExecutedProof;
    }
  | {
      kind: 'unknown';
      diagnostic: string;
    };
/**
 * A definite handler return. Failure does not imply absence of side effects.
 */
export type AgentCheckpointReceiptOutput_OperationResult =
  | {
      kind: 'success';
      value: unknown;
    }
  | {
      kind: 'failure';
      diagnostic: string;
    };
/**
 * An observation of a provider fence, not a capability to create that fence.
 * Only the original provider may establish this proof before handler start.
 */
export type AgentCheckpointReceiptOutput_NotExecutedProof = {
  kind: 'provider_prevented_before_start';
};
export type AgentCheckpointReceiptOutput_OperationCleanup =
  | {
      kind: 'unconfirmed';
    }
  | {
      kind: 'confirmed';
    }
  | {
      kind: 'failed';
      diagnostic: string;
    };
export type AgentCheckpointReceiptOutput_AgentHistoryCheckpointState =
  | {
      kind: 'capturing';
    }
  | {
      kind: 'prepared';
    }
  | {
      kind: 'published';
      head: AgentCheckpointReceiptOutput_AgentHistoryCheckpointHead;
    }
  | {
      kind: 'conflict';
      actual?: string | null;
    }
  | {
      kind: 'interrupted';
    }
  | {
      kind: 'unavailable';
    };
export type AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
export type AgentCompactOutput_RunId = string;
export type AgentCompactOutput_AgentExecutionState =
  | {
      kind: 'admitted';
    }
  | {
      kind: 'running';
    }
  | {
      kind: 'waiting';
      waits: AgentCompactOutput_WaitReason[];
      authorityUnavailable: boolean;
    }
  | {
      kind: 'completed';
    }
  | {
      kind: 'failed';
      reason?: AgentCompactOutput_BlockerKind | null;
    }
  | {
      kind: 'cancelled';
    };
export type AgentCompactOutput_WaitReason =
  | {
      kind: 'cell';
      cell: AgentCompactOutput_CellId;
    }
  | {
      kind: 'external';
      task: AgentCompactOutput_ExternalTaskId;
    }
  | {
      kind: 'provider_backoff';
      attempt: AgentCompactOutput_ModelAttemptId;
    }
  | {
      kind: 'model';
      attempt: AgentCompactOutput_ModelAttemptId;
    }
  | {
      kind: 'approval';
      approval: AgentCompactOutput_ApprovalId;
    }
  | {
      kind: 'retry';
      attempt: AgentCompactOutput_ModelAttemptId;
    }
  | {
      kind: 'operation';
      tool: AgentCompactOutput_ToolKey;
    }
  | {
      kind: 'child';
      run: AgentCompactOutput_RunId;
    }
  | {
      kind: 'blocker';
      blocker: AgentCompactOutput_BlockerId;
    };
export type AgentCompactOutput_CellId = string;
export type AgentCompactOutput_ExternalTaskId = string;
export type AgentCompactOutput_ModelAttemptId = string;
export type AgentCompactOutput_ApprovalId = string;
export type AgentCompactOutput_BlockerId = string;
export type AgentCompactOutput_BlockerKind =
  | {
      kind: 'external_publication_unavailable';
      publication: AgentCompactOutput_ExternalPublicationId;
      diagnostic: string;
    }
  | {
      kind: 'external_publication_item';
      key: AgentCompactOutput_ExternalPublicationKey;
      reason: AgentCompactOutput_ExternalPublicationBlocker;
    }
  | {
      kind: 'current_authority_unavailable';
      stage: AgentCompactOutput_AuthorityStage;
      diagnostic: string;
    }
  | {
      kind: 'external_effect_unknown';
      task: AgentCompactOutput_ExternalTaskId;
      operation: string;
    }
  | {
      kind: 'operation_unknown';
      tool: AgentCompactOutput_ToolKey;
      reference: AgentCompactOutput_RecoveryRef;
    }
  | {
      kind: 'provider_effect_unknown';
      attempt: AgentCompactOutput_ModelAttemptId;
      call: string;
    }
  | {
      kind: 'original_admission_unknown';
      tool: AgentCompactOutput_ToolKey;
    }
  | {
      kind: 'code_cell_recovery_unavailable';
      cell: string;
    }
  | {
      kind: 'unsupported_protocol';
      protocol: string;
      version: number;
    }
  | {
      kind: 'tool_cleanup_unconfirmed';
      tool: AgentCompactOutput_ToolKey;
      diagnostic: string;
    }
  | {
      kind: 'model_cleanup_unconfirmed';
      attempt: AgentCompactOutput_ModelAttemptId;
      diagnostic: string;
    }
  | {
      kind: 'cleanup_unconfirmed';
      reference: AgentCompactOutput_RecoveryRef;
    }
  | {
      kind: 'resources_unavailable';
      tool: AgentCompactOutput_ToolKey;
    }
  | {
      kind: 'external_task_unobservable';
      descriptor: AgentCompactOutput_ContentRef;
    };
export type AgentCompactOutput_ExternalPublicationId = string;
export type AgentCompactOutput_ExternalPublicationBlocker =
  | 'unknown'
  | 'conflict'
  | 'unsupported'
  | 'failed'
  | 'not_attempted'
  | 'cleanup_unconfirmed';
export type AgentCompactOutput_AuthorityStage =
  | 'current_session'
  | 'workspace_scope'
  | 'tool_bindings'
  | 'backend_scope'
  | 'input_codec';
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentCompactOutput_InstanceId = string[];
export type AgentCompactOutput_Transport = 'local' | 'remote';
export type AgentCompactOutput_RecoveryProtocol = 'journal_v1';
export type AgentCompactOutput_AgentCompactRejection =
  | 'busy'
  | 'closed'
  | 'archived'
  | 'backend_unavailable'
  | 'workspace_changed';
export type AgentCreatePresetOutput_PresetRevision = number;
export type AgentCreatePresetOutput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentDeletePresetOutput_PresetRevision = number;
export type AgentDeletePresetOutput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentExternalUsageLimitsOutput_UsageLimit =
  | {
      kind: 'window';
      label?: string | null;
      period?: AgentExternalUsageLimitsOutput_UsagePeriod | null;
      /**
       * Reset time in Unix seconds.
       */
      resetsAt?: number | null;
      usedPercent: number;
      quantity?: AgentExternalUsageLimitsOutput_UsageQuantity | null;
    }
  | {
      kind: 'balance';
      label?: string | null;
      amount: number;
      unit?: string | null;
    }
  | {
      kind: 'unlimited';
      label?: string | null;
    }
  | {
      kind: 'disabled';
      label: string;
      period: AgentExternalUsageLimitsOutput_UsagePeriod;
    };
export type AgentExternalUsageLimitsOutput_UsagePeriod =
  | {
      kind: 'duration';
      seconds: number;
    }
  | {
      kind: 'monthly';
    };
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentHistoryCheckpointLoadReceiptInput_InstanceId = string[];
export type AgentHistoryCheckpointLoadReceiptInput_Transport = 'local' | 'remote';
export type AgentHistoryCheckpointLoadReceiptInput_RecoveryProtocol = 'journal_v1';
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentHistoryCheckpointLoadReceiptOutput_InstanceId = string[];
export type AgentHistoryCheckpointLoadReceiptOutput_Transport = 'local' | 'remote';
export type AgentHistoryCheckpointLoadReceiptOutput_RecoveryProtocol = 'journal_v1';
/**
 * Unresolved and Unknown may advance to authoritative original evidence.
 * Returned and NotExecuted are immutable; handler errors are Returned too.
 */
export type AgentHistoryCheckpointLoadReceiptOutput_OperationOutcome =
  | {
      kind: 'unresolved';
    }
  | {
      kind: 'returned';
      result: AgentHistoryCheckpointLoadReceiptOutput_OperationResult;
    }
  | {
      kind: 'not_executed';
      proof: AgentHistoryCheckpointLoadReceiptOutput_NotExecutedProof;
    }
  | {
      kind: 'unknown';
      diagnostic: string;
    };
/**
 * A definite handler return. Failure does not imply absence of side effects.
 */
export type AgentHistoryCheckpointLoadReceiptOutput_OperationResult =
  | {
      kind: 'success';
      value: unknown;
    }
  | {
      kind: 'failure';
      diagnostic: string;
    };
/**
 * An observation of a provider fence, not a capability to create that fence.
 * Only the original provider may establish this proof before handler start.
 */
export type AgentHistoryCheckpointLoadReceiptOutput_NotExecutedProof = {
  kind: 'provider_prevented_before_start';
};
export type AgentHistoryCheckpointLoadReceiptOutput_OperationCleanup =
  | {
      kind: 'unconfirmed';
    }
  | {
      kind: 'confirmed';
    }
  | {
      kind: 'failed';
      diagnostic: string;
    };
export type AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointLoadState =
  | {
      kind: 'preparing';
    }
  | {
      kind: 'ready';
      sessionIds: string[];
      workspace?: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceSnapshot | null;
    }
  | {
      kind: 'unavailable';
    };
export type AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
export type AgentHistoryRequestsInput_HistoryRowAddress = Runtime.HistoryRowAddress;
export type AgentHistoryRequestsOutput_StepId = string;
export type AgentHistoryRequestsOutput_ModelAttemptId = string;
export type AgentHistoryRequestsOutput_ModelPurpose = 'main' | 'summary';
export type AgentHistoryRequestsOutput_UsageOutcome = ('success' | 'error' | 'aborted') | 'unknown';
export type AgentLoadHistoryCheckpointOutput_AgentCheckpointLoadState =
  | {
      kind: 'preparing';
    }
  | {
      kind: 'ready';
      sessionIds: string[];
      workspace?: AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceSnapshot | null;
    }
  | {
      kind: 'unavailable';
    };
export type AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
export type AgentLoadedHistoryCheckpointArtifactInput_RunId = string;
export type AgentLoadedHistoryCheckpointArtifactsInput_RunId = string;
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type AgentLoadedHistoryCheckpointAttachmentImageInput_HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: AgentLoadedHistoryCheckpointAttachmentImageInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: AgentLoadedHistoryCheckpointAttachmentImageInput_RunId[];
      snapshot: string;
      sequence: number;
      fact: AgentLoadedHistoryCheckpointAttachmentImageInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: AgentLoadedHistoryCheckpointAttachmentImageInput_RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type AgentLoadedHistoryCheckpointAttachmentImageInput_FactId = string;
export type AgentLoadedHistoryCheckpointAttachmentImageInput_RunId = string;
/**
 * Row reveals an exact field; Before/After continue at byte boundaries and
 * Event addresses the raw event log. Returned chunks retain ascending presentation
 * order, including a reverse window.
 */
export type AgentLoadedHistoryCheckpointHistoryInput_HistoryPosition =
  | {
      kind: 'start';
    }
  | {
      kind: 'tail';
    }
  | {
      kind: 'row';
      position: AgentLoadedHistoryCheckpointHistoryInput_HistoryRowAddress;
      field: AgentLoadedHistoryCheckpointHistoryInput_HistoryField;
    }
  | {
      kind: 'before';
      cursor: AgentLoadedHistoryCheckpointHistoryInput_Cursor;
    }
  | {
      kind: 'after';
      cursor: AgentLoadedHistoryCheckpointHistoryInput_Cursor;
    }
  | {
      kind: 'event';
      sequence: number;
    };
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type AgentLoadedHistoryCheckpointHistoryInput_HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: AgentLoadedHistoryCheckpointHistoryInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: AgentLoadedHistoryCheckpointHistoryInput_RunId[];
      snapshot: string;
      sequence: number;
      fact: AgentLoadedHistoryCheckpointHistoryInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: AgentLoadedHistoryCheckpointHistoryInput_RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type AgentLoadedHistoryCheckpointHistoryInput_FactId = string;
export type AgentLoadedHistoryCheckpointHistoryInput_RunId = string;
/**
 * A readable field in a conversation window, in presentation order.
 */
export type AgentLoadedHistoryCheckpointHistoryInput_HistoryField = 'thinking' | 'body';
/**
 * Tool output is available through source reads in both views. Conversation
 * windows carry tool metadata only, keeping large results out of chat paging.
 */
export type AgentLoadedHistoryCheckpointHistoryInput_HistoryView = 'text' | 'conversation';
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type AgentLoadedHistoryCheckpointSourceInput_HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: AgentLoadedHistoryCheckpointSourceInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: AgentLoadedHistoryCheckpointSourceInput_RunId[];
      snapshot: string;
      sequence: number;
      fact: AgentLoadedHistoryCheckpointSourceInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: AgentLoadedHistoryCheckpointSourceInput_RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type AgentLoadedHistoryCheckpointSourceInput_FactId = string;
export type AgentLoadedHistoryCheckpointSourceInput_RunId = string;
/**
 * An explicitly selected canonical transcript field, never an execution grant.
 */
export type AgentLoadedHistoryCheckpointSourceInput_SourceField =
  | ('body' | 'thinking' | 'tool_name' | 'failure_message' | 'error_class' | 'arguments' | 'result')
  | 'receipt'
  | 'provider_metadata'
  | 'original';
/**
 * A structural selector into an original JSON field. Keys and array indices
 * remain distinct; neither locates a filesystem resource nor grants access.
 */
export type AgentLoadedHistoryCheckpointSourceInput_HistorySourceSegment = string | number;
export type AgentLoadedHistoryCheckpointSourceInput_SourcePosition =
  | {
      kind: 'start';
    }
  | {
      kind: 'tail';
    }
  | {
      kind: 'before';
      offset: number;
    }
  | {
      kind: 'after';
      offset: number;
    };
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type AgentLoadedHistoryCheckpointToolImageInput_HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: AgentLoadedHistoryCheckpointToolImageInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: AgentLoadedHistoryCheckpointToolImageInput_RunId[];
      snapshot: string;
      sequence: number;
      fact: AgentLoadedHistoryCheckpointToolImageInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: AgentLoadedHistoryCheckpointToolImageInput_RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type AgentLoadedHistoryCheckpointToolImageInput_FactId = string;
export type AgentLoadedHistoryCheckpointToolImageInput_RunId = string;
export type AgentOpenBotOutput_AgentBotRejection =
  | 'disabled'
  | 'creation_rejected'
  | 'no_workspace';
export type AgentPredictNextMessageInput_AgentPredictionTrigger = 'live' | 'catch_up';
export type AgentPresetOutput_PresetRevision = number;
export type AgentPresetOutput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentPresetOutput_PresetAvailability =
  | {
      kind: 'available';
    }
  | {
      kind: 'disabled';
    }
  | {
      kind: 'modelUnavailable';
    }
  | {
      kind: 'thinkingLevelUnavailable';
    };
export type AgentPresetsOutput_PresetRevision = number;
export type AgentPresetsOutput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentPresetsOutput_PresetAvailability =
  | {
      kind: 'available';
    }
  | {
      kind: 'disabled';
    }
  | {
      kind: 'modelUnavailable';
    }
  | {
      kind: 'thinkingLevelUnavailable';
    };
export type AgentPublishCheckpointInput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentPublishCheckpointOutput_AgentHistoryCheckpointState =
  | {
      kind: 'capturing';
    }
  | {
      kind: 'prepared';
    }
  | {
      kind: 'published';
      head: AgentPublishCheckpointOutput_AgentHistoryCheckpointHead;
    }
  | {
      kind: 'conflict';
      actual?: string | null;
    }
  | {
      kind: 'interrupted';
    }
  | {
      kind: 'unavailable';
    };
export type AgentPublishCheckpointOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentPublishCheckpointOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
/**
 * All parts are subscription items; only End admits a complete preview.
 * Offsets and byte counts refer to original bytes, not Base64 or UTF-16 lengths.
 */
export type AgentReadFileOutput_AgentFileReadPart =
  | {
      kind: 'begin';
      version: string;
      digest: string;
      bytes: number;
      content: AgentReadFileOutput_AgentFileContent;
    }
  | {
      kind: 'chunk';
      offset: number;
      data: string;
    }
  | {
      kind: 'end';
      version: string;
      digest: string;
      bytes: number;
    }
  | {
      kind: 'absent';
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'binary';
      bytes: number;
    }
  | {
      kind: 'unsupported';
      fileKind: AgentReadFileOutput_AgentFileKind;
    };
export type AgentReadFileOutput_AgentFileContent =
  | {
      kind: 'text';
    }
  | {
      kind: 'image';
      mimeType: string;
    };
export type AgentReadFileOutput_AgentFileKind = 'file' | 'directory' | 'symlink' | 'other';
export type AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointFrame =
  | {
      kind: 'checkpoint';
      head: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointHead;
      history: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointSnapshot;
      workspace?: AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceSnapshot | null;
    }
  | {
      kind: 'chunk';
      offset: number;
      data: string;
    }
  | {
      kind: 'end';
      digest: string;
      bytes: number;
    };
export type AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
export type AgentRequestSystemPermissionOutput_AgentSystemPermissionOutcome =
  | {
      kind: 'system_permission_granted';
      committedAt: number;
    }
  | {
      kind: 'closure';
      reason: AgentRequestSystemPermissionOutput_ClosureReason;
      committedAt: number;
    };
export type AgentRequestSystemPermissionOutput_ClosureReason =
  | 'steered'
  | 'run_stopped'
  | 'run_terminal'
  | 'producer_cancelled'
  | 'timed_out'
  | 'host_restarted'
  | 'provider_disconnected';
/**
 * A macOS privacy grant (TCC) that the Host process itself needs before native
 * Computer Use can run. This is operating-system state the user changes in
 * System Settings, not a Maka grant; the Host observes it and commits the outcome.
 */
export type AgentRequestSystemPermissionOutput_SystemPermissionGrant =
  | 'accessibility'
  | 'screen_recording';
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentRestoreSessionCheckpointInput_AgentWorkspaceAccess =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentRestoreSessionCheckpointInput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      thinkingLevel?: AgentRestoreSessionCheckpointInput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentRestoreSessionCheckpointInput_AgentExecutorSelection;
    };
export type AgentRestoreSessionCheckpointInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
/**
 * Runtime-native effort, not a Host model's closed reasoning enum.
 */
export type AgentRestoreSessionCheckpointInput_ExecutorEffort = string;
export type AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentSessionCheckpointRestoreReceiptInput_InstanceId = string[];
export type AgentSessionCheckpointRestoreReceiptInput_Transport = 'local' | 'remote';
export type AgentSessionCheckpointRestoreReceiptInput_RecoveryProtocol = 'journal_v1';
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentSessionCheckpointRestoreReceiptInput_AgentWorkspaceAccess =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionCheckpointRestoreReceiptInput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      thinkingLevel?: AgentSessionCheckpointRestoreReceiptInput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionCheckpointRestoreReceiptInput_AgentExecutorSelection;
    };
export type AgentSessionCheckpointRestoreReceiptInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
/**
 * Runtime-native effort, not a Host model's closed reasoning enum.
 */
export type AgentSessionCheckpointRestoreReceiptInput_ExecutorEffort = string;
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentSessionCheckpointRestoreReceiptOutput_InstanceId = string[];
export type AgentSessionCheckpointRestoreReceiptOutput_Transport = 'local' | 'remote';
export type AgentSessionCheckpointRestoreReceiptOutput_RecoveryProtocol = 'journal_v1';
/**
 * Unresolved and Unknown may advance to authoritative original evidence.
 * Returned and NotExecuted are immutable; handler errors are Returned too.
 */
export type AgentSessionCheckpointRestoreReceiptOutput_OperationOutcome =
  | {
      kind: 'unresolved';
    }
  | {
      kind: 'returned';
      result: AgentSessionCheckpointRestoreReceiptOutput_OperationResult;
    }
  | {
      kind: 'not_executed';
      proof: AgentSessionCheckpointRestoreReceiptOutput_NotExecutedProof;
    }
  | {
      kind: 'unknown';
      diagnostic: string;
    };
/**
 * A definite handler return. Failure does not imply absence of side effects.
 */
export type AgentSessionCheckpointRestoreReceiptOutput_OperationResult =
  | {
      kind: 'success';
      value: unknown;
    }
  | {
      kind: 'failure';
      diagnostic: string;
    };
/**
 * An observation of a provider fence, not a capability to create that fence.
 * Only the original provider may establish this proof before handler start.
 */
export type AgentSessionCheckpointRestoreReceiptOutput_NotExecutedProof = {
  kind: 'provider_prevented_before_start';
};
export type AgentSessionCheckpointRestoreReceiptOutput_OperationCleanup =
  | {
      kind: 'unconfirmed';
    }
  | {
      kind: 'confirmed';
    }
  | {
      kind: 'failed';
      diagnostic: string;
    };
export type AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceConsistency =
  | 'caller_confirmed_quiescent'
  | 'unverified';
export type AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceWarning =
  'external_writers_not_fenced';
export type AgentSystemPermissionStatusOutput_AgentSystemPermissionOutcome =
  | {
      kind: 'system_permission_granted';
      committedAt: number;
    }
  | {
      kind: 'closure';
      reason: AgentSystemPermissionStatusOutput_ClosureReason;
      committedAt: number;
    };
export type AgentSystemPermissionStatusOutput_ClosureReason =
  | 'steered'
  | 'run_stopped'
  | 'run_terminal'
  | 'producer_cancelled'
  | 'timed_out'
  | 'host_restarted'
  | 'provider_disconnected';
/**
 * A macOS privacy grant (TCC) that the Host process itself needs before native
 * Computer Use can run. This is operating-system state the user changes in
 * System Settings, not a Maka grant; the Host observes it and commits the outcome.
 */
export type AgentSystemPermissionStatusOutput_SystemPermissionGrant =
  | 'accessibility'
  | 'screen_recording';
export type AgentUpdatePresetInput_PresetRevision = number;
/**
 * Omission preserves the setting; Default explicitly clears it.
 */
export type AgentUpdatePresetInput_PresetThinkingChange =
  | {
      kind: 'default';
    }
  | {
      kind: 'set';
      value: AgentUpdatePresetInput_ThinkingLevel;
    };
export type AgentUpdatePresetInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentUpdatePresetOutput_PresetRevision = number;
export type AgentUpdatePresetOutput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type SettingsAssistantPreferencesOutput_LanguagePreference =
  | 'auto'
  | 'en'
  | 'zh-CN'
  | 'zh-TW';
export type SettingsAssistantPreferencesOutput_Language = 'en' | 'zh-CN' | 'zh-TW';
/**
 * User-facing isolation preset, independent of whether approval may be requested.
 */
export type SettingsAssistantPreferencesOutput_Mode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';
export type SettingsAssistantPreferencesOutput_ShellPreference = 'auto' | 'git_bash';
export type SettingsCatalogModelsInput_CatalogModelReference = Runtime.CatalogModelReference;
export type SettingsConnectionUsageLimitsOutput_UsageLimit =
  | {
      kind: 'window';
      label?: string | null;
      period?: SettingsConnectionUsageLimitsOutput_UsagePeriod | null;
      /**
       * Reset time in Unix seconds.
       */
      resetsAt?: number | null;
      usedPercent: number;
      quantity?: SettingsConnectionUsageLimitsOutput_UsageQuantity | null;
    }
  | {
      kind: 'balance';
      label?: string | null;
      amount: number;
      unit?: string | null;
    }
  | {
      kind: 'unlimited';
      label?: string | null;
    }
  | {
      kind: 'disabled';
      label: string;
      period: SettingsConnectionUsageLimitsOutput_UsagePeriod;
    };
export type SettingsConnectionUsageLimitsOutput_UsagePeriod =
  | {
      kind: 'duration';
      seconds: number;
    }
  | {
      kind: 'monthly';
    };
export type SettingsResolveModelInput_ModelOverride = Runtime.ModelOverride;
export type SettingsUpdateInput_Nullable_MapOf_ModelOverride = {
  [k: string]: SettingsUpdateInput_ModelOverride | undefined;
} | null;
/**
 * Interpreter used only for model-facing Code Mode cells.
 */
export type SettingsUpdateInput_CodeLanguage = 'javascript' | 'python';
export type SettingsUpdateInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type SettingsUpdateInput_ApiProtocol =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages';
export type SettingsUpdateInput_ModelModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';
export type SettingsUpdateInput_RelayServiceTier = 'fast';
export type SettingsUpdateWorkspaceLocationsOutput_ManagementRejection =
  | 'invalid_bundle'
  | 'download_failed'
  | 'invalid_document'
  | 'invalid_source'
  | 'package_unavailable'
  | 'instance_unavailable'
  | 'parent_disabled';
export type SettingsUsageOutput_UsageActivity =
  | {
      kind: 'model';
      attempt: SettingsUsageOutput_UsageModelAttempt;
    }
  | {
      kind: 'tool';
      attempt: SettingsUsageOutput_ToolUsage;
    };
export type SettingsUsageOutput_UsageOrigin =
  | {
      kind: 'agent';
      execution: SettingsUsageOutput_ExecutionIdentity;
      link: SettingsUsageOutput_AgentStepLink;
      purpose: SettingsUsageOutput_ModelPurpose;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'auxiliary';
      source: SettingsUsageOutput_UsageAuxiliarySource;
      [k: string]: unknown | undefined;
    };
export type SettingsUsageOutput_RunId = string;
export type SettingsUsageOutput_StepId = string;
export type SettingsUsageOutput_ModelAttemptId = string;
export type SettingsUsageOutput_ModelPurpose = 'main' | 'summary';
export type SettingsUsageOutput_UsageAuxiliarySource =
  | {
      kind: 'application_operation';
      source: SettingsUsageOutput_DeploymentRef;
      namespace: SettingsUsageOutput_InstanceId;
      operation: string;
      fingerprint: string;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session_title';
      execution: SettingsUsageOutput_ExecutionIdentity;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent';
      execution: SettingsUsageOutput_ExecutionIdentity;
      operation_id: string;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'host_effect';
      id: string;
      [k: string]: unknown | undefined;
    };
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type SettingsUsageOutput_InstanceId = string[];
export type SettingsUsageOutput_UsageOutcome = ('success' | 'error' | 'aborted') | 'unknown';
export type SettingsUsageOutput_ToolUsageSource =
  | {
      kind: 'agent';
      execution: SettingsUsageOutput_ExecutionIdentity;
      call: SettingsUsageOutput_ToolCallIdentity;
    }
  | {
      kind: 'cell';
      cell: SettingsUsageOutput_CellId;
      owner: SettingsUsageOutput_CellOwner;
      operation: string;
    }
  | {
      kind: 'external';
      task: SettingsUsageOutput_ExternalTaskId;
      owner: SettingsUsageOutput_RunOwner;
      operation: string;
    };
export type SettingsUsageOutput_ToolOrigin =
  | {
      kind: 'provider';
      link: SettingsUsageOutput_AgentStepLink;
    }
  | {
      kind: 'code_mode';
      cell: SettingsUsageOutput_CellId;
      owner: SettingsUsageOutput_CellOwner;
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'code_cell';
      cell: SettingsUsageOutput_CellId;
      owner: SettingsUsageOutput_CellOwner;
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'standalone';
    }
  | {
      kind: 'external';
      task: SettingsUsageOutput_ExternalTaskId;
      operation: string;
      package_id: string;
      entry_id: string;
      activation: string;
    }
  | {
      kind: 'host_sdk';
      package_id: string;
      entry_id: string;
      activation: string;
      parent_operation_id: string | null;
      parent_relationship?: SettingsUsageOutput_HostSdkRelationship | null;
    };
export type SettingsUsageOutput_CellId = string;
export type SettingsUsageOutput_CellOwner =
  | {
      kind: 'agent';
      link: SettingsUsageOutput_AgentStepLink;
      call: string;
    }
  | {
      kind: 'standalone';
      session: string;
    };
export type SettingsUsageOutput_ExternalTaskId = string;
export type SettingsUsageOutput_HostSdkRelationship = {
  kind: 'evaluation_observer';
  epoch: string;
};
export type SettingsUsageOutput_ToolUsageResult =
  | {
      kind: 'rejected';
      reason: SettingsUsageOutput_RejectionKind | null;
    }
  | {
      kind: 'settled';
      startedAt: number;
      outcome: SettingsUsageOutput_UsageToolStatus;
    };
/**
 * Refusal category without input-derived explanation text.
 */
export type SettingsUsageOutput_RejectionKind =
  | 'superseded'
  | 'unavailable'
  | 'invalid_input'
  | 'policy_denied'
  | 'preparation_failed'
  | 'exclusive_conflict'
  | 'cancelled';
export type SettingsUsageOutput_UsageToolStatus = 'success' | 'error' | 'unknown';
export type SettingsUsageOutput_OperationCleanup =
  | {
      kind: 'unconfirmed';
    }
  | {
      kind: 'confirmed';
    }
  | {
      kind: 'failed';
      diagnostic: string;
    };
/**
 * Breakdown selected for a bounded summary page.
 */
export type SettingsUsageSummaryOutput_UsageGroup = 'byProvider' | 'byModel' | 'byTool';
export type SettingsAuthenticationProviderOutput_UsageAuthentication =
  | 'provider'
  | 'access_key'
  | 'team_access_key';
/**
 * A finite transfer of one captured durable display. End installs it; these
 * parts never claim an original-output cursor or a parser continuation point.
 */
export type TerminalReadDisplayOutput_TerminalDisplayPart =
  | {
      kind: 'begin';
      revision: number;
      metadata: TerminalReadDisplayOutput_Metadata;
      scrollbackRows: number;
      lastAlternateSize?: TerminalReadDisplayOutput_TerminalSize | null;
    }
  | {
      kind: 'rows';
      parts: TerminalReadDisplayOutput_RowPart[];
    }
  | {
      kind: 'end';
    };
export type TerminalReadDisplayOutput_CursorShape =
  | 'block'
  | 'underline'
  | 'beam'
  | 'hollow_block'
  | 'hidden';
export type TerminalReadDisplayOutput_MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type TerminalReadDisplayOutput_MouseEncoding = 'default' | 'sgr' | 'sgr_pixels';
export type TerminalReadDisplayOutput_Buffer = 'scrollback' | 'screen' | 'last_alternate';
/**
 * Named colors retain their ANSI role (including default foreground/background),
 * while indexed colors retain their exact palette entry even under bold/dim.
 */
export type TerminalReadDisplayOutput_Color =
  | {
      named: number;
    }
  | {
      indexed: number;
    }
  | {
      /**
       * @minItems 3
       * @maxItems 3
       */
      rgb: [number, number, number];
    };

export interface ServiceMethods {
  agent: {
    attachmentImage: {
      mode: 'query';
      input: Runtime.AgentAttachmentImageRead;
      output: Runtime.AgentAttachmentImagePage;
    };
    botOutbox: {
      mode: 'query';
      input: {
        /**
         * Return messages with a sequence greater than this cursor, oldest first.
         */
        after?: number;
        /**
         * Most messages to return, at most 100. Zero reads only the head
         * (`sessionId` and `through`).
         */
        limit?: number;
        /**
         * Read this Session's records instead of the current Bot's, so a Bot that was
         * replaced can still be read. Reading grants nothing: only the current Bot
         * speaks.
         */
        sessionId?: string | null;
      };
      output: {
        enabled: boolean;
        /**
         * The current Bot Session, whatever `sessionId` was asked for.
         */
        sessionId?: string | null;
        /**
         * Whether the Session that was read is, or once was, a Bot Session.
         */
        isBot: boolean;
        /**
         * Highest sequence recorded so far; 0 when empty.
         */
        through: number;
        /**
         * @maxItems 100
         */
        messages: AgentBotOutboxOutput_AgentBotMessage[];
        /**
         * Durable, monotonic acknowledgement of messages actually shown to the user.
         */
        readThrough: number;
        /**
         * Latest `SendUser` text, bounded for list previews. Never internal model output.
         */
        preview: string;
        /**
         * Pass as `after` to read the next page; absent when caught up.
         */
        nextAfter?: number | null;
      };
    };
    catalog: {
      mode: 'subscription';
      input: Runtime.AgentList;
      output: Runtime.AgentSessionPage;
    };
    changeGoal: {
      mode: 'mutation';
      input: Runtime.AgentGoalChange;
      output: Runtime.AgentGoalResult;
    };
    changeSession: {
      mode: 'mutation';
      input: Runtime.AgentChangeSession;
      output: Runtime.AgentSessionChanged;
    };
    checklist: {
      mode: 'query';
      input: Runtime.AgentChecklistRead;
      output: Runtime.AgentChecklist;
    };
    checkpointReceipt: {
      mode: 'query';
      input: {
        reference: AgentCheckpointReceiptInput_RecoveryRef;
        /**
         * The exact original input. Changed input cannot select another publication.
         */
        input: AgentCheckpointReceiptInput_AgentCheckpointPublish;
      };
      output: {
        /**
         * Original Host observation. Domain success never fabricates Host cleanup confirmation.
         */
        operation?: AgentCheckpointReceiptOutput_OperationObservation | null;
        /**
         * Authoritative domain result even when the Host response was lost.
         * Absence is not permission to recapture under a replacement operation.
         */
        publication?: AgentCheckpointReceiptOutput_AgentCheckpointPublication | null;
      };
    };
    compact: {
      mode: 'mutation';
      input: {
        sessionId: string;
        model: Runtime.ModelSelection;
        thinkingLevel?: Runtime.ThinkingLevel | null;
        /**
         * One invocation only; omission uses the Session's effective preference.
         */
        prompt?: string | null;
      };
      output:
        | {
            kind: 'started';
            execution: AgentCompactOutput_AgentExecution;
          }
        | {
            kind: 'rejected';
            reason: AgentCompactOutput_AgentCompactRejection;
          };
    };
    compactionPrompt: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: {
        revision: number;
        prompt: string | null;
        compactionPrompt: string;
        defaultCompactionPrompt: string;
      };
    };
    computerApps: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentComputerApps;
    };
    context: {
      mode: 'query';
      input: Runtime.AgentContextRead;
      output: Runtime.AgentContextReport;
    };
    continuationAvailability: {
      mode: 'query';
      input: Runtime.AgentExecutionRead;
      output:
        | {
            kind: 'ready';
            source: Runtime.AgentExecution;
          }
        | {
            kind: 'rejected';
            reason: Runtime.AgentContinuationRejection;
          };
    };
    continueRun: {
      mode: 'mutation';
      input: Runtime.AgentContinueRun;
      output: Runtime.AgentContinuationResult;
    };
    create: {
      mode: 'mutation';
      input: Runtime.AgentCreate;
      output: Runtime.AgentCreated;
    };
    createPreset: {
      mode: 'mutation';
      input: {
        name: string;
        description: string;
        instruction?: string;
        model: Runtime.ModelSelection;
        thinkingLevel?: Runtime.ThinkingLevel | null;
        enabled?: boolean;
      };
      output:
        | {
            kind: 'saved';
            preset: AgentCreatePresetOutput_Preset;
          }
        | {
            kind: 'deleted';
            id: string;
          }
        | {
            kind: 'notFound';
          }
        | {
            kind: 'conflict';
            actual: AgentCreatePresetOutput_PresetRevision;
          }
        | {
            kind: 'nameConflict';
          }
        | {
            kind: 'invalidInput';
            field: string;
          }
        | {
            kind: 'modelUnavailable';
          }
        | {
            kind: 'thinkingLevelUnavailable';
          };
    };
    deletePreset: {
      mode: 'mutation';
      input: {
        id: string;
        expectedRevision: Runtime.PresetRevision;
      };
      output:
        | {
            kind: 'saved';
            preset: AgentDeletePresetOutput_Preset;
          }
        | {
            kind: 'deleted';
            id: string;
          }
        | {
            kind: 'notFound';
          }
        | {
            kind: 'conflict';
            actual: AgentDeletePresetOutput_PresetRevision;
          }
        | {
            kind: 'nameConflict';
          }
        | {
            kind: 'invalidInput';
            field: string;
          }
        | {
            kind: 'modelUnavailable';
          }
        | {
            kind: 'thinkingLevelUnavailable';
          };
    };
    diagnostics: {
      mode: 'query';
      input: Runtime.AgentDiagnostics;
      output: Runtime.AgentDiagnosticPage;
    };
    directories: {
      mode: 'query';
      input: Runtime.AgentDirectories;
      output: Runtime.AgentDirectoryPage;
    };
    editQueue: {
      mode: 'mutation';
      input: Runtime.AgentQueueMutation;
      output: Runtime.AgentQueueMutationResult;
    };
    execution: {
      mode: 'query';
      input: Runtime.AgentExecutionRead;
      output: Runtime.AgentExecutionResult;
    };
    executorSetup: {
      mode: 'mutation';
      input: Runtime.AgentExecutorSetup;
      output: Runtime.ExecutorSetupResult;
    };
    executors: {
      mode: 'query';
      input: Runtime.AgentExecutorsRead;
      output: Runtime.AgentExecutors;
    };
    externalAgents: {
      mode: 'query';
      input: Runtime.AgentExternalAgentsRead;
      output: Runtime.AgentExternalAgents;
    };
    externalUsageLimits: {
      mode: 'query';
      input: {
        runtime: Runtime.AgentNativeRuntime;
      };
      output:
        | {
            kind: 'ready';
            limits: AgentExternalUsageLimitsOutput_UsageLimit[];
          }
        | {
            kind: 'unsupported';
          }
        | {
            kind: 'unavailable';
          };
    };
    fileCandidates: {
      mode: 'subscription';
      input: Runtime.AgentFileCandidatesRead;
      output: Runtime.AgentFileCandidates | null;
    };
    fork: {
      mode: 'mutation';
      input: Runtime.AgentFork;
      output: Runtime.AgentForkResult;
    };
    forkReceipt: {
      mode: 'query';
      input: Runtime.AgentForkReceipt;
      output: Runtime.AgentForkReceiptResult;
    };
    generateRecap: {
      mode: 'mutation';
      input: Runtime.AgentRecapGenerate;
      output: Runtime.AgentRecapReceipt;
    };
    gitDiff: {
      mode: 'query';
      input: Runtime.AgentGitDiffRead;
      output: Runtime.GitDiff | null;
    };
    gitStatus: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.GitStatus | null;
    };
    globalInstructions: {
      mode: 'query';
      input: Runtime.AgentGlobalInstructionsRead;
      output: Runtime.AgentGlobalInstructionsView;
    };
    goal: {
      mode: 'query';
      input: Runtime.AgentGoalRead;
      output: Runtime.AgentGoalView;
    };
    history: {
      mode: 'query';
      input: Runtime.AgentHistoryRead;
      output: Runtime.AgentHistoryPage;
    };
    historyCheckpointHead: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: AgentHistoryCheckpointHeadOutput_AgentHistoryCheckpointHead | null;
    };
    historyCheckpointLoadReceipt: {
      mode: 'query';
      input: {
        reference: AgentHistoryCheckpointLoadReceiptInput_RecoveryRef;
        input: AgentHistoryCheckpointLoadReceiptInput_AgentHistoryCheckpointRead;
      };
      output: {
        operation?: AgentHistoryCheckpointLoadReceiptOutput_OperationObservation | null;
        load?: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointLoad | null;
      };
    };
    historyLandmarks: {
      mode: 'query';
      input: Runtime.AgentHistoryLandmarksRead;
      output: Runtime.AgentHistoryLandmarks;
    };
    historyPrompt: {
      mode: 'query';
      input: Runtime.AgentHistoryPromptRead;
      output: Runtime.AgentHistoryPrompt | null;
    };
    historyRequests: {
      mode: 'query';
      input: {
        sessionId: string;
        through: number;
        /**
         * Any original row in the Run being inspected.
         */
        position: AgentHistoryRequestsInput_HistoryRowAddress;
        after?: number | null;
      };
      output: {
        requests: AgentHistoryRequestsOutput_AgentHistoryRequest[];
        next?: number | null;
        [k: string]: unknown | undefined;
      };
    };
    import: {
      mode: 'mutation';
      input: Runtime.AgentImportChange;
      output: Runtime.AgentImportResult;
    };
    importDirectories: {
      mode: 'query';
      input: Runtime.AgentDirectories;
      output: Runtime.AgentDirectoryPage;
    };
    imports: {
      mode: 'query';
      input: Runtime.AgentImportsRead;
      output: Runtime.AgentImportsPage;
    };
    interaction: {
      mode: 'query';
      input: Runtime.AgentInteractionRead;
      output: Runtime.InteractionRecord;
    };
    list: {
      mode: 'query';
      input: Runtime.AgentList;
      output: Runtime.AgentSessionPage;
    };
    listFiles: {
      mode: 'query';
      input: Runtime.AgentFileListRead;
      output: Runtime.AgentFilePage;
    };
    loadHistoryCheckpoint: {
      mode: 'mutation';
      input: {
        sessionId: string;
        /**
         * Only the exact currently retained revision is readable; no latest fallback.
         */
        revision: string;
      };
      output: {
        head: AgentLoadHistoryCheckpointOutput_AgentHistoryCheckpointHead;
        inspection: AgentLoadHistoryCheckpointOutput_AgentCheckpointInspection;
        state: AgentLoadHistoryCheckpointOutput_AgentCheckpointLoadState;
      };
    };
    loadedHistoryCheckpointArtifact: {
      mode: 'subscription';
      input: {
        inspection: AgentLoadedHistoryCheckpointArtifactInput_AgentCheckpointInspection;
        path?: AgentLoadedHistoryCheckpointArtifactInput_RunId[];
        sessionId: string;
        artifactId: string;
        offset: number;
      };
      output: AgentLoadedHistoryCheckpointArtifactOutput_AgentCheckpointArtifactChunk | null;
    };
    loadedHistoryCheckpointArtifacts: {
      mode: 'query';
      input: {
        inspection: AgentLoadedHistoryCheckpointArtifactsInput_AgentCheckpointInspection;
        /**
         * Original historical marker path, validated from the inspection root.
         */
        path?: AgentLoadedHistoryCheckpointArtifactsInput_RunId[];
        sessionId: string;
        offset: number;
      };
      output: {
        artifacts: AgentLoadedHistoryCheckpointArtifactsOutput_AgentCheckpointArtifact[];
        nextOffset: number | null;
      };
    };
    loadedHistoryCheckpointAttachmentImage: {
      mode: 'query';
      input: {
        inspection: AgentLoadedHistoryCheckpointAttachmentImageInput_AgentCheckpointInspection;
        position: AgentLoadedHistoryCheckpointAttachmentImageInput_HistoryRowAddress;
        attachmentIndex: number;
        offset?: number;
      };
      /**
       * A bounded image read through an actual history source capability, without a live Root fence.
       */
      output: {
        kind: 'ready';
        position: Runtime.HistoryRowAddress;
        offset: number;
        totalBytes: number;
        mimeType: string;
        digest: string;
        data: string;
      };
    };
    loadedHistoryCheckpointHistory: {
      mode: 'query';
      input: {
        inspection: AgentLoadedHistoryCheckpointHistoryInput_AgentCheckpointInspection;
        sessionId: string;
        position: AgentLoadedHistoryCheckpointHistoryInput_HistoryPosition;
        includeThinking?: boolean;
        view?: AgentLoadedHistoryCheckpointHistoryInput_HistoryView & string;
      };
      output: Runtime.AgentHistoryPage;
    };
    loadedHistoryCheckpointSource: {
      mode: 'query';
      input: {
        inspection: AgentLoadedHistoryCheckpointSourceInput_AgentCheckpointInspection;
        address: AgentLoadedHistoryCheckpointSourceInput_HistoryRowAddress;
        field: AgentLoadedHistoryCheckpointSourceInput_SourceField;
        path?: AgentLoadedHistoryCheckpointSourceInput_HistorySourceSegment[] | null;
        position: AgentLoadedHistoryCheckpointSourceInput_SourcePosition;
      };
      output: Runtime.HistorySource;
    };
    loadedHistoryCheckpointToolImage: {
      mode: 'query';
      input: {
        inspection: AgentLoadedHistoryCheckpointToolImageInput_AgentCheckpointInspection;
        position: AgentLoadedHistoryCheckpointToolImageInput_HistoryRowAddress;
        image?: number | null;
        offset?: number;
      };
      /**
       * A bounded image read through an actual history source capability, without a live Root fence.
       */
      output: {
        kind: 'ready';
        position: Runtime.HistoryRowAddress;
        offset: number;
        totalBytes: number;
        mimeType: string;
        digest: string;
        data: string;
      };
    };
    manageMcpServer: {
      mode: 'mutation';
      input: Runtime.AgentMcpConfigurationChange;
      output: Runtime.AgentMcpConfigurationResult;
    };
    markBotRead: {
      mode: 'mutation';
      /**
       * Acknowledge only the outbox sequence actually exposed in the foreground UI.
       */
      input: {
        sessionId: string;
        through: number;
      };
      output: {
        enabled: boolean;
        /**
         * The current Bot Session, whatever `sessionId` was asked for.
         */
        sessionId?: string | null;
        /**
         * Whether the Session that was read is, or once was, a Bot Session.
         */
        isBot: boolean;
        /**
         * Highest sequence recorded so far; 0 when empty.
         */
        through: number;
        /**
         * @maxItems 100
         */
        messages: AgentMarkBotReadOutput_AgentBotMessage[];
        /**
         * Durable, monotonic acknowledgement of messages actually shown to the user.
         */
        readThrough: number;
        /**
         * Latest `SendUser` text, bounded for list previews. Never internal model output.
         */
        preview: string;
        /**
         * Pass as `after` to read the next page; absent when caught up.
         */
        nextAfter?: number | null;
      };
    };
    markRead: {
      mode: 'mutation';
      input: Runtime.AgentMarkRead;
      output: Runtime.AgentMarkReadResult;
    };
    mcpConfigurations: {
      mode: 'query';
      input: Runtime.AgentMcpConfigurations;
      output: Runtime.AgentMcpConfigurationList;
    };
    metadata: {
      mode: 'mutation';
      input: Runtime.AgentMetadata;
      output: Runtime.AgentMetadataResult;
    };
    model: {
      mode: 'query';
      input: Runtime.AgentModelRead;
      output: Runtime.AgentModelResult;
    };
    models: {
      mode: 'query';
      input: Runtime.AgentModelsRead;
      output: Runtime.AgentModelsPage;
    };
    observe: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentObservation;
    };
    openBot: {
      mode: 'mutation';
      /**
       * Open this installation's Bot Session, creating it on first use.
       */
      input: {
        /**
         * Where the Bot Session is created on first use. Absent: the Host's first
         * configured workspace root, so opening the Bot never needs another conversation.
         */
        workspace?: Runtime.AgentWorkspaceSelection | null;
        title?: string | null;
      };
      output:
        | {
            kind: 'opened';
            sessionId: string;
            created: boolean;
          }
        | {
            kind: 'rejected';
            reason: AgentOpenBotOutput_AgentBotRejection;
          };
    };
    pendingInteractions: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentPendingInteractions;
    };
    predictNextMessage: {
      mode: 'mutation';
      input: {
        sessionId: string;
        expectedTurnId: string;
        trigger: AgentPredictNextMessageInput_AgentPredictionTrigger;
      };
      output: {
        sourceTurnId: string;
        policyRevision: number;
        suggestion?: string | null;
      };
    };
    preset: {
      mode: 'query';
      input: {
        id: string;
      };
      output: AgentPresetOutput_PresetDetail | null;
    };
    presets: {
      mode: 'query';
      input: {};
      output: AgentPresetsOutput_PresetSummary[];
    };
    previewHistoryCheckpoint: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: {
        rootSessionId: string;
        subtreeDigest: string;
        sessions: AgentPreviewHistoryCheckpointOutput_AgentHistoryCheckpointSession[];
      };
    };
    project: {
      mode: 'mutation';
      input: Runtime.AgentProjectChange;
      output: Runtime.AgentProjectResult;
    };
    projectMcp: {
      mode: 'query';
      input: {
        sessionId: string;
      };
      output:
        | {
            kind: 'absent';
          }
        | {
            kind: 'configuration';
            path: string;
            revision: string;
            trusted: boolean;
            servers: AgentProjectMcpOutput_AgentMcpServerView[];
            disabled: string[];
          };
    };
    projects: {
      mode: 'query';
      input: Runtime.AgentProjectsRead;
      output: Runtime.AgentProjectsPage;
    };
    publishCheckpoint: {
      mode: 'mutation';
      input: {
        sessionId: string;
        expectedRevision: string | null;
        /**
         * Membership confirmation returned by previewHistoryCheckpoint, not a live revision.
         */
        confirmedSubtreeDigest: string;
        /**
         * Null captures history only. Otherwise the caller explicitly selects the
         * Workspace consistency guarantee; other applications are never fenced.
         */
        workspaceConsistency: AgentPublishCheckpointInput_AgentCheckpointWorkspaceConsistency | null;
      };
      output: {
        state: AgentPublishCheckpointOutput_AgentHistoryCheckpointState;
        /**
         * Cleanup failure does not undo a successful publication.
         */
        cleanupPending: boolean;
        workspace?: AgentPublishCheckpointOutput_AgentCheckpointWorkspaceNotice | null;
      };
    };
    queue: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentQueue;
    };
    queueMessage: {
      mode: 'query';
      input: Runtime.AgentQueueMessage;
      output: Runtime.AgentQueueMessageResult;
    };
    readFile: {
      mode: 'subscription';
      /**
       * One bounded current-file capture. A version is a precondition, never read authority.
       */
      input: {
        sessionId: string;
        path: Runtime.WorkspacePath;
        expectedVersion?: string | null;
      };
      output: AgentReadFileOutput_AgentFileReadPart | null;
    };
    readHistoryCheckpoint: {
      mode: 'subscription';
      input: {
        sessionId: string;
        /**
         * Only the exact currently retained revision is readable; no latest fallback.
         */
        revision: string;
      };
      output: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointFrame | null;
    };
    readPatch: {
      mode: 'query';
      input: {
        execution: Runtime.AgentExecutionRead;
        offset: number;
      };
      output:
        | {
            kind: 'unavailable';
          }
        | {
            kind: 'ready';
            patch: AgentReadPatchOutput_AgentWorkspacePatch;
            offset: number;
            next: number | null;
            text: string;
          };
    };
    recall: {
      mode: 'subscription';
      input: Runtime.RecallQuery;
      output: Runtime.AgentRecallPage;
    };
    recap: {
      mode: 'query';
      input: Runtime.AgentRecapRead;
      output: Runtime.AgentRecapReceipt | null;
    };
    requestSystemPermission: {
      mode: 'mutation';
      input: {
        sessionId: string;
        requestId: string;
        grant: Runtime.SystemPermissionGrant;
      };
      output: {
        outcome: AgentRequestSystemPermissionOutput_AgentSystemPermissionOutcome | null;
        grants: AgentRequestSystemPermissionOutput_AgentSystemPermissionState[];
        requestable: boolean;
      };
    };
    respond: {
      mode: 'mutation';
      input: Runtime.AgentInteractionRespond;
      output: Runtime.AgentInteractionResult;
    };
    restoreSessionCheckpoint: {
      mode: 'mutation';
      /**
       * Restore files into a new child of a selected directory and rebind the same,
       * unchanged local Session. It never starts a model/tool call or rewinds history.
       */
      input: {
        checkpoint: AgentRestoreSessionCheckpointInput_AgentHistoryCheckpointRead;
        /**
         * Absolute parent path. The Host captures and validates its directory identity.
         */
        parent: string;
        permissions: AgentRestoreSessionCheckpointInput_AgentWorkspacePermissions;
        backend: AgentRestoreSessionCheckpointInput_AgentBackendPreference;
        acceptExternalWritersRisk: boolean;
      };
      output: {
        operation: string;
        sessionId: string;
        sessionRevision: number;
        head: AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointHead;
        workspace: AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceSnapshot;
        path: string;
      };
    };
    schedule: {
      mode: 'mutation';
      input: Runtime.AgentScheduleChange;
      output: Runtime.AgentScheduleResult;
    };
    scheduleAlerts: {
      mode: 'subscription';
      input: {};
      output: Runtime.AgentScheduleAlerts;
    };
    schedules: {
      mode: 'query';
      input: Runtime.AgentScheduleRead;
      output: Runtime.AgentSchedules;
    };
    search: {
      mode: 'query';
      input: Runtime.AgentHistorySearch;
      output: Runtime.AgentHistorySearchPage;
    };
    selectBackend: {
      mode: 'mutation';
      input: Runtime.AgentSelectBackend;
      output: Runtime.AgentMetadataResult;
    };
    selectWorkspace: {
      mode: 'mutation';
      /**
       * A directory on the Host: an absolute path, `~` standing for the home
       * directory, within the configured workspace locations.
       */
      input: {
        path: string;
      };
      output: Runtime.AgentWorkspace | null;
    };
    send: {
      mode: 'mutation';
      input: Runtime.AgentSend;
      output: Runtime.AgentSendResult;
    };
    sessionCheckpointRestoreReceipt: {
      mode: 'query';
      input: {
        reference: AgentSessionCheckpointRestoreReceiptInput_RecoveryRef;
        input: AgentSessionCheckpointRestoreReceiptInput_AgentSessionCheckpointRestore;
      };
      output: {
        operation?: AgentSessionCheckpointRestoreReceiptOutput_OperationObservation | null;
        restore?: AgentSessionCheckpointRestoreReceiptOutput_AgentSessionCheckpointRestored | null;
      };
    };
    sessionMcp: {
      mode: 'subscription';
      /**
       * Client-provided MCP servers whose lifetime is the original subscription.
       * Configurations and credentials are never saved as installation settings.
       */
      input: {
        sessionId: string;
        servers: Runtime.McpServerConfiguration[];
      };
      output: {
        tools: string[];
      };
    };
    setCompactionPrompt: {
      mode: 'mutation';
      input: {
        sessionId: string;
        expectedRevision: number;
        prompt: string | null;
      };
      output: Runtime.AgentMetadataResult;
    };
    skillCandidates: {
      mode: 'query';
      /**
       * Read-only suggestions resolved against the selected completion context.
       */
      input: {
        target: Runtime.AgentCompletionTarget;
        backend: Runtime.AgentBackendPreference;
        query: string;
      };
      output: {
        revision?: string | null;
        skills: AgentSkillCandidatesOutput_AgentSkillCandidate[];
        [k: string]: unknown | undefined;
      };
    };
    snapshotPatch: {
      mode: 'mutation';
      input: Runtime.AgentExecutionRead;
      output:
        | {
            kind: 'unavailable';
          }
        | {
            kind: 'busy';
          }
        | {
            kind: 'changed';
          }
        | {
            kind: 'ready';
            patch: AgentSnapshotPatchOutput_AgentWorkspacePatch;
          };
    };
    source: {
      mode: 'query';
      input: Runtime.AgentHistorySourceRead;
      output: Runtime.AgentHistorySourcePage;
    };
    stop: {
      mode: 'mutation';
      input: Runtime.AgentStop;
      output: Runtime.AgentStopped;
    };
    stopComputerApp: {
      mode: 'mutation';
      input: {
        sessionId: string;
        operationId: string;
      };
      output: Runtime.AgentStopped;
    };
    systemPermissionStatus: {
      mode: 'query';
      input: Runtime.AgentInteractionRead;
      output: {
        outcome: AgentSystemPermissionStatusOutput_AgentSystemPermissionOutcome | null;
        grants: AgentSystemPermissionStatusOutput_AgentSystemPermissionState[];
        requestable: boolean;
      };
    };
    toolImage: {
      mode: 'query';
      input: Runtime.AgentToolImageRead;
      output: Runtime.AgentToolImagePage;
    };
    tools: {
      mode: 'query';
      input: {};
      output: Runtime.AgentToolNames;
    };
    trustProjectMcp: {
      mode: 'mutation';
      input: {
        sessionId: string;
        revision: string;
      };
      output:
        | {
            kind: 'trusted';
          }
        | {
            kind: 'changed';
          };
    };
    updateGlobalInstructions: {
      mode: 'mutation';
      input: Runtime.AgentGlobalInstructionsUpdate;
      output: Runtime.AgentGlobalInstructionsUpdated;
    };
    updatePreset: {
      mode: 'mutation';
      input: {
        id: string;
        expectedRevision: AgentUpdatePresetInput_PresetRevision;
        name?: string | null;
        description?: string | null;
        instruction?: string | null;
        model?: AgentUpdatePresetInput_ModelSelection | null;
        thinkingLevel?: AgentUpdatePresetInput_PresetThinkingChange | null;
        enabled?: boolean | null;
      };
      output:
        | {
            kind: 'saved';
            preset: AgentUpdatePresetOutput_Preset;
          }
        | {
            kind: 'deleted';
            id: string;
          }
        | {
            kind: 'notFound';
          }
        | {
            kind: 'conflict';
            actual: AgentUpdatePresetOutput_PresetRevision;
          }
        | {
            kind: 'nameConflict';
          }
        | {
            kind: 'invalidInput';
            field: string;
          }
        | {
            kind: 'modelUnavailable';
          }
        | {
            kind: 'thinkingLevelUnavailable';
          };
    };
    uploadAttachment: {
      mode: 'mutation';
      input: Runtime.AgentUploadAttachment;
      output: Runtime.AgentAttachmentUploadResult;
    };
    watch: {
      mode: 'subscription';
      input: Runtime.AgentWatch;
      output: Runtime.AgentDeliveryPage;
    };
    watchBotOutbox: {
      mode: 'subscription';
      input: {
        /**
         * Return messages with a sequence greater than this cursor, oldest first.
         */
        after?: number;
        /**
         * Most messages to return, at most 100. Zero reads only the head
         * (`sessionId` and `through`).
         */
        limit?: number;
        /**
         * Read this Session's records instead of the current Bot's, so a Bot that was
         * replaced can still be read. Reading grants nothing: only the current Bot
         * speaks.
         */
        sessionId?: string | null;
      };
      output: {
        enabled: boolean;
        /**
         * The current Bot Session, whatever `sessionId` was asked for.
         */
        sessionId?: string | null;
        /**
         * Whether the Session that was read is, or once was, a Bot Session.
         */
        isBot: boolean;
        /**
         * Highest sequence recorded so far; 0 when empty.
         */
        through: number;
        /**
         * @maxItems 100
         */
        messages: AgentWatchBotOutboxOutput_AgentBotMessage[];
        /**
         * Durable, monotonic acknowledgement of messages actually shown to the user.
         */
        readThrough: number;
        /**
         * Latest `SendUser` text, bounded for list previews. Never internal model output.
         */
        preview: string;
        /**
         * Pass as `after` to read the next page; absent when caught up.
         */
        nextAfter?: number | null;
      };
    };
    watchChecklist: {
      mode: 'subscription';
      input: Runtime.AgentChecklistRead;
      output: Runtime.AgentChecklist;
    };
    watchDiagnostics: {
      mode: 'subscription';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentDiagnosticChange;
    };
    watchFiles: {
      mode: 'subscription';
      input: Runtime.AgentFileWatch;
      output: Runtime.AgentFileChange;
    };
    watchGoal: {
      mode: 'subscription';
      input: Runtime.AgentGoalRead;
      output: Runtime.AgentGoalView;
    };
    watchSchedules: {
      mode: 'subscription';
      input: Runtime.AgentScheduleRead;
      output: Runtime.AgentSchedules;
    };
    work: {
      mode: 'query';
      input: Runtime.AgentWorkRead;
      output: Runtime.AgentWork;
    };
    workReadiness: {
      mode: 'query';
      input: Runtime.AgentWorkRead;
      /**
       * Metadata readiness only. Retirement also requires the actual Root work fence
       * held continuously through the caller's original pending-retirement commit.
       */
      output:
        | {
            kind: 'ready';
          }
        | {
            kind: 'pending';
          }
        | {
            kind: 'unavailable';
          };
    };
  };
  settings: {
    assistantPreferences: {
      mode: 'query';
      input: {};
      output: {
        predictions: SettingsAssistantPreferencesOutput_MessagePredictionSettings;
        defaultPredictionPrompt: string;
        language: SettingsAssistantPreferencesOutput_LanguagePreference | null;
        resolvedLanguage: SettingsAssistantPreferencesOutput_Language;
        compactionPrompt: string;
        defaultCompactionPrompt: string;
        revision: number;
        displayName: string;
        workspaceInstructions: boolean;
        defaultSandboxMode: SettingsAssistantPreferencesOutput_Mode;
        shell: SettingsAssistantPreferencesOutput_ShellPolicy;
      };
    };
    catalogModels: {
      mode: 'query';
      input: {
        query?: string;
        after?: SettingsCatalogModelsInput_CatalogModelReference;
      };
      output: {
        /**
         * @maxItems 16
         */
        models:
          | []
          | [SettingsCatalogModelsOutput_SettingsCatalogModel]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ]
          | [
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
              SettingsCatalogModelsOutput_SettingsCatalogModel,
            ];
        after: SettingsCatalogModelsOutput_CatalogModelReference | null;
      };
    };
    connection: {
      mode: 'query';
      input: {
        connectionId: string;
        revision?: number | null;
        /**
         * Opt in to the complete editing projection; credential reads stay narrow.
         */
        includeEditingFacts?: boolean;
      };
      output: Runtime.SettingsConnectionDetail;
    };
    connectionUsageLimits: {
      mode: 'query';
      input: Runtime.ConnectionVersionBasis;
      output:
        | {
            kind: 'ready';
            limits: SettingsConnectionUsageLimitsOutput_UsageLimit[];
          }
        | {
            kind: 'unsupported';
          }
        | {
            kind: 'superseded';
          }
        | {
            kind: 'authentication_required';
          }
        | {
            kind: 'usage_credential_required';
          }
        | {
            kind: 'unavailable';
          };
    };
    connections: {
      mode: 'query';
      input: Runtime.SettingsConnectionsRead;
      output: Runtime.SettingsConnectionsPage;
    };
    create: {
      mode: 'mutation';
      input: Runtime.CreateCatalogConnectionInput;
      output: Runtime.CatalogMutationResult;
    };
    credentialStatus: {
      mode: 'query';
      input: Runtime.CredentialVaultQueryInput;
      output: Runtime.CredentialVaultQueryResult;
    };
    deleteCredential: {
      mode: 'mutation';
      input: Runtime.DeleteCredentialInput;
      output: Runtime.CredentialMutationResult;
    };
    models: {
      mode: 'query';
      input: Runtime.SettingsModelsRead;
      output: Runtime.SettingsModelsPage;
    };
    network: {
      mode: 'query';
      input: {};
      output: Runtime.SettingsNetworkSnapshot;
    };
    prices: {
      mode: 'query';
      input: Runtime.PricingQuery;
      output:
        | {
            kind: 'page';
            revision: number;
            offset: number;
            entries: Runtime.PricingEntry[];
            nextOffset: number | null;
          }
        | {
            kind: 'revision_changed';
            expectedRevision: number;
            actualRevision: number;
          };
    };
    providers: {
      mode: 'query';
      input: Runtime.SettingsProvidersRead;
      output: Runtime.SettingsProvidersPage;
    };
    remove: {
      mode: 'mutation';
      input: Runtime.RemoveCatalogConnectionInput;
      output: Runtime.CatalogMutationResult;
    };
    resolveModel: {
      mode: 'query';
      input: {
        connectionId: string;
        modelId: string;
        overrides?: SettingsResolveModelInput_ModelOverride;
      };
      output: Runtime.SettingsDefaultModel;
    };
    saveCredential: {
      mode: 'mutation';
      input: Runtime.SettingsSaveCredential;
      output: Runtime.SettingsCredentialSaveResult;
    };
    saveUsageCredential: {
      mode: 'mutation';
      input: Runtime.SettingsSaveCredential;
      output: Runtime.CredentialMutationResult;
    };
    setDefault: {
      mode: 'mutation';
      input: Runtime.SetDefaultConnectionTargetInput;
      output: Runtime.CatalogMutationResult;
    };
    update: {
      mode: 'mutation';
      input: {
        expected: SettingsUpdateInput_ConnectionVersionBasis;
        changes: SettingsUpdateInput_ConnectionCatalogEntryUpdate;
      };
      output: Runtime.CatalogMutationResult;
    };
    updateAssistantPreferences: {
      mode: 'mutation';
      input: Runtime.SettingsPreferencesUpdate;
      output: Runtime.SettingsPreferencesUpdated;
    };
    updateModelSettings: {
      mode: 'mutation';
      input: Runtime.SettingsUpdateModelSettings;
      output: Runtime.CatalogMutationResult;
    };
    updateNetwork: {
      mode: 'mutation';
      input: Runtime.SettingsNetworkUpdate;
      output: Runtime.SettingsNetworkUpdated;
    };
    updatePrice: {
      mode: 'mutation';
      input: Runtime.PricingUpdate;
      output: Runtime.SettingsPricingResult;
    };
    updateWorkspaceLocations: {
      mode: 'mutation';
      input: {
        source: Runtime.DeploymentRef;
        roots: Runtime.DirectoryRootSpec[];
      };
      /**
       * A deterministic refusal is a recorded business result. Uncertain SQL/worker
       * failures remain in the original operation journal's Unknown outcome.
       */
      output:
        | {
            status: 'committed';
            value: SettingsUpdateWorkspaceLocationsOutput_SettingsWorkspaceLocations;
          }
        | {
            status: 'conflict';
            currentRevision: number;
          }
        | {
            status: 'rejected';
            reason: SettingsUpdateWorkspaceLocationsOutput_ManagementRejection;
            diagnostic?: string | null;
          };
    };
    usage: {
      mode: 'query';
      input: Runtime.SettingsUsageRead;
      output: {
        through: SettingsUsageOutput_UsageFence;
        /**
         * @maxItems 32
         */
        attempts: SettingsUsageOutput_UsageActivity[];
        total: number;
        nextCursor: SettingsUsageOutput_UsageActivityCursor | null;
      };
    };
    usageSummary: {
      mode: 'query';
      input: Runtime.SettingsUsageSummaryRead;
      output: {
        through: SettingsUsageSummaryOutput_UsageFence;
        summary: SettingsUsageSummaryOutput_SettingsUsageTotals;
        nextCursor: SettingsUsageSummaryOutput_UsageGroupCursor | null;
      };
    };
    workspaceLocations: {
      mode: 'query';
      input: {};
      output: SettingsWorkspaceLocationsOutput_SettingsWorkspaceLocations | null;
    };
  };
  settingsAuthentication: {
    loginCredential: {
      mode: 'mutation';
      input: Runtime.SettingsCredentialLogin;
      output: Runtime.SettingsCredentialLoginResult;
    };
    provider: {
      mode: 'query';
      input: Runtime.Identity;
      output: {
        identity: SettingsAuthenticationProviderOutput_Identity;
        descriptor: SettingsAuthenticationProviderOutput_Descriptor;
      };
    };
  };
  settingsSetup: {
    discoverModels: {
      mode: 'mutation';
      input: Runtime.ConnectionCredentialTarget;
      output:
        | {
            kind: 'ready';
            connection: Runtime.ConnectionVersionBasis;
          }
        | {
            kind: 'failed';
          }
        | {
            kind: 'superseded';
          };
    };
  };
  deploymentManager: {
    bindingCandidates: {
      mode: 'query';
      input: Runtime.BindingCandidatesRead;
      output: Runtime.BindingCandidatesPage;
    };
    configure: {
      mode: 'mutation';
      input: Runtime.InstanceConfigure;
      output: Runtime.ManagementResultForDeploymentRef;
    };
    configureBatch: {
      mode: 'mutation';
      input: Runtime.InstanceConfigureBatch;
      output: Runtime.ManagementResultForDeploymentRef;
    };
    editComposition: {
      mode: 'mutation';
      input: Runtime.CompositionEdit;
      output: Runtime.ManagementResultForDeploymentRef;
    };
    exportPackage: {
      mode: 'subscription';
      /**
       * An immutable package from one committed revision, including binary files.
       */
      input: {
        source: Runtime.DeploymentRef;
        package: Runtime.PackageRef;
      };
      /**
       * Bundle JSON already encodes file bytes; text chunks add no second base64 layer.
       */
      output:
        | {
            kind: 'chunk';
            offset: number;
            totalBytes: number;
            text: string;
          }
        | {
            kind: 'complete';
          };
    };
    install: {
      mode: 'mutation';
      input: Runtime.PackageInstall;
      output: Runtime.ManagementResultForPackageInstalled;
    };
    installSource: {
      mode: 'mutation';
      input: {
        expectedRevision: number;
        /**
         * UTF-8 package files, including maka.extension.json. Bytes determine identity.
         */
        files: {
          [k: string]: string | undefined;
        };
      };
      output: Runtime.ManagementResultForPackageInstalled;
    };
    installUrl: {
      mode: 'mutation';
      input: {
        expectedRevision: number;
        url: string;
        /**
         * Optional SHA-256 of the downloaded bundle bytes, from a trusted publisher.
         */
        sha256?: string | null;
      };
      output: Runtime.ManagementResultForPackageInstalled;
    };
    instances: {
      mode: 'query';
      input: Runtime.DeploymentInstances;
      output: Runtime.ManagedInstancesPage;
    };
    packageSettings: {
      mode: 'query';
      input: Runtime.PackageSettingsRead;
      output: Runtime.PackageSettingsPage;
    };
    read: {
      mode: 'query';
      input: Runtime.DeploymentRead;
      output: Runtime.ManagedDeployment;
    };
    readDocument: {
      mode: 'query';
      input: Runtime.DeploymentDocumentRead;
      output: Runtime.DeploymentDocumentChunk;
    };
    readPackage: {
      mode: 'query';
      input: {
        source: Runtime.DeploymentRef;
        package: Runtime.PackageRef;
        path?: string | null;
        offset: number;
      };
      output: {
        paths: string[];
        text?: string | null;
        next?: number | null;
      };
    };
    readSettings: {
      mode: 'query';
      input: Runtime.InstanceSettingsRead;
      output: Runtime.InstanceSettingsPage;
    };
    readUi: {
      mode: 'query';
      input: Runtime.UiRead;
      output: Runtime.UiCatalog;
    };
    replace: {
      mode: 'mutation';
      input: Runtime.DeploymentReplace;
      output: Runtime.ManagementResultForDeploymentRef;
    };
    replaceSource: {
      mode: 'mutation';
      input: {
        expectedRevision: number;
        document: Runtime.DeploymentDocument;
      };
      output: Runtime.ManagementResultForDeploymentRef;
    };
    setEnabled: {
      mode: 'mutation';
      input: Runtime.InstanceSetEnabled;
      output: Runtime.ManagementResultForDeploymentRef;
    };
    watch: {
      mode: 'subscription';
      input: Runtime.UiWatch;
      output: Runtime.DeploymentRef;
    };
  };
  terminal: {
    acquire: {
      mode: 'subscription';
      input: Runtime.TerminalTarget;
      output: Runtime.TerminalOutcome_TerminalLeaseUpdate;
    };
    control: {
      mode: 'mutation';
      input: Runtime.TerminalControl;
      output: Runtime.TerminalOutcome_TerminalControlReceipt;
    };
    list: {
      mode: 'query';
      input: Runtime.TerminalList;
      output: Runtime.TerminalOutcome_TerminalPage;
    };
    read: {
      mode: 'query';
      input: Runtime.TerminalTarget;
      output: Runtime.TerminalOutcome_ResourceUpdate;
    };
    readDisplay: {
      mode: 'subscription';
      input: Runtime.TerminalTarget;
      output:
        | {
            kind: 'completed';
            value: TerminalReadDisplayOutput_TerminalDisplayPart;
          }
        | {
            kind: 'failed';
            message: string;
          };
    };
    readOutput: {
      mode: 'query';
      input: Runtime.TerminalOutputRequest;
      output: Runtime.TerminalOutcome_TerminalOutputEvent;
    };
    release: {
      mode: 'mutation';
      input: Runtime.TerminalController;
      output: Runtime.TerminalOutcome_TerminalReleased;
    };
    start: {
      mode: 'mutation';
      input: Runtime.TerminalStart;
      output: Runtime.TerminalOutcome_ResourceUpdate;
    };
    stop: {
      mode: 'mutation';
      input: Runtime.TerminalTarget;
      output: Runtime.TerminalOutcome_TerminalStopped;
    };
    watch: {
      mode: 'subscription';
      input: Runtime.TerminalTarget;
      output: Runtime.TerminalOutcome_ResourceUpdate;
    };
    watchList: {
      mode: 'subscription';
      input: Runtime.TerminalList;
      output: Runtime.TerminalOutcome_TerminalPage;
    };
    watchOutput: {
      mode: 'subscription';
      input: Runtime.TerminalOutputRequest;
      output: Runtime.TerminalOutcome_TerminalOutputEvent;
    };
  };
  skillLibrary: {
    candidates: {
      mode: 'query';
      input: {
        directory: SkillLibraryCandidatesInput_SkillLibraryCandidateDirectory | null;
        tools: string[];
        query: string;
      };
      output: Runtime.SkillModelSearchResult;
    };
    delete: {
      mode: 'mutation';
      input: Runtime.SkillLibraryManageSkill;
      output: Runtime.SkillLibraryChangeResult;
    };
    discoverSource: {
      mode: 'query';
      input: Runtime.SkillLibraryDiscoverSource;
      output: Runtime.SkillLibraryDiscoveredSource;
    };
    install: {
      mode: 'mutation';
      input: Runtime.SkillLibraryInstall;
      output: Runtime.SkillLibraryInstallResult;
    };
    list: {
      mode: 'query';
      input: Runtime.SkillLibraryList;
      output: Runtime.SkillLibraryPage;
    };
    load: {
      mode: 'query';
      /**
       * Actual Agent registrations are supplied outside model-controlled arguments.
       * These names describe compatibility and confer no execution authority.
       */
      input: {
        workspace?: Runtime.AgentWorkspace | null;
        tools: string[];
        input: Runtime.SkillModelLoad;
      };
      output: Runtime.SkillModelLoadResult;
    };
    prepare: {
      mode: 'query';
      /**
       * Actual Agent registrations are supplied outside model-controlled arguments.
       * These names describe compatibility and confer no execution authority.
       */
      input: {
        workspace?: Runtime.AgentWorkspace | null;
        tools: string[];
        input: Runtime.SkillPrepare;
      };
      output: Runtime.SkillPreparation;
    };
    read: {
      mode: 'query';
      input: Runtime.SkillLibraryRead;
      output: Runtime.SkillLibraryDocument;
    };
    search: {
      mode: 'query';
      /**
       * Actual Agent registrations are supplied outside model-controlled arguments.
       * These names describe compatibility and confer no execution authority.
       */
      input: {
        workspace?: Runtime.AgentWorkspace | null;
        tools: string[];
        input: Runtime.SkillModelSearch;
      };
      output: Runtime.SkillModelSearchResult;
    };
    setPreference: {
      mode: 'mutation';
      input: Runtime.SkillLibrarySetPreference;
      output: Runtime.SkillLibraryPreferenceResult;
    };
    update: {
      mode: 'mutation';
      input: Runtime.SkillLibraryManageSkill;
      output: Runtime.SkillLibraryChangeResult;
    };
  };
}
/**
 * One message the Bot deliberately sent to its user.
 */
export interface AgentBotOutboxOutput_AgentBotMessage {
  /**
   * Original investigation behind this publication, independent of later Bot Turns.
   */
  discovery?: AgentBotOutboxOutput_AgentDiscoveryPublication | null;
  /**
   * Monotonic position in the outbox, starting at 1.
   */
  sequence: number;
  /**
   * The model-chosen idempotency key of the `SendUser` call.
   */
  messageId: string;
  /**
   * Position of this message within its `SendUser` call.
   */
  index: number;
  text: string;
  /**
   * Milliseconds since the Unix epoch when the message was recorded.
   */
  at: number;
  /**
   * The Turn whose work sent this message, so clients can show it as that
   * Turn's reply.
   */
  turnId?: string | null;
}
export interface AgentBotOutboxOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
}
export interface AgentCheckpointReceiptInput_RecoveryRef {
  source: AgentCheckpointReceiptInput_DeploymentRef;
  namespace: AgentCheckpointReceiptInput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentCheckpointReceiptInput_RecoveryContract;
  recovery: AgentCheckpointReceiptInput_RecoveryProtocol;
}
export interface AgentCheckpointReceiptInput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentCheckpointReceiptInput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentCheckpointReceiptInput_Transport;
  digest: string;
}
export interface AgentCheckpointReceiptInput_AgentCheckpointPublish {
  sessionId: string;
  expectedRevision: string | null;
  /**
   * Membership confirmation returned by previewHistoryCheckpoint, not a live revision.
   */
  confirmedSubtreeDigest: string;
  /**
   * Null captures history only. Otherwise the caller explicitly selects the
   * Workspace consistency guarantee; other applications are never fenced.
   */
  workspaceConsistency: AgentCheckpointReceiptInput_AgentCheckpointWorkspaceConsistency | null;
}
export interface AgentCheckpointReceiptOutput_OperationObservation {
  reference: AgentCheckpointReceiptOutput_RecoveryRef;
  outcome: AgentCheckpointReceiptOutput_OperationOutcome;
  cleanup: AgentCheckpointReceiptOutput_OperationCleanup;
}
export interface AgentCheckpointReceiptOutput_RecoveryRef {
  source: AgentCheckpointReceiptOutput_DeploymentRef;
  namespace: AgentCheckpointReceiptOutput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentCheckpointReceiptOutput_RecoveryContract;
  recovery: AgentCheckpointReceiptOutput_RecoveryProtocol;
}
export interface AgentCheckpointReceiptOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentCheckpointReceiptOutput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentCheckpointReceiptOutput_Transport;
  digest: string;
}
export interface AgentCheckpointReceiptOutput_AgentCheckpointPublication {
  state: AgentCheckpointReceiptOutput_AgentHistoryCheckpointState;
  /**
   * Cleanup failure does not undo a successful publication.
   */
  cleanupPending: boolean;
  workspace?: AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceNotice | null;
}
export interface AgentCheckpointReceiptOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentCheckpointReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentCheckpointReceiptOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceNotice {
  consistency: AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentCheckpointReceiptOutput_AgentCheckpointWorkspaceWarning;
}
/**
 * Stable logical Run receipt, independent of activations and the current Session tip.
 */
export interface AgentCompactOutput_AgentExecution {
  sessionId: string;
  turnId: string;
  runId: AgentCompactOutput_RunId;
  /**
   * Run-local event count, not the root-global transcript cursor.
   */
  highWater: number;
  state: AgentCompactOutput_AgentExecutionState;
}
export interface AgentCompactOutput_ToolKey {
  attempt: AgentCompactOutput_ModelAttemptId;
  call: string;
}
export interface AgentCompactOutput_ExternalPublicationKey {
  publication: AgentCompactOutput_ExternalPublicationId;
  index: number;
}
export interface AgentCompactOutput_RecoveryRef {
  source: AgentCompactOutput_DeploymentRef;
  namespace: AgentCompactOutput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentCompactOutput_RecoveryContract;
  recovery: AgentCompactOutput_RecoveryProtocol;
}
export interface AgentCompactOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentCompactOutput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentCompactOutput_Transport;
  digest: string;
}
export interface AgentCompactOutput_ContentRef {
  digest: string;
  bytes: number;
}
export interface AgentCreatePresetOutput_Preset {
  id: string;
  revision: AgentCreatePresetOutput_PresetRevision;
  name: string;
  description: string;
  instruction: string;
  model: AgentCreatePresetOutput_ModelSelection;
  thinkingLevel?: AgentCreatePresetOutput_ThinkingLevel | null;
  enabled: boolean;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentCreatePresetOutput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentDeletePresetOutput_Preset {
  id: string;
  revision: AgentDeletePresetOutput_PresetRevision;
  name: string;
  description: string;
  instruction: string;
  model: AgentDeletePresetOutput_ModelSelection;
  thinkingLevel?: AgentDeletePresetOutput_ThinkingLevel | null;
  enabled: boolean;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentDeletePresetOutput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentExternalUsageLimitsOutput_UsageQuantity {
  used: number;
  limit: number;
  unit?: string | null;
}
export interface AgentHistoryCheckpointHeadOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentHistoryCheckpointHeadOutput_AgentHistoryCheckpointObject;
}
export interface AgentHistoryCheckpointHeadOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentHistoryCheckpointLoadReceiptInput_RecoveryRef {
  source: AgentHistoryCheckpointLoadReceiptInput_DeploymentRef;
  namespace: AgentHistoryCheckpointLoadReceiptInput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentHistoryCheckpointLoadReceiptInput_RecoveryContract;
  recovery: AgentHistoryCheckpointLoadReceiptInput_RecoveryProtocol;
}
export interface AgentHistoryCheckpointLoadReceiptInput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentHistoryCheckpointLoadReceiptInput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentHistoryCheckpointLoadReceiptInput_Transport;
  digest: string;
}
export interface AgentHistoryCheckpointLoadReceiptInput_AgentHistoryCheckpointRead {
  sessionId: string;
  /**
   * Only the exact currently retained revision is readable; no latest fallback.
   */
  revision: string;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_OperationObservation {
  reference: AgentHistoryCheckpointLoadReceiptOutput_RecoveryRef;
  outcome: AgentHistoryCheckpointLoadReceiptOutput_OperationOutcome;
  cleanup: AgentHistoryCheckpointLoadReceiptOutput_OperationCleanup;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_RecoveryRef {
  source: AgentHistoryCheckpointLoadReceiptOutput_DeploymentRef;
  namespace: AgentHistoryCheckpointLoadReceiptOutput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentHistoryCheckpointLoadReceiptOutput_RecoveryContract;
  recovery: AgentHistoryCheckpointLoadReceiptOutput_RecoveryProtocol;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentHistoryCheckpointLoadReceiptOutput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentHistoryCheckpointLoadReceiptOutput_Transport;
  digest: string;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointLoad {
  head: AgentHistoryCheckpointLoadReceiptOutput_AgentHistoryCheckpointHead;
  inspection: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointInspection;
  state: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointLoadState;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentHistoryCheckpointLoadReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceSnapshot {
  identity: string;
  consistency: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentHistoryCheckpointLoadReceiptOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentHistoryCheckpointLoadReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentHistoryRequestsOutput_AgentHistoryRequest {
  order: AgentHistoryRequestsOutput_HistoryOrder;
  stepId: AgentHistoryRequestsOutput_StepId;
  attemptId: AgentHistoryRequestsOutput_ModelAttemptId;
  modelId: string;
  purpose: AgentHistoryRequestsOutput_ModelPurpose;
  startedAt?: number | null;
  firstTokenAt?: number | null;
  finished?: AgentHistoryRequestsOutput_AgentHistoryRequestFinished | null;
  estimatedInputTokens: number;
  contextWindow?: number | null;
  inputLimit?: number | null;
  [k: string]: unknown | undefined;
}
/**
 * Lexicographic tree order: original marker sequences followed by the leaf
 * sequence/ordinal. This is presentation order, never a fabricated Root sequence.
 */
export interface AgentHistoryRequestsOutput_HistoryOrder {
  path: number[];
  itemIndex: number;
}
export interface AgentHistoryRequestsOutput_AgentHistoryRequestFinished {
  at: number;
  outcome: AgentHistoryRequestsOutput_UsageOutcome;
  usage: AgentHistoryRequestsOutput_ModelUsage;
  diagnostic?: string | null;
  [k: string]: unknown | undefined;
}
export interface AgentHistoryRequestsOutput_ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  [k: string]: unknown | undefined;
}
export interface AgentLoadHistoryCheckpointOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentLoadHistoryCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentLoadHistoryCheckpointOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentLoadHistoryCheckpointOutput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceSnapshot {
  identity: string;
  consistency: AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentLoadHistoryCheckpointOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentLoadHistoryCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentLoadedHistoryCheckpointArtifactInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentLoadedHistoryCheckpointArtifactOutput_AgentCheckpointArtifactChunk {
  artifact: AgentLoadedHistoryCheckpointArtifactOutput_AgentCheckpointArtifact;
  offset: number;
  /**
   * Base64, at most 32 KiB decoded. Empty only at the end.
   */
  data: string;
}
export interface AgentLoadedHistoryCheckpointArtifactOutput_AgentCheckpointArtifact {
  id: string;
  name: string;
  mimeType?: string | null;
  bytes: number;
}
export interface AgentLoadedHistoryCheckpointArtifactsInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentLoadedHistoryCheckpointArtifactsOutput_AgentCheckpointArtifact {
  id: string;
  name: string;
  mimeType?: string | null;
  bytes: number;
}
export interface AgentLoadedHistoryCheckpointAttachmentImageInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentLoadedHistoryCheckpointHistoryInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
/**
 * Byte offset in one message field's UTF-8 text, not a bearer capability.
 */
export interface AgentLoadedHistoryCheckpointHistoryInput_Cursor {
  field?: AgentLoadedHistoryCheckpointHistoryInput_HistoryField & string;
  position: AgentLoadedHistoryCheckpointHistoryInput_HistoryRowAddress;
  offset: number;
}
export interface AgentLoadedHistoryCheckpointSourceInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
export interface AgentLoadedHistoryCheckpointToolImageInput_AgentCheckpointInspection {
  sourceSessionId: string;
  operationId: string;
}
/**
 * One message the Bot deliberately sent to its user.
 */
export interface AgentMarkBotReadOutput_AgentBotMessage {
  /**
   * Original investigation behind this publication, independent of later Bot Turns.
   */
  discovery?: AgentMarkBotReadOutput_AgentDiscoveryPublication | null;
  /**
   * Monotonic position in the outbox, starting at 1.
   */
  sequence: number;
  /**
   * The model-chosen idempotency key of the `SendUser` call.
   */
  messageId: string;
  /**
   * Position of this message within its `SendUser` call.
   */
  index: number;
  text: string;
  /**
   * Milliseconds since the Unix epoch when the message was recorded.
   */
  at: number;
  /**
   * The Turn whose work sent this message, so clients can show it as that
   * Turn's reply.
   */
  turnId?: string | null;
}
export interface AgentMarkBotReadOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
}
export interface AgentPresetOutput_PresetDetail {
  preset: AgentPresetOutput_Preset;
  availability: AgentPresetOutput_PresetAvailability;
}
export interface AgentPresetOutput_Preset {
  id: string;
  revision: AgentPresetOutput_PresetRevision;
  name: string;
  description: string;
  instruction: string;
  model: AgentPresetOutput_ModelSelection;
  thinkingLevel?: AgentPresetOutput_ThinkingLevel | null;
  enabled: boolean;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentPresetOutput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentPresetsOutput_PresetSummary {
  id: string;
  revision: AgentPresetsOutput_PresetRevision;
  name: string;
  description: string;
  model: AgentPresetsOutput_ModelSelection;
  thinkingLevel?: AgentPresetsOutput_ThinkingLevel | null;
  enabled: boolean;
  availability: AgentPresetsOutput_PresetAvailability;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentPresetsOutput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentPreviewHistoryCheckpointOutput_AgentHistoryCheckpointSession {
  id: string;
  revision: number;
}
/**
 * Displayed only to the user. Credentials are omitted, but their values remain
 * part of the revision that is explicitly confirmed.
 */
export interface AgentProjectMcpOutput_AgentMcpServerView {
  name: string;
  launch: string;
  environment: string[];
  headers: string[];
  preapproved: boolean;
  readOnlyTools: string[];
}
export interface AgentPublishCheckpointOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentPublishCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentPublishCheckpointOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentPublishCheckpointOutput_AgentCheckpointWorkspaceNotice {
  consistency: AgentPublishCheckpointOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentPublishCheckpointOutput_AgentCheckpointWorkspaceWarning;
}
export interface AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointSnapshot {
  object: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointObject;
  /**
   * Exact Agent archive inventory descriptor bytes, not execution authority.
   */
  inventory: number[];
  /**
   * Exact Agent source-cut descriptor bytes. Never a Root/Session capability.
   */
  cut: number[];
}
export interface AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceSnapshot {
  identity: string;
  consistency: AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentReadHistoryCheckpointOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentReadHistoryCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentReadPatchOutput_AgentWorkspacePatch {
  artifactId: string;
  sessionId: string;
  turnId: string;
  baseCommit: string;
  bytes: number;
}
export interface AgentRequestSystemPermissionOutput_AgentSystemPermissionState {
  grant: AgentRequestSystemPermissionOutput_SystemPermissionGrant;
  effective: boolean;
}
export interface AgentRestoreSessionCheckpointInput_AgentHistoryCheckpointRead {
  sessionId: string;
  /**
   * Only the exact currently retained revision is readable; no latest fallback.
   */
  revision: string;
}
export interface AgentRestoreSessionCheckpointInput_AgentWorkspacePermissions {
  access: AgentRestoreSessionCheckpointInput_AgentWorkspaceAccess;
  requestPermissions: boolean;
}
export interface AgentRestoreSessionCheckpointInput_AgentExecutorSelection {
  executor: string;
  settings: AgentRestoreSessionCheckpointInput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentRestoreSessionCheckpointInput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentRestoreSessionCheckpointInput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceSnapshot {
  identity: string;
  consistency: AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentSessionCheckpointRestoreReceiptInput_RecoveryRef {
  source: AgentSessionCheckpointRestoreReceiptInput_DeploymentRef;
  namespace: AgentSessionCheckpointRestoreReceiptInput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentSessionCheckpointRestoreReceiptInput_RecoveryContract;
  recovery: AgentSessionCheckpointRestoreReceiptInput_RecoveryProtocol;
}
export interface AgentSessionCheckpointRestoreReceiptInput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentSessionCheckpointRestoreReceiptInput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentSessionCheckpointRestoreReceiptInput_Transport;
  digest: string;
}
/**
 * Restore files into a new child of a selected directory and rebind the same,
 * unchanged local Session. It never starts a model/tool call or rewinds history.
 */
export interface AgentSessionCheckpointRestoreReceiptInput_AgentSessionCheckpointRestore {
  checkpoint: AgentSessionCheckpointRestoreReceiptInput_AgentHistoryCheckpointRead;
  /**
   * Absolute parent path. The Host captures and validates its directory identity.
   */
  parent: string;
  permissions: AgentSessionCheckpointRestoreReceiptInput_AgentWorkspacePermissions;
  backend: AgentSessionCheckpointRestoreReceiptInput_AgentBackendPreference;
  acceptExternalWritersRisk: boolean;
}
export interface AgentSessionCheckpointRestoreReceiptInput_AgentHistoryCheckpointRead {
  sessionId: string;
  /**
   * Only the exact currently retained revision is readable; no latest fallback.
   */
  revision: string;
}
export interface AgentSessionCheckpointRestoreReceiptInput_AgentWorkspacePermissions {
  access: AgentSessionCheckpointRestoreReceiptInput_AgentWorkspaceAccess;
  requestPermissions: boolean;
}
export interface AgentSessionCheckpointRestoreReceiptInput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionCheckpointRestoreReceiptInput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionCheckpointRestoreReceiptInput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionCheckpointRestoreReceiptInput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_OperationObservation {
  reference: AgentSessionCheckpointRestoreReceiptOutput_RecoveryRef;
  outcome: AgentSessionCheckpointRestoreReceiptOutput_OperationOutcome;
  cleanup: AgentSessionCheckpointRestoreReceiptOutput_OperationCleanup;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_RecoveryRef {
  source: AgentSessionCheckpointRestoreReceiptOutput_DeploymentRef;
  namespace: AgentSessionCheckpointRestoreReceiptOutput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentSessionCheckpointRestoreReceiptOutput_RecoveryContract;
  recovery: AgentSessionCheckpointRestoreReceiptOutput_RecoveryProtocol;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentSessionCheckpointRestoreReceiptOutput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentSessionCheckpointRestoreReceiptOutput_Transport;
  digest: string;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_AgentSessionCheckpointRestored {
  operation: string;
  sessionId: string;
  sessionRevision: number;
  head: AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointHead;
  workspace: AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceSnapshot;
  path: string;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointHead {
  revision: string;
  manifest: AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointObject {
  digest: string;
  bytes: number;
}
export interface AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceSnapshot {
  identity: string;
  consistency: AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentSkillCandidatesOutput_AgentSkillCandidate {
  reference: string;
  name: string;
  description: string;
  invocation: string;
  [k: string]: unknown | undefined;
}
export interface AgentSnapshotPatchOutput_AgentWorkspacePatch {
  artifactId: string;
  sessionId: string;
  turnId: string;
  baseCommit: string;
  bytes: number;
}
export interface AgentSystemPermissionStatusOutput_AgentSystemPermissionState {
  grant: AgentSystemPermissionStatusOutput_SystemPermissionGrant;
  effective: boolean;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentUpdatePresetInput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentUpdatePresetOutput_Preset {
  id: string;
  revision: AgentUpdatePresetOutput_PresetRevision;
  name: string;
  description: string;
  instruction: string;
  model: AgentUpdatePresetOutput_ModelSelection;
  thinkingLevel?: AgentUpdatePresetOutput_ThinkingLevel | null;
  enabled: boolean;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface AgentUpdatePresetOutput_ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
/**
 * One message the Bot deliberately sent to its user.
 */
export interface AgentWatchBotOutboxOutput_AgentBotMessage {
  /**
   * Original investigation behind this publication, independent of later Bot Turns.
   */
  discovery?: AgentWatchBotOutboxOutput_AgentDiscoveryPublication | null;
  /**
   * Monotonic position in the outbox, starting at 1.
   */
  sequence: number;
  /**
   * The model-chosen idempotency key of the `SendUser` call.
   */
  messageId: string;
  /**
   * Position of this message within its `SendUser` call.
   */
  index: number;
  text: string;
  /**
   * Milliseconds since the Unix epoch when the message was recorded.
   */
  at: number;
  /**
   * The Turn whose work sent this message, so clients can show it as that
   * Turn's reply.
   */
  turnId?: string | null;
}
export interface AgentWatchBotOutboxOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
}
export interface SettingsAssistantPreferencesOutput_MessagePredictionSettings {
  enabled: boolean;
  ordinarySessionsOnly: boolean;
  liveSamplePercent: number;
  catchUpSamplePercent: number;
  /**
   * None or blank selects the localized built-in instructions.
   */
  prompt: string | null;
}
export interface SettingsAssistantPreferencesOutput_ShellPolicy {
  preference: SettingsAssistantPreferencesOutput_ShellPreference;
  executable: string;
  titles: boolean;
}
export interface SettingsCatalogModelsOutput_SettingsCatalogModel {
  reference: SettingsCatalogModelsOutput_CatalogModelReference;
  label: string;
  contextWindow: number | null;
}
export interface SettingsCatalogModelsOutput_CatalogModelReference {
  provider: string;
  modelId: string;
}
export interface SettingsConnectionUsageLimitsOutput_UsageQuantity {
  used: number;
  limit: number;
  unit?: string | null;
}
export interface SettingsUpdateInput_ConnectionVersionBasis {
  connectionId: string;
  revision: number;
}
export interface SettingsUpdateInput_ConnectionCatalogEntryUpdate {
  name?: string;
  configuration?: {
    [k: string]: unknown | undefined;
  };
  enabled?: boolean;
  enabledModelIds?: string[];
  modelOverrides?: SettingsUpdateInput_Nullable_MapOf_ModelOverride;
  requestBodyOverlay?: {
    [k: string]: unknown | undefined;
  } | null;
}
export interface SettingsUpdateInput_ModelOverride {
  /**
   * Catalog defaults for this connection's model; the request model ID is unchanged.
   */
  catalogModel?: SettingsUpdateInput_CatalogModelReference;
  /**
   * Public adapter contribution name; omitted selects the wire's default.
   */
  adapter?: string;
  /**
   * Code Mode is enabled by default. Set false to select direct tool calls.
   */
  codeMode?: boolean;
  /**
   * Code Mode interpreter; omitted selects JavaScript.
   */
  codeModeLanguage?: SettingsUpdateInput_CodeLanguage;
  /**
   * Independent of Code Mode: select patch editing or structured Edit/Write.
   */
  applyPatch?: boolean;
  thinkingLevels?: SettingsUpdateInput_ThinkingLevel[];
  defaultThinkingLevel?: SettingsUpdateInput_ThinkingLevel;
  vision?: boolean;
  /**
   * Explicit route image declarations; replaces catalog image constraints.
   */
  imageInput?: SettingsUpdateInput_ImageInput | null;
  /**
   * Override total input-plus-output capacity, without subtracting a reply budget.
   */
  contextWindow?: number;
  /**
   * Optional override of the automatic compaction threshold, in retained tokens.
   * By default Host uses 85% of the smaller total window/input ceiling.
   */
  compactionThreshold?: number;
  /**
   * Independent input ceiling; also caps the default compaction input budget.
   */
  inputLimit?: number;
  /**
   * Requested per-step output budget, subject to provider and remaining-capacity caps.
   */
  maxOutputTokens?: number;
  displayName?: string;
  description?: string;
  apiProtocol?: SettingsUpdateInput_ApiProtocol;
  knowledgeCutoff?: string;
  capabilities?: SettingsUpdateInput_ModelOverrideCapabilities;
  modalities?: SettingsUpdateInput_ModelModalities;
  serviceTier?: SettingsUpdateInput_RelayServiceTier;
}
export interface SettingsUpdateInput_CatalogModelReference {
  provider: string;
  modelId: string;
}
/**
 * Route declarations for image input; absent fields remain unknown.
 */
export interface SettingsUpdateInput_ImageInput {
  /**
   * Exact MIME declarations. A generic image modality leaves this unknown.
   */
  mimeTypes?: string[] | null;
  maxPerMessage?: number | null;
  maxPerRequest?: number | null;
  maxBytes?: number | null;
  minWidth?: number | null;
  minHeight?: number | null;
  maxWidth?: number | null;
  maxHeight?: number | null;
  requestBytes?: number | null;
}
/**
 * Vision has one declaration owner: ModelOverride::vision.
 */
export interface SettingsUpdateInput_ModelOverrideCapabilities {
  chat?: boolean;
  reasoning?: boolean;
  functionCalling?: boolean;
  parallelToolCalls?: boolean;
  imageGeneration?: boolean;
  webSearch?: boolean;
}
export interface SettingsUpdateInput_ModelModalities {
  input: SettingsUpdateInput_ModelModality[];
  output: SettingsUpdateInput_ModelModality[];
}
export interface SettingsUpdateWorkspaceLocationsOutput_SettingsWorkspaceLocations {
  source: SettingsUpdateWorkspaceLocationsOutput_DeploymentRef;
  roots: SettingsUpdateWorkspaceLocationsOutput_DirectoryRootSpec[];
}
export interface SettingsUpdateWorkspaceLocationsOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
export interface SettingsUpdateWorkspaceLocationsOutput_DirectoryRootSpec {
  label: string;
  path: string;
}
export interface SettingsUsageOutput_UsageFence {
  schemaVersion: number;
  stateDomain: string;
  sequence: number;
  auxiliarySequence: number;
  cellSequence: number;
  queryDigest: string;
}
export interface SettingsUsageOutput_UsageModelAttempt {
  requestId: string;
  origin: SettingsUsageOutput_UsageOrigin;
  sessionId: string | null;
  binding: SettingsUsageOutput_ModelBinding | null;
  modelId: string;
  startedAt: number;
  completedAt: number;
  outcome: SettingsUsageOutput_UsageOutcome;
  usage: SettingsUsageOutput_ModelUsage;
  quote: SettingsUsageOutput_Quote | null;
  costUsd: number | null;
}
export interface SettingsUsageOutput_ExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: SettingsUsageOutput_RunId;
}
export interface SettingsUsageOutput_AgentStepLink {
  run: SettingsUsageOutput_RunId;
  step: SettingsUsageOutput_StepId;
  attempt: SettingsUsageOutput_ModelAttemptId;
}
export interface SettingsUsageOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Public model identity. Credentials and provider handles never belong here.
 */
export interface SettingsUsageOutput_ModelBinding {
  connection_id: string;
  connection_slug: string;
  model: string;
  [k: string]: unknown | undefined;
}
export interface SettingsUsageOutput_ModelUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  [k: string]: unknown | undefined;
}
export interface SettingsUsageOutput_Quote {
  providerId: string;
  revision: number;
  pricing: SettingsUsageOutput_Pricing | null;
}
export interface SettingsUsageOutput_Pricing {
  modelKey: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
}
export interface SettingsUsageOutput_ToolUsage {
  requestId: string;
  source: SettingsUsageOutput_ToolUsageSource;
  name: string;
  binding: SettingsUsageOutput_ModelBinding | null;
  completedAt: number;
  result: SettingsUsageOutput_ToolUsageResult;
  cleanup: SettingsUsageOutput_OperationCleanup | null;
}
/**
 * A Tool Call is distinct from its durable host operation. Origin determines
 * model visibility; it is not an independent flag that can contradict ancestry.
 */
export interface SettingsUsageOutput_ToolCallIdentity {
  tool_call_id: string;
  origin: SettingsUsageOutput_ToolOrigin;
  [k: string]: unknown | undefined;
}
export interface SettingsUsageOutput_RunOwner {
  deployment: string;
  namespace: SettingsUsageOutput_InstanceId;
}
export interface SettingsUsageOutput_UsageActivityCursor {
  completedAt: number;
  requestId: string;
}
export interface SettingsUsageSummaryOutput_UsageFence {
  schemaVersion: number;
  stateDomain: string;
  sequence: number;
  auxiliarySequence: number;
  cellSequence: number;
  queryDigest: string;
}
export interface SettingsUsageSummaryOutput_SettingsUsageTotals {
  models: SettingsUsageSummaryOutput_UsageModelTotals;
  tools: SettingsUsageSummaryOutput_UsageToolTotals;
  pending: SettingsUsageSummaryOutput_UsagePending;
  /**
   * @maxItems 32
   */
  byProvider: SettingsUsageSummaryOutput_UsageProviderSummary[];
  /**
   * @maxItems 32
   */
  byModel: SettingsUsageSummaryOutput_UsageModelSummary[];
  /**
   * @maxItems 32
   */
  byTool: SettingsUsageSummaryOutput_UsageToolSummary[];
}
export interface SettingsUsageSummaryOutput_UsageModelTotals {
  calls: number;
  success: number;
  error: number;
  aborted: number;
  unknown: number;
  /**
   * Sum of observed durations; unknown outcomes are excluded. Not wall-clock time.
   */
  durationMs: number;
  input: SettingsUsageSummaryOutput_UsageTokens;
  output: SettingsUsageSummaryOutput_UsageTokens;
  cacheRead: SettingsUsageSummaryOutput_UsageTokens;
  cacheWrite: SettingsUsageSummaryOutput_UsageTokens;
  reasoning: SettingsUsageSummaryOutput_UsageTokens;
  cost: SettingsUsageSummaryOutput_UsageCost;
}
/**
 * Sum of reported counters, qualified by calls that omitted this counter.
 */
export interface SettingsUsageSummaryOutput_UsageTokens {
  known: number;
  missing: number;
}
export interface SettingsUsageSummaryOutput_UsageCost {
  knownUsd: number;
  /**
   * Calls without a persisted valuation; includes unpriced calls.
   */
  unvalued: number;
  unpriced: number;
}
export interface SettingsUsageSummaryOutput_UsageToolTotals {
  /**
   * Includes pre-dispatch refusals, which are counted separately below.
   */
  calls: number;
  success: number;
  error: number;
  unknown: number;
  rejected: number;
  /**
   * Known success/error durations; refusals and unknown effects contribute no time.
   */
  durationMs: number;
  /**
   * Only known success/error settlements contribute to observed execution latency.
   */
  meanLatencyMs: number | null;
}
export interface SettingsUsageSummaryOutput_UsagePending {
  models: number;
  tools: number;
}
export interface SettingsUsageSummaryOutput_UsageProviderSummary {
  /**
   * Unknown identity is not inferred from a transport protocol or current settings.
   */
  providerId: string | null;
  totals: SettingsUsageSummaryOutput_UsageModelTotals;
}
export interface SettingsUsageSummaryOutput_UsageModelSummary {
  modelId: string;
  totals: SettingsUsageSummaryOutput_UsageModelTotals;
}
export interface SettingsUsageSummaryOutput_UsageToolSummary {
  name: string;
  totals: SettingsUsageSummaryOutput_UsageToolTotals;
}
export interface SettingsUsageSummaryOutput_UsageGroupCursor {
  group: SettingsUsageSummaryOutput_UsageGroup;
  key: string | null;
}
export interface SettingsWorkspaceLocationsOutput_SettingsWorkspaceLocations {
  source: SettingsWorkspaceLocationsOutput_DeploymentRef;
  roots: SettingsWorkspaceLocationsOutput_DirectoryRootSpec[];
}
export interface SettingsWorkspaceLocationsOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
export interface SettingsWorkspaceLocationsOutput_DirectoryRootSpec {
  label: string;
  path: string;
}
/**
 * Durable recipient, not a registration lease. Re-loading the same package can
 * restore it; another package, Entry or scope cannot inherit its credentials.
 */
export interface SettingsAuthenticationProviderOutput_Identity {
  packageId: string;
  entryId: string;
  scope: string;
  name: string;
}
export interface SettingsAuthenticationProviderOutput_Descriptor {
  label: string;
  /**
   * Offers a user-selected endpoint instead of a named service.
   */
  customEndpoint: boolean;
  configurationSchema: unknown;
  configurationDefaults: unknown;
  authentication: SettingsAuthenticationProviderOutput_Method[];
  /**
   * Whether the provider supports a connection without a stored credential.
   * Presentation metadata; authorization remains the provider's decision.
   */
  anonymous: boolean;
  discovery: boolean;
  usageAuthentication?: SettingsAuthenticationProviderOutput_UsageAuthentication | null;
}
export interface SettingsAuthenticationProviderOutput_Method {
  id: string;
  label: string;
  /**
   * Secret-bearing form input never enters the connection configuration.
   */
  inputSchema: {
    [k: string]: unknown | undefined;
  };
  interactive: boolean;
}
export interface TerminalReadDisplayOutput_Metadata {
  size: TerminalReadDisplayOutput_TerminalSize;
  cursor: TerminalReadDisplayOutput_TerminalCursor;
  cursorShape: TerminalReadDisplayOutput_CursorShape;
  cursorBlinking: boolean;
  alternateScreen: boolean;
  truncated: boolean;
  input: TerminalReadDisplayOutput_TerminalInputModes;
  /**
   * Palette overrides only; absence preserves the viewing client's theme.
   */
  palette: [unknown, unknown][];
}
/**
 * Shared by native PTY allocation, input validation and screen rendering.
 */
export interface TerminalReadDisplayOutput_TerminalSize {
  cols: number;
  rows: number;
}
export interface TerminalReadDisplayOutput_TerminalCursor {
  x: number;
  y: number;
  visible: boolean;
}
export interface TerminalReadDisplayOutput_TerminalInputModes {
  applicationCursorKeysMode: boolean;
  mouseTrackingMode: TerminalReadDisplayOutput_MouseTracking;
  mouseEncoding: TerminalReadDisplayOutput_MouseEncoding;
}
export interface TerminalReadDisplayOutput_RowPart {
  buffer: TerminalReadDisplayOutput_Buffer;
  row: number;
  column: number;
  runs: TerminalReadDisplayOutput_Run[];
}
/**
 * Consecutive cells with the same style. `text` includes every blank and
 * combining character. Empty `lengths` means one Unicode scalar per cell;
 * otherwise each entry is the scalar count of one cell, including its base.
 */
export interface TerminalReadDisplayOutput_Run {
  style: TerminalReadDisplayOutput_Style;
  text: string;
  lengths?: number[];
}
/**
 * Cell flags use the terminal's fixed bit layout: inverse=1, bold=2, italic=4,
 * underline=8, wrap=16, wide=32, wide spacer=64, dim=128, hidden=256,
 * strike=512, leading wide spacer=1024, double/curl/dotted/dashed underline
 * =2048/4096/8192/16384. Geometry flags remain attached to their original cell.
 */
export interface TerminalReadDisplayOutput_Style {
  foreground: TerminalReadDisplayOutput_Color;
  background: TerminalReadDisplayOutput_Color;
  flags: number;
  underline?: TerminalReadDisplayOutput_Color | null;
}
/**
 * A read-only directory observation; it does not allocate an execution workspace.
 */
export interface SkillLibraryCandidatesInput_SkillLibraryCandidateDirectory {
  path: string;
  directoryIdentity: string;
}
