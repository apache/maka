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

export type AgentChangeMemoryInput_MemoryScope =
  | {
      kind: 'personal';
    }
  | {
      kind: 'project';
      sessionId: string;
    };
export type AgentChangeMemoryInput_MemoryEdit =
  | {
      kind: 'add_evidence';
      id: string;
      expectedRevision: number;
      assertion: number;
      reference: AgentChangeMemoryInput_MemoryEvidenceReference;
    }
  | {
      kind: 'create';
      body: string;
      metadata?: AgentChangeMemoryInput_MemoryMetadata;
    }
  | {
      kind: 'correct';
      id: string;
      expectedRevision: number;
      body: string;
      metadata?: AgentChangeMemoryInput_MemoryMetadata;
    }
  | {
      kind: 'set_always';
      id: string;
      expectedRevision: number;
      always: boolean;
    }
  | {
      kind: 'delete';
      id: string;
      expectedRevision: number;
    }
  | {
      kind: 'restore';
      id: string;
      expectedRevision: number;
      body: string;
      metadata?: AgentChangeMemoryInput_MemoryMetadata;
    };
export type AgentChangeMemoryInput_MemoryKind =
  | 'unspecified'
  | 'fact'
  | 'preference'
  | 'instruction';
export type AgentChangeMemoryInput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentChangeMemoryInput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
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
export type AgentCodeDefinitionOutput_AgentCodeBackend =
  | {
      kind: 'lsp';
      server: string;
    }
  | {
      kind: 'indexed';
    };
export type AgentCodeHoverOutput_AgentCodeBackend =
  | {
      kind: 'lsp';
      server: string;
    }
  | {
      kind: 'indexed';
    };
export type AgentCodeReferencesOutput_AgentCodeBackend =
  | {
      kind: 'lsp';
      server: string;
    }
  | {
      kind: 'indexed';
    };
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
export type AgentDeleteGitHubTokenOutput_AgentGitHubTokenSource =
  | 'manual'
  | 'env'
  | 'hosts_file'
  | 'netrc'
  | 'gh_cli';
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
      /**
       * Display names of the models sharing this window; empty when it covers every model.
       */
      models?: string[];
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
export type AgentGitCompareInput_AgentGitCompareSpec =
  | {
      kind: 'branch';
      base: string;
    }
  | {
      kind: 'commit';
      oid: string;
    }
  | {
      kind: 'range';
      base: string;
      head: string;
    };
export type AgentGitCompareOutput_GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'type_changed'
  | 'conflicted';
export type AgentGitCompareDiffInput_AgentGitCompareSpec =
  | {
      kind: 'branch';
      base: string;
    }
  | {
      kind: 'commit';
      oid: string;
    }
  | {
      kind: 'range';
      base: string;
      head: string;
    };
export type AgentGithubPullRequestDetailOutput_AgentGitHubTokenSource =
  | 'manual'
  | 'env'
  | 'hosts_file'
  | 'netrc'
  | 'gh_cli';
export type AgentGithubPullRequestDetailOutput_AgentGitHubPullFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed';
export type AgentGithubPullRequestDetailOutput_AgentGitHubDiffSide = 'LEFT' | 'RIGHT';
export type AgentGithubPullRequestsInput_AgentGitHubPullStateFilter = 'open' | 'closed' | 'all';
export type AgentGithubPullRequestsOutput_AgentGitHubTokenSource =
  | 'manual'
  | 'env'
  | 'hosts_file'
  | 'netrc'
  | 'gh_cli';
export type AgentGithubSubmitReviewInput_AgentGitHubReviewEvent =
  | 'comment'
  | 'approve'
  | 'request_changes';
export type AgentGithubSubmitReviewInput_AgentGitHubDiffSide = 'LEFT' | 'RIGHT';
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
export type AgentHistoryImagesInput_HistoryRowAddress = Runtime.HistoryRowAddress;
export type AgentHistoryRequestsInput_HistoryRowAddress = Runtime.HistoryRowAddress;
export type AgentHistoryRequestsOutput_StepId = string;
export type AgentHistoryRequestsOutput_ModelAttemptId = string;
export type AgentHistoryRequestsOutput_ModelPurpose = 'main' | 'summary';
export type AgentHistoryRequestsOutput_UsageOutcome = ('success' | 'error' | 'aborted') | 'unknown';
export type AgentHistoryRequestsOutput_AgentHistoryRequestRetry =
  | {
      kind: 'scheduled';
      at: number;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'started';
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'cancelled';
      [k: string]: unknown | undefined;
    };
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
      kind: 'message';
      messageId: string;
    }
  | {
      kind: 'before_message';
      messageId: string;
    }
  | {
      kind: 'after_message';
      messageId: string;
    }
  | {
      kind: 'around_message';
      messageId: string;
    }
  | {
      kind: 'row';
      position: AgentLoadedHistoryCheckpointHistoryInput_HistoryRowAddress;
      field: AgentLoadedHistoryCheckpointHistoryInput_HistoryField;
    }
  | {
      kind: 'row_end';
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
export type AgentLoadedHistoryCheckpointHistoryInput_HistoryView =
  | ('text' | 'conversation')
  | 'chat'
  | 'turn'
  | 'steps';
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
export type AgentMemoriesOutput_MemoryMode = 'auto_recall' | 'user_recall' | 'user_always';
export type AgentMemoriesOutput_MemoryState = 'active' | 'unresolved' | 'suppressed';
export type AgentMemoriesOutput_MemoryKind = 'unspecified' | 'fact' | 'preference' | 'instruction';
export type AgentMemoriesOutput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentMemoriesOutput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
export type AgentMemoryOutput_MemoryMode = 'auto_recall' | 'user_recall' | 'user_always';
export type AgentMemoryOutput_MemoryState = 'active' | 'unresolved' | 'suppressed';
export type AgentMemoryOutput_MemoryKind = 'unspecified' | 'fact' | 'preference' | 'instruction';
export type AgentMemoryOutput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentMemoryOutput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
export type AgentMemoryEvidenceOutput_MemorySource =
  | {
      kind: 'conversation';
      reference: AgentMemoryEvidenceOutput_MemoryEvidenceReference;
      observedAt: number;
      operationId: string;
    }
  | {
      kind: 'user_operation';
      operationId: string;
      observedAt: number;
    };
export type AgentMemoryHistoryOutput_MemoryKind =
  | 'unspecified'
  | 'fact'
  | 'preference'
  | 'instruction';
export type AgentMemoryHistoryOutput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentMemoryHistoryOutput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
export type AgentMemoryHistoryOutput_MemorySource =
  | {
      kind: 'conversation';
      reference: AgentMemoryHistoryOutput_MemoryEvidenceReference;
      observedAt: number;
      operationId: string;
    }
  | {
      kind: 'user_operation';
      operationId: string;
      observedAt: number;
    };
export type AgentMemoryHistoryOutput_MemoryGeneration = 'user_input' | 'extraction';
export type AgentOpenBotOutput_AgentBotRejection =
  | 'disabled'
  | 'creation_rejected'
  | 'no_workspace';
export type AgentPendingMemoriesOutput_MemoryMode = 'auto_recall' | 'user_recall' | 'user_always';
export type AgentPendingMemoriesOutput_MemoryState = 'active' | 'unresolved' | 'suppressed';
export type AgentPendingMemoriesOutput_MemoryKind =
  | 'unspecified'
  | 'fact'
  | 'preference'
  | 'instruction';
export type AgentPendingMemoriesOutput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentPendingMemoriesOutput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
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
 * A file selected for reading. Only workspace paths are accepted by editing APIs.
 */
export type AgentReadFileInput_FileReadPath =
  | AgentReadFileInput_WorkspacePath
  | {
      absolute: string;
    };
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
export type AgentReconcileMemoriesInput_MemoryScope =
  | {
      kind: 'personal';
    }
  | {
      kind: 'project';
      sessionId: string;
    };
export type AgentReconcileMemoriesInput_MemoryEdit =
  | {
      kind: 'add_evidence';
      id: string;
      expectedRevision: number;
      assertion: number;
      reference: AgentReconcileMemoriesInput_MemoryEvidenceReference;
    }
  | {
      kind: 'create';
      body: string;
      metadata?: AgentReconcileMemoriesInput_MemoryMetadata;
    }
  | {
      kind: 'correct';
      id: string;
      expectedRevision: number;
      body: string;
      metadata?: AgentReconcileMemoriesInput_MemoryMetadata;
    }
  | {
      kind: 'set_always';
      id: string;
      expectedRevision: number;
      always: boolean;
    }
  | {
      kind: 'delete';
      id: string;
      expectedRevision: number;
    }
  | {
      kind: 'restore';
      id: string;
      expectedRevision: number;
      body: string;
      metadata?: AgentReconcileMemoriesInput_MemoryMetadata;
    };
export type AgentReconcileMemoriesInput_MemoryKind =
  | 'unspecified'
  | 'fact'
  | 'preference'
  | 'instruction';
export type AgentReconcileMemoriesInput_MemoryStatement =
  | 'unspecified'
  | 'assertion'
  | 'preference'
  | 'intention';
export type AgentReconcileMemoriesInput_MemoryTemporal =
  | {
      kind: 'unspecified';
    }
  | {
      kind: 'timeless';
    }
  | {
      kind: 'interval';
      start: number;
      end?: number | null;
    };
export type AgentReconcileMemoriesOutput_MemoryResult =
  | {
      kind: 'created';
      id: string;
      revision: number;
    }
  | {
      kind: 'revised';
      id: string;
      revision: number;
    }
  | {
      kind: 'unresolved';
      id: string;
      revision: number;
    }
  | {
      kind: 'retryable';
      reason: string;
    }
  | {
      kind: 'evidence_added';
      id: string;
      revision: number;
    }
  | {
      kind: 'suppressed';
    }
  | {
      kind: 'saved';
      id: string;
      revision: number;
    }
  | {
      kind: 'deleted';
      id: string;
      revision: number;
    }
  | {
      kind: 'conflict';
      actual: number;
    }
  | {
      kind: 'not_found';
    }
  | {
      kind: 'invalid_state';
    };
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
      serviceTier?: string | null;
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
export type AgentRoomManageInput_AgentRoomManageAction =
  | {
      kind: 'set_topic';
      topic: string;
    }
  | {
      kind: 'add_members';
      memberSessionIds: string[];
    }
  | {
      kind: 'remove_members';
      memberSessionIds: string[];
    }
  | {
      kind: 'react';
      messageId: string;
      emoji: string;
      /**
       * Omit to toggle; true to add, false to remove.
       */
      add?: boolean | null;
    }
  | {
      kind: 'pin';
      messageId: string;
    }
  | {
      kind: 'unpin';
      messageId: string;
    }
  | {
      kind: 'edit_message';
      messageId: string;
      text: string;
    }
  | {
      kind: 'delete_message';
      messageId: string;
    };
export type AgentRoomSearchOutput_AgentRoomAuthor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      execution: AgentRoomSearchOutput_ExecutionIdentity;
    };
export type AgentRoomSearchOutput_RunId = string;
export type AgentRoomSearchOutput_AttachmentKind = 'image' | 'pdf' | 'doc' | 'code' | 'other';
export type AgentRoomSearchOutput_RoomDelivery =
  | {
      kind: 'accepted';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
export type AgentRoomSearchOutput_AgentRoomActor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      sessionId: string;
    };
/**
 * Derived execution outcome for a Room mention delivery.
 */
export type AgentRoomSearchOutput_AgentRoomDeliveryState =
  | {
      kind: 'queued';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'working';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'waiting';
      sessionId: string;
      messageId: string;
      pendingCount: number;
    }
  | {
      kind: 'replied';
      sessionId: string;
      messageId: string;
      replyMessageId: string;
    }
  | {
      kind: 'reacted';
      sessionId: string;
      messageId: string;
      emoji: string;
    }
  | {
      kind: 'silent';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'failed';
      sessionId: string;
      messageId: string;
      reason?: string | null;
    }
  | {
      kind: 'stopped';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
export type AgentSaveGitHubTokenOutput_AgentGitHubTokenSource =
  | 'manual'
  | 'env'
  | 'hosts_file'
  | 'netrc'
  | 'gh_cli';
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
      serviceTier?: string | null;
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
export type AgentSessionCreateInput_AgentSessionKind = 'agent' | 'room';
export type AgentSessionCreateInput_AgentSessionWorkspaceTarget =
  | {
      kind: 'same';
    }
  | {
      kind: 'worktree';
      path?: string | null;
    }
  | {
      kind: 'directory';
      path: string;
    }
  | {
      kind: 'session';
      sessionId: string;
    }
  | {
      kind: 'project';
      projectId: string;
      path: string;
    };
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionCreateInput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: AgentSessionCreateInput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionCreateInput_AgentExecutorSelection;
    };
export type AgentSessionCreateInput_ThinkingLevel =
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
export type AgentSessionCreateInput_ExecutorEffort = string;
export type AgentSessionListInput_AgentSessionKind = 'agent' | 'room';
export type AgentSessionListInput_AgentSessionToolScope = ('all' | 'archived') | 'children';
export type AgentSessionListInput_AgentSessionActivity = 'idle' | 'working' | 'waiting';
export type AgentSessionListOutput_AgentSessionKind = 'agent' | 'room';
export type AgentSessionListOutput_AgentSessionActivity = 'idle' | 'working' | 'waiting';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionListOutput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: AgentSessionListOutput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionListOutput_AgentExecutorSelection;
    };
export type AgentSessionListOutput_ThinkingLevel =
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
export type AgentSessionListOutput_ExecutorEffort = string;
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentSessionListOutput_AgentWorkspaceAccess =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
export type AgentSessionManageInput_AgentSessionManageAction =
  | {
      kind: 'update';
      title?: string | null;
      labels?: string[] | null;
      pinned?: boolean | null;
      expectedRevision?: number | null;
    }
  | {
      kind: 'archive';
      expectedRevision?: number | null;
    }
  | {
      kind: 'restore';
      expectedRevision?: number | null;
    }
  | {
      kind: 'remove';
      expectedRevision?: number | null;
    }
  | {
      kind: 'edit_queue';
      edit: AgentSessionManageInput_AgentQueueAction;
      expectedRevision?: number | null;
    }
  | {
      kind: 'continue_run';
      model: AgentSessionManageInput_ModelSelection;
      thinkingLevel?: AgentSessionManageInput_ThinkingLevel | null;
      sourceRunId?: AgentSessionManageInput_RunId | null;
      sourceHighWater?: number | null;
    }
  | {
      kind: 'room_topic';
      topic: string;
    }
  | {
      kind: 'room_members';
      add?: string[];
      remove?: string[];
    }
  | {
      kind: 'room_react';
      messageId: string;
      emoji: string;
      /**
       * Omit to toggle; true to add, false to remove.
       */
      add?: boolean | null;
    }
  | {
      kind: 'room_pin';
      messageId: string;
      pinned: boolean;
    }
  | {
      kind: 'room_edit';
      messageId: string;
      text: string;
    }
  | {
      kind: 'room_delete';
      messageId: string;
    };
export type AgentSessionManageInput_AgentQueueAction =
  | {
      kind: 'retract';
      messageId: string;
    }
  | {
      kind: 'promote';
      messageId: string;
    }
  | {
      kind: 'update';
      messageId: string;
      message: string;
    }
  | {
      kind: 'reorder';
      /**
       * @minItems 1
       */
      messageIds: [string, ...string[]];
    };
export type AgentSessionManageInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentSessionManageInput_RunId = string;
export type AgentSessionManageOutput_AgentSessionKind = 'agent' | 'room';
export type AgentSessionManageOutput_AgentSessionActivity = 'idle' | 'working' | 'waiting';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionManageOutput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: AgentSessionManageOutput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionManageOutput_AgentExecutorSelection;
    };
export type AgentSessionManageOutput_ThinkingLevel =
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
export type AgentSessionManageOutput_ExecutorEffort = string;
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentSessionManageOutput_AgentWorkspaceAccess =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
export type AgentSessionManageOutput_AgentQueueMutationResult =
  | {
      kind: 'committed';
      revision: number;
    }
  | {
      kind: 'revision_conflict';
      expected: number;
      actual: number;
    }
  | {
      kind: 'rejected';
      reason: AgentSessionManageOutput_AgentQueueRejection;
    };
export type AgentSessionManageOutput_AgentQueueRejection =
  | 'not_your_message'
  | 'closed'
  | 'missing'
  | 'in_flight'
  | 'invalid_edit'
  | 'execution_changed'
  | 'not_running';
export type AgentSessionManageOutput_RunId = string;
export type AgentSessionManageOutput_AgentExecutionState =
  | {
      kind: 'admitted';
    }
  | {
      kind: 'running';
    }
  | {
      kind: 'waiting';
      waits: AgentSessionManageOutput_WaitReason[];
      authorityUnavailable: boolean;
    }
  | {
      kind: 'completed';
    }
  | {
      kind: 'failed';
      reason?: AgentSessionManageOutput_BlockerKind | null;
    }
  | {
      kind: 'cancelled';
    };
export type AgentSessionManageOutput_WaitReason =
  | {
      kind: 'cell';
      cell: AgentSessionManageOutput_CellId;
    }
  | {
      kind: 'external';
      task: AgentSessionManageOutput_ExternalTaskId;
    }
  | {
      kind: 'provider_backoff';
      attempt: AgentSessionManageOutput_ModelAttemptId;
    }
  | {
      kind: 'model';
      attempt: AgentSessionManageOutput_ModelAttemptId;
    }
  | {
      kind: 'approval';
      approval: AgentSessionManageOutput_ApprovalId;
    }
  | {
      kind: 'retry';
      attempt: AgentSessionManageOutput_ModelAttemptId;
    }
  | {
      kind: 'operation';
      tool: AgentSessionManageOutput_ToolKey;
    }
  | {
      kind: 'child';
      run: AgentSessionManageOutput_RunId;
    }
  | {
      kind: 'blocker';
      blocker: AgentSessionManageOutput_BlockerId;
    };
export type AgentSessionManageOutput_CellId = string;
export type AgentSessionManageOutput_ExternalTaskId = string;
export type AgentSessionManageOutput_ModelAttemptId = string;
export type AgentSessionManageOutput_ApprovalId = string;
export type AgentSessionManageOutput_BlockerId = string;
export type AgentSessionManageOutput_BlockerKind =
  | {
      kind: 'external_publication_unavailable';
      publication: AgentSessionManageOutput_ExternalPublicationId;
      diagnostic: string;
    }
  | {
      kind: 'external_publication_item';
      key: AgentSessionManageOutput_ExternalPublicationKey;
      reason: AgentSessionManageOutput_ExternalPublicationBlocker;
    }
  | {
      kind: 'current_authority_unavailable';
      stage: AgentSessionManageOutput_AuthorityStage;
      diagnostic: string;
    }
  | {
      kind: 'external_effect_unknown';
      task: AgentSessionManageOutput_ExternalTaskId;
      operation: string;
    }
  | {
      kind: 'operation_unknown';
      tool: AgentSessionManageOutput_ToolKey;
      reference: AgentSessionManageOutput_RecoveryRef;
    }
  | {
      kind: 'provider_effect_unknown';
      attempt: AgentSessionManageOutput_ModelAttemptId;
      call: string;
    }
  | {
      kind: 'original_admission_unknown';
      tool: AgentSessionManageOutput_ToolKey;
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
      tool: AgentSessionManageOutput_ToolKey;
      diagnostic: string;
    }
  | {
      kind: 'model_cleanup_unconfirmed';
      attempt: AgentSessionManageOutput_ModelAttemptId;
      diagnostic: string;
    }
  | {
      kind: 'cleanup_unconfirmed';
      reference: AgentSessionManageOutput_RecoveryRef;
    }
  | {
      kind: 'resources_unavailable';
      tool: AgentSessionManageOutput_ToolKey;
    }
  | {
      kind: 'external_task_unobservable';
      descriptor: AgentSessionManageOutput_ContentRef;
    };
export type AgentSessionManageOutput_ExternalPublicationId = string;
export type AgentSessionManageOutput_ExternalPublicationBlocker =
  | 'unknown'
  | 'conflict'
  | 'unsupported'
  | 'failed'
  | 'not_attempted'
  | 'cleanup_unconfirmed';
export type AgentSessionManageOutput_AuthorityStage =
  | 'current_session'
  | 'workspace_scope'
  | 'tool_bindings'
  | 'backend_scope'
  | 'input_codec';
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type AgentSessionManageOutput_InstanceId = string[];
export type AgentSessionManageOutput_Transport = 'local' | 'remote';
export type AgentSessionManageOutput_RecoveryProtocol = 'journal_v1';
export type AgentSessionManageOutput_AgentContinuationRejection =
  | 'closed'
  | 'archived'
  | 'busy'
  | 'source_missing'
  | 'source_changed'
  | 'source_not_terminal'
  | 'already_continued'
  | 'workspace_changed'
  | 'safety_check_failed';
export type AgentSessionManageOutput_AgentRoomManageResult =
  | {
      kind: 'topic_updated';
      topic: string;
    }
  | {
      kind: 'members_added';
      added: string[];
    }
  | {
      kind: 'members_removed';
      removed: string[];
    }
  | {
      kind: 'reaction_updated';
      messageId: string;
      emoji: string;
      present: boolean;
    }
  | {
      kind: 'pin_updated';
      messageId: string;
      pinned: boolean;
    }
  | {
      kind: 'message_updated';
      message: AgentSessionManageOutput_AgentRoomMessage;
    };
export type AgentSessionManageOutput_AgentRoomAuthor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      execution: AgentSessionManageOutput_ExecutionIdentity;
    };
export type AgentSessionManageOutput_AttachmentKind = 'image' | 'pdf' | 'doc' | 'code' | 'other';
export type AgentSessionManageOutput_RoomDelivery =
  | {
      kind: 'accepted';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
export type AgentSessionManageOutput_AgentRoomActor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      sessionId: string;
    };
/**
 * Derived execution outcome for a Room mention delivery.
 */
export type AgentSessionManageOutput_AgentRoomDeliveryState =
  | {
      kind: 'queued';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'working';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'waiting';
      sessionId: string;
      messageId: string;
      pendingCount: number;
    }
  | {
      kind: 'replied';
      sessionId: string;
      messageId: string;
      replyMessageId: string;
    }
  | {
      kind: 'reacted';
      sessionId: string;
      messageId: string;
      emoji: string;
    }
  | {
      kind: 'silent';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'failed';
      sessionId: string;
      messageId: string;
      reason?: string | null;
    }
  | {
      kind: 'stopped';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
export type AgentSessionManageOutput_AgentRejection =
  | 'preset_not_found'
  | 'preset_disabled'
  | 'preset_conflict'
  | 'preset_model_unavailable'
  | 'preset_thinking_level_unavailable'
  | 'preset_backend_conflict'
  | 'permission_change_requires_user'
  | 'title_invalid'
  | 'labels_invalid'
  | 'tools_unavailable'
  | 'busy'
  | 'workspace_unavailable'
  | 'session_unavailable'
  | 'history_unavailable'
  | 'closed';
export type AgentSessionReadInput_AgentSessionTranscriptView = 'turns' | 'raw' | 'status_only';
export type AgentSessionReadInput_AgentSessionWindowPosition = 'tail' | 'start';
export type AgentSessionReadInput_AgentRoomAnchorMode = 'at' | 'before' | 'after' | 'around';
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type AgentSessionReadInput_HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: AgentSessionReadInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: AgentSessionReadInput_RunId[];
      snapshot: string;
      sequence: number;
      fact: AgentSessionReadInput_FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: AgentSessionReadInput_RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type AgentSessionReadInput_FactId = string;
export type AgentSessionReadInput_RunId = string;
/**
 * A readable field in a conversation window, in presentation order.
 */
export type AgentSessionReadInput_HistoryField = 'thinking' | 'body';
export type AgentSessionReadOutput_AgentSessionKind = 'agent' | 'room';
export type AgentSessionReadOutput_AgentSessionActivity = 'idle' | 'working' | 'waiting';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionReadOutput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: AgentSessionReadOutput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionReadOutput_AgentExecutorSelection;
    };
export type AgentSessionReadOutput_ThinkingLevel =
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
export type AgentSessionReadOutput_ExecutorEffort = string;
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentSessionReadOutput_AgentWorkspaceAccess =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
export type AgentSessionReadOutput_RunId = string;
export type AgentSessionReadOutput_InteractionRequest =
  | {
      kind: 'session_approval';
      toolUseId: string;
      basis: AgentSessionReadOutput_PermissionBasis;
      sessionId: string;
      requestId: string;
      answer: AgentSessionReadOutput_SessionApprovalAnswer;
    }
  | {
      kind: 'service_approval';
      toolUseId: string;
      toolName: string;
      service: string;
      method: string;
      binding: string;
      through: number;
    }
  | {
      kind: 'permissions';
      target: AgentSessionReadOutput_AuthorizationObligation;
      toolUseId: string | null;
      basis: AgentSessionReadOutput_PermissionBasis;
      request: AgentSessionReadOutput_PermissionRequest;
    }
  | {
      kind: 'question';
      toolUseId: string;
      questions: AgentSessionReadOutput_InteractionQuestion[];
    }
  | {
      kind: 'form';
      toolUseId: string;
      message: string;
      requester: AgentSessionReadOutput_FormRequester;
      fields: AgentSessionReadOutput_FormField[];
    }
  | {
      kind: 'client_capability';
      toolUseId: string;
      target: AgentSessionReadOutput_GrantTarget;
      /**
       * Agent-owned approvals expire with this original permission boundary.
       * Unbound capabilities are explicit; Agent-owned capabilities capture a full binding stamp.
       */
      basis?: AgentSessionReadOutput_PermissionBasis | null;
    }
  | {
      kind: 'computer_app';
      toolUseId: string;
      nativeOperationId: string;
      target: AgentSessionReadOutput_GrantTarget;
      basis: AgentSessionReadOutput_PermissionBasis;
      display: AgentSessionReadOutput_ComputerAppDisplay;
      allowAlways: boolean;
      authorityRevision: number;
    }
  | {
      kind: 'system_permission';
      toolUseId: string;
      /**
       * Distinct missing grants.
       *
       * @minItems 1
       */
      grants: [
        AgentSessionReadOutput_SystemPermissionGrant,
        ...AgentSessionReadOutput_SystemPermissionGrant[],
      ];
      /**
       * The application name the operating system lists in its settings.
       */
      application: string;
      applicationLocation?: AgentSessionReadOutput_SystemPermissionApplicationLocation | null;
    };
/**
 * Only access-expanding child decisions can require a parent's human confirmation.
 */
export type AgentSessionReadOutput_SessionApprovalAnswer =
  | {
      kind: 'service_approval';
      decision: AgentSessionReadOutput_ApprovalAllow;
    }
  | {
      kind: 'permissions';
      decision: AgentSessionReadOutput_PermissionApproval;
    }
  | {
      kind: 'client_capability';
      decision: AgentSessionReadOutput_ApprovalAllow;
    }
  | {
      kind: 'computer_app';
      decision: AgentSessionReadOutput_ComputerAppApproval;
    };
export type AgentSessionReadOutput_ApprovalAllow = 'allow';
export type AgentSessionReadOutput_PermissionApproval = {
  decision: 'allow';
  permissions: AgentSessionReadOutput_Permissions;
  scope: AgentSessionReadOutput_PermissionScope;
};
export type AgentSessionReadOutput_Scope = 'subtree' | 'exact';
/**
 * Equal-path conflict priority is different from authority breadth: deny wins.
 */
export type AgentSessionReadOutput_Access = 'read' | 'write' | 'deny';
export type AgentSessionReadOutput_Network =
  | ('denied' | 'allowed')
  | {
      restricted: {
        destinations: AgentSessionReadOutput_Destination[];
      };
    };
/**
 * The Host supplies the real operation description; it is display information,
 * not authority inferred from a command string or a plugin-supplied Session ID.
 */
export type AgentSessionReadOutput_PermissionScope = 'once' | 'run' | 'session';
export type AgentSessionReadOutput_ComputerAppApproval = 'once' | 'session' | 'always';
export type AgentSessionReadOutput_AuthorizationObligation =
  | {
      kind: 'external';
      task: AgentSessionReadOutput_ExternalTaskId;
      operation: string;
    }
  | {
      kind: 'tool';
      tool: AgentSessionReadOutput_ToolKey;
    }
  | {
      kind: 'cell';
      cell: AgentSessionReadOutput_CellId;
      operation: string;
    };
export type AgentSessionReadOutput_ExternalTaskId = string;
export type AgentSessionReadOutput_ModelAttemptId = string;
export type AgentSessionReadOutput_CellId = string;
/**
 * The tool family whose authority raised a permission request.
 */
export type AgentSessionReadOutput_PermissionSource = 'processes' | 'web' | 'files';
export type AgentSessionReadOutput_FormField = {
  name: string;
  label: string;
  required: boolean;
  description?: string | null;
  [k: string]: unknown | undefined;
} & AgentSessionReadOutput_FormField1;
export type AgentSessionReadOutput_FormField1 =
  | {
      kind: 'string';
      default?: string | null;
      minLength?: number | null;
      maxLength?: number | null;
      format?: AgentSessionReadOutput_FormFormat | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'number';
      default?: number | null;
      minimum?: number | null;
      maximum?: number | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'integer';
      default?: number | null;
      minimum?: number | null;
      maximum?: number | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'boolean';
      default?: boolean | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'single_select';
      options: AgentSessionReadOutput_FormOption[];
      default?: string | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'multi_select';
      options: AgentSessionReadOutput_FormOption[];
      default?: string[] | null;
      minItems?: number | null;
      maxItems?: number | null;
      [k: string]: unknown | undefined;
    };
export type AgentSessionReadOutput_FormFormat = 'email' | 'uri' | 'date' | 'date-time';
export type AgentSessionReadOutput_GrantCapability =
  | ('browser' | 'computer_use' | 'computer_audio' | 'desktop_mcp' | 'mcp')
  | 'browser_download'
  | 'browser_history'
  | 'browser_upload';
export type AgentSessionReadOutput_GrantScope =
  | {
      kind: 'browser_origin';
      origin: string;
    }
  | {
      kind: 'browser_profile';
      browserId: string;
      generation: string;
    }
  | {
      kind: 'capability';
    }
  | {
      kind: 'mcp_tool';
      serverId: string;
      toolName: string;
    }
  | {
      kind: 'computer_app';
      platform: AgentSessionReadOutput_ComputerAppPlatform;
      applicationId: string;
    };
export type AgentSessionReadOutput_ComputerAppPlatform = 'macos' | 'windows';
export type AgentSessionReadOutput_ComputerAppRisk = 'low' | 'high';
/**
 * A macOS privacy grant (TCC) that the Host process itself needs before native
 * Computer Use can run. This is operating-system state the user changes in
 * System Settings, not a Maka grant; the Host observes it and commits the outcome.
 */
export type AgentSessionReadOutput_SystemPermissionGrant = 'accessibility' | 'screen_recording';
export type AgentSessionReadOutput_InteractionOutcome =
  | {
      kind: 'session_approval_decision';
      decision: AgentSessionReadOutput_Decision;
      committedAt: number;
    }
  | {
      kind: 'service_approval_decision';
      decision: AgentSessionReadOutput_Decision;
      committedAt: number;
    }
  | {
      kind: 'permissions_decision';
      decision: AgentSessionReadOutput_PermissionDecision;
      committedAt: number;
    }
  | {
      kind: 'question_answer';
      answers: (string | null)[];
      committedAt: number;
    }
  | ((
      | {
          action: 'accept';
          values: {
            [k: string]: AgentSessionReadOutput_FormValue | undefined;
          };
          [k: string]: unknown | undefined;
        }
      | {
          action: 'decline';
          [k: string]: unknown | undefined;
        }
      | {
          action: 'cancel';
          [k: string]: unknown | undefined;
        }
    ) & {
      kind: 'form_answer';
      committedAt: number;
      [k: string]: unknown | undefined;
    })
  | {
      kind: 'client_capability_decision';
      decision: AgentSessionReadOutput_Decision;
      committedAt: number;
    }
  | {
      kind: 'computer_app_decision';
      decision: AgentSessionReadOutput_ComputerAppDecision;
      committedAt: number;
    }
  | {
      kind: 'system_permission_granted';
      committedAt: number;
    }
  | {
      kind: 'closure';
      reason: AgentSessionReadOutput_ClosureReason;
      committedAt: number;
    };
export type AgentSessionReadOutput_Decision = 'allow' | 'deny';
export type AgentSessionReadOutput_PermissionDecision =
  | {
      decision: 'deny';
    }
  | {
      decision: 'allow';
      permissions: AgentSessionReadOutput_Permissions;
      scope: AgentSessionReadOutput_PermissionScope;
    };
export type AgentSessionReadOutput_FormValue = string | number | boolean | string[];
export type AgentSessionReadOutput_ComputerAppDecision = 'once' | 'session' | 'always' | 'deny';
export type AgentSessionReadOutput_ClosureReason =
  | 'steered'
  | 'run_stopped'
  | 'run_terminal'
  | 'producer_cancelled'
  | 'timed_out'
  | 'host_restarted'
  | 'provider_disconnected';
export type AgentSessionReadOutput_AgentRoomParticipantActivity = 'idle' | 'working' | 'waiting';
export type AgentSessionReadOutput_AgentSessionTranscript =
  | {
      kind: 'agent';
      items: AgentSessionReadOutput_AgentTranscriptEntry[];
      beforeCursor?: string | null;
      afterCursor?: string | null;
    }
  | {
      kind: 'room';
      items: AgentSessionReadOutput_AgentRoomPostEntry[];
      beforeCursor?: string | null;
      afterCursor?: string | null;
    };
export type AgentSessionReadOutput_AgentRoomAuthor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      execution: AgentSessionReadOutput_ExecutionIdentity;
    };
export type AgentSessionReadOutput_AttachmentKind = 'image' | 'pdf' | 'doc' | 'code' | 'other';
export type AgentSessionReadOutput_RoomDelivery =
  | {
      kind: 'accepted';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
/**
 * Derived execution outcome for a Room mention delivery.
 */
export type AgentSessionReadOutput_AgentRoomDeliveryState =
  | {
      kind: 'queued';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'working';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'waiting';
      sessionId: string;
      messageId: string;
      pendingCount: number;
    }
  | {
      kind: 'replied';
      sessionId: string;
      messageId: string;
      replyMessageId: string;
    }
  | {
      kind: 'reacted';
      sessionId: string;
      messageId: string;
      emoji: string;
    }
  | {
      kind: 'silent';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'failed';
      sessionId: string;
      messageId: string;
      reason?: string | null;
    }
  | {
      kind: 'stopped';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'rejected';
      sessionId: string;
      reason: string;
    };
export type AgentSessionReadOutput_AgentRoomActor =
  | {
      kind: 'human';
    }
  | {
      kind: 'session';
      sessionId: string;
    };
export type AgentSessionSendInput_AgentSendDelivery = 'steer' | 'queue';
export type AgentSessionSendInput_AgentSessionNotifyMode = 'notify_caller' | 'none';
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentSessionSendInput_AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: AgentSessionSendInput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSessionSendInput_AgentExecutorSelection;
    };
export type AgentSessionSendInput_ThinkingLevel =
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
export type AgentSessionSendInput_ExecutorEffort = string;
export type AgentSessionSendInput_RunId = string;
export type AgentSetProjectMcpDecisionInput_AgentProjectMcpDecisionInput = 'trusted' | 'declined';
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
/**
 * Language preference: "auto" or a canonical BCP 47 locale tag.
 */
export type SettingsAssistantPreferencesOutput_LanguagePreference = string;
/**
 * Resolved canonical BCP 47 language tag (for example en, zh-CN, zh-TW, zh-HK, ja, ko, es, fr, de, pt-BR, ru, it).
 */
export type SettingsAssistantPreferencesOutput_Language = string;
export type SettingsAssistantPreferencesOutput_ProfileAvatar = 'blue' | 'green' | 'rose' | 'amber';
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
      /**
       * Display names of the models sharing this window; empty when it covers every model.
       */
      models?: string[];
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
      /**
       * Absent for the initial attempt, preserving existing source identities.
       */
      attempt?: number | null;
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
      kind: 'external';
      run: SettingsUsageOutput_RunId;
      key: SettingsUsageOutput_ExternalEffectKey;
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
    askQuickQuestion: {
      mode: 'mutation';
      input: {
        sessionId: string;
        question: string;
        requestId: string;
        continueFrom?: string | null;
        /**
         * @maxItems 32
         */
        history?: Runtime.QuickTurn[];
      };
      output: Runtime.QuickReplyInfo;
    };
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
         * Updates existing messages without advancing the unread cursor.
         */
        discoveryLink?: AgentBotOutboxOutput_AgentBotDiscoveryLink | null;
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
    changeMemory: {
      mode: 'mutation';
      input: {
        scope: AgentChangeMemoryInput_MemoryScope;
        edit: AgentChangeMemoryInput_MemoryEdit;
        resolution?: AgentChangeMemoryInput_MemoryResolution | null;
      };
      output:
        | {
            kind: 'created';
            id: string;
            revision: number;
          }
        | {
            kind: 'revised';
            id: string;
            revision: number;
          }
        | {
            kind: 'unresolved';
            id: string;
            revision: number;
          }
        | {
            kind: 'retryable';
            reason: string;
          }
        | {
            kind: 'evidence_added';
            id: string;
            revision: number;
          }
        | {
            kind: 'suppressed';
          }
        | {
            kind: 'saved';
            id: string;
            revision: number;
          }
        | {
            kind: 'deleted';
            id: string;
            revision: number;
          }
        | {
            kind: 'conflict';
            actual: number;
          }
        | {
            kind: 'not_found';
          }
        | {
            kind: 'invalid_state';
          };
    };
    changeSession: {
      mode: 'mutation';
      input: Runtime.AgentChangeSession;
      output: Runtime.AgentSessionChanged;
    };
    changeSessionWorkspace: {
      mode: 'mutation';
      input: {
        sessionId: string;
        expectedRevision: number;
        path: string;
      };
      output:
        | {
            kind: 'changed';
          }
        | {
            kind: 'revision_conflict';
            expected: number;
            actual: number;
          }
        | {
            kind: 'rejected';
            reason: Runtime.AgentRejection;
          };
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
    codeDefinition: {
      mode: 'query';
      input: {
        sessionId: string;
        path: AgentCodeDefinitionInput_WorkspacePath;
        position: AgentCodeDefinitionInput_AgentCodePosition;
        symbol?: string | null;
        hoverOnly?: boolean;
      };
      output: {
        backend: AgentCodeDefinitionOutput_AgentCodeBackend;
        symbol: string;
        originRange: AgentCodeDefinitionOutput_AgentCodeRange | null;
        locations: AgentCodeDefinitionOutput_AgentCodeLocation[];
      };
    };
    codeHover: {
      mode: 'query';
      input: {
        sessionId: string;
        path: AgentCodeHoverInput_WorkspacePath;
        position: AgentCodeHoverInput_AgentCodePosition;
      };
      output: AgentCodeHoverOutput_AgentCodeHoverResult | null;
    };
    codeReferences: {
      mode: 'query';
      input: {
        sessionId: string;
        path: AgentCodeReferencesInput_WorkspacePath;
        position: AgentCodeReferencesInput_AgentCodePosition;
        symbol?: string | null;
        includeDeclaration?: boolean;
      };
      output: {
        backend: AgentCodeReferencesOutput_AgentCodeBackend;
        symbol: string;
        locations: AgentCodeReferencesOutput_AgentCodeLocation[];
        truncated: boolean;
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
    declineProjectMcp: {
      mode: 'mutation';
      input: {
        sessionId: string;
        revision: string;
      };
      output:
        | {
            kind: 'declined';
          }
        | {
            kind: 'changed';
          };
    };
    deleteGitHubToken: {
      mode: 'mutation';
      input: {
        host: string;
      };
      output:
        | {
            kind: 'updated';
            auth: AgentDeleteGitHubTokenOutput_AgentGitHubAuthStatus;
          }
        | {
            kind: 'invalid_token';
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
        refresh?: boolean;
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
    gitCompare: {
      mode: 'query';
      input: {
        sessionId: string;
        spec: AgentGitCompareInput_AgentGitCompareSpec;
        includePatch?: boolean;
        worktreePath?: string | null;
      };
      output: AgentGitCompareOutput_AgentGitCompare | null;
    };
    gitCompareDiff: {
      mode: 'query';
      input: {
        sessionId: string;
        spec: AgentGitCompareDiffInput_AgentGitCompareSpec;
        path: AgentGitCompareDiffInput_WorkspacePath;
        worktreePath?: string | null;
      };
      output: Runtime.GitDiff | null;
    };
    gitDiff: {
      mode: 'query';
      input: Runtime.AgentGitDiffRead;
      output: Runtime.GitDiff | null;
    };
    gitRevisions: {
      mode: 'query';
      input: {
        sessionId: string;
        worktreePath?: string | null;
      };
      output: AgentGitRevisionsOutput_AgentGitRevisions | null;
    };
    gitStatus: {
      mode: 'query';
      input: {
        sessionId: string;
        worktreePath?: string | null;
      };
      output: Runtime.GitStatus | null;
    };
    gitWorkspaceDiff: {
      mode: 'query';
      input: {
        sessionId: string;
        area?: Runtime.GitArea | null;
        worktreePath?: string | null;
      };
      output: AgentGitWorkspaceDiffOutput_GitWorkspaceDiff | null;
    };
    githubCommentPullRequest: {
      mode: 'mutation';
      input: {
        sessionId: string;
        repo?: AgentGithubCommentPullRequestInput_AgentGitHubRepoRef | null;
        number: number;
        body: string;
      };
      output:
        | {
            kind: 'replied';
            comment: AgentGithubCommentPullRequestOutput_AgentGitHubReviewComment;
          }
        | {
            kind: 'unauthorized';
            message: string;
          }
        | {
            kind: 'rejected';
            message: string;
          };
    };
    githubPullRequestDetail: {
      mode: 'query';
      input: {
        sessionId: string;
        repo?: AgentGithubPullRequestDetailInput_AgentGitHubRepoRef | null;
        number: number;
        includePatch?: boolean;
      };
      output:
        | {
            kind: 'ready';
            detail: AgentGithubPullRequestDetailOutput_AgentGitHubPullDetail;
          }
        | {
            kind: 'unauthorized';
            repo: AgentGithubPullRequestDetailOutput_AgentGitHubRepoRef;
            auth: AgentGithubPullRequestDetailOutput_AgentGitHubAuthStatus;
            message: string;
          }
        | {
            kind: 'not_found';
            repo: AgentGithubPullRequestDetailOutput_AgentGitHubRepoRef;
            auth: AgentGithubPullRequestDetailOutput_AgentGitHubAuthStatus;
            number: number;
          }
        | {
            kind: 'error';
            repo: AgentGithubPullRequestDetailOutput_AgentGitHubRepoRef | null;
            auth: AgentGithubPullRequestDetailOutput_AgentGitHubAuthStatus;
            message: string;
          };
    };
    githubPullRequestFileDiff: {
      mode: 'query';
      input: {
        sessionId: string;
        repo?: AgentGithubPullRequestFileDiffInput_AgentGitHubRepoRef | null;
        number: number;
        path: string;
        baseSha?: string | null;
        headSha?: string | null;
      };
      output:
        | {
            kind: 'full';
            patch: string;
            before: string;
            after: string;
            digest: string;
          }
        | {
            kind: 'patch_only';
            patch: string;
            digest: string;
          }
        | {
            kind: 'binary';
          }
        | {
            kind: 'large';
          }
        | {
            kind: 'not_found';
          };
    };
    githubPullRequests: {
      mode: 'query';
      input: {
        sessionId: string;
        repo?: AgentGithubPullRequestsInput_AgentGitHubRepoRef | null;
        state?: AgentGithubPullRequestsInput_AgentGitHubPullStateFilter & string;
        headBranch?: string | null;
      };
      output:
        | {
            kind: 'ready';
            repo: AgentGithubPullRequestsOutput_AgentGitHubRepoRef;
            remotes: AgentGithubPullRequestsOutput_AgentGitHubRepoRef[];
            auth: AgentGithubPullRequestsOutput_AgentGitHubAuthStatus;
            currentBranchPr: number | null;
            pulls: AgentGithubPullRequestsOutput_AgentGitHubPullSummary[];
          }
        | {
            kind: 'no_remote';
            remotes: AgentGithubPullRequestsOutput_AgentGitHubRepoRef[];
          }
        | {
            kind: 'unauthorized';
            repo: AgentGithubPullRequestsOutput_AgentGitHubRepoRef;
            remotes: AgentGithubPullRequestsOutput_AgentGitHubRepoRef[];
            auth: AgentGithubPullRequestsOutput_AgentGitHubAuthStatus;
            message: string;
          }
        | {
            kind: 'error';
            repo: AgentGithubPullRequestsOutput_AgentGitHubRepoRef | null;
            remotes: AgentGithubPullRequestsOutput_AgentGitHubRepoRef[];
            auth: AgentGithubPullRequestsOutput_AgentGitHubAuthStatus;
            message: string;
          };
    };
    githubReplyComment: {
      mode: 'mutation';
      input: {
        sessionId: string;
        repo?: AgentGithubReplyCommentInput_AgentGitHubRepoRef | null;
        number: number;
        commentId: number;
        body: string;
      };
      output:
        | {
            kind: 'replied';
            comment: AgentGithubReplyCommentOutput_AgentGitHubReviewComment;
          }
        | {
            kind: 'unauthorized';
            message: string;
          }
        | {
            kind: 'rejected';
            message: string;
          };
    };
    githubSubmitReview: {
      mode: 'mutation';
      input: {
        sessionId: string;
        repo?: AgentGithubSubmitReviewInput_AgentGitHubRepoRef | null;
        number: number;
        expectedHeadSha: string;
        event: AgentGithubSubmitReviewInput_AgentGitHubReviewEvent;
        body?: string;
        comments?: AgentGithubSubmitReviewInput_AgentGitHubDraftReviewComment[];
      };
      output:
        | {
            kind: 'submitted';
            reviewId: number;
            state: string;
            htmlUrl: string;
          }
        | {
            kind: 'stale_head';
            actualHeadSha: string;
          }
        | {
            kind: 'unauthorized';
            message: string;
          }
        | {
            kind: 'rejected';
            message: string;
          };
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
    historyImages: {
      mode: 'query';
      input: {
        sessionId: string;
        through: number;
        /**
         * Any original row in the Run whose images are listed.
         */
        position: AgentHistoryImagesInput_HistoryRowAddress;
        after?: number | null;
      };
      /**
       * The Run's tool results that produced images, oldest first, each with its call.
       */
      output: {
        tools: Runtime.HistoryTool[];
        next?: number | null;
        [k: string]: unknown | undefined;
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
        runTerminated: boolean;
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
    loadedMemories: {
      mode: 'query';
      input: {
        sessionId: string;
        runId: Runtime.RunId;
      };
      output: AgentLoadedMemoriesOutput_LoadedMemory[];
    };
    lookupSubmission: {
      mode: 'query';
      input: {
        sessionId: string;
        idempotencyKey: string;
      };
      output: string | null;
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
         * Updates existing messages without advancing the unread cursor.
         */
        discoveryLink?: AgentMarkBotReadOutput_AgentBotDiscoveryLink | null;
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
    memories: {
      mode: 'query';
      input: {
        scope: Runtime.MemoryScope;
        after?: string | null;
        limit: number;
      };
      output: {
        records: AgentMemoriesOutput_MemoryRecord[];
        next?: string | null;
      };
    };
    memory: {
      mode: 'query';
      input: {
        scope: Runtime.MemoryScope;
        id: string;
      };
      output: AgentMemoryOutput_MemoryRecord | null;
    };
    memoryEvidence: {
      mode: 'query';
      input: {
        scope: Runtime.MemoryScope;
        id: string;
        assertion: number;
        after?: number | null;
        limit: number;
      };
      output: {
        evidence: AgentMemoryEvidenceOutput_MemoryEvidence[];
        next?: number | null;
      };
    };
    memoryHistory: {
      mode: 'query';
      input: {
        scope: Runtime.MemoryScope;
        id: string;
        after?: number | null;
        limit: number;
      };
      output: {
        versions: AgentMemoryHistoryOutput_MemoryVersion[];
        next?: number | null;
      };
    };
    memorySource: {
      mode: 'query';
      input: {
        sessionId: string;
        sequence: number;
        itemIndex: number;
        start: number;
        end: number;
        quote: string;
      };
      output: {
        sessionId: string;
        sequence: number;
        itemIndex: number;
        factId: string;
        fingerprint: string;
        /**
         * UTF-8 byte offsets into the immutable message text.
         */
        start: number;
        end: number;
        quote: string;
      };
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
    pendingMemories: {
      mode: 'query';
      input: {
        scope: Runtime.MemoryScope;
        after?: string | null;
        limit: number;
      };
      output: {
        records: AgentPendingMemoriesOutput_MemoryRecord[];
        next?: string | null;
      };
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
            declined?: boolean;
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
        path: AgentReadFileInput_FileReadPath;
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
    reconcileMemories: {
      mode: 'mutation';
      input: {
        scope: AgentReconcileMemoriesInput_MemoryScope;
        writes: AgentReconcileMemoriesInput_MemoryWrite[];
        resolution?: AgentReconcileMemoriesInput_MemoryResolution | null;
      };
      output:
        | {
            kind: 'committed';
            results: AgentReconcileMemoriesOutput_MemoryResult[];
          }
        | {
            kind: 'retryable';
            reason: string;
          };
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
    resolveFileLink: {
      mode: 'query';
      input: {
        sessionId: string;
        /**
         * Exact percent-decoded Markdown path bytes.
         */
        pathBytes: string;
      };
      /**
       * A file selected for reading. Only workspace paths are accepted by editing APIs.
       */
      output:
        | Runtime.WorkspacePath
        | {
            absolute: string;
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
    roomManage: {
      mode: 'mutation';
      input: {
        sessionId: string;
        action: AgentRoomManageInput_AgentRoomManageAction;
      };
      output:
        | {
            kind: 'topic_updated';
            topic: string;
          }
        | {
            kind: 'members_added';
            added: string[];
          }
        | {
            kind: 'members_removed';
            removed: string[];
          }
        | {
            kind: 'reaction_updated';
            messageId: string;
            emoji: string;
            present: boolean;
          }
        | {
            kind: 'pin_updated';
            messageId: string;
            pinned: boolean;
          }
        | {
            kind: 'message_updated';
            message: Runtime.AgentRoomMessage;
          };
    };
    roomSearch: {
      mode: 'query';
      input: {
        sessionId: string;
        query: string;
        limit?: number | null;
      };
      output: {
        items: AgentRoomSearchOutput_AgentRoomSearchMatch[];
      };
    };
    roomState: {
      mode: 'query';
      input: {
        sessionId: string;
      };
      output: {
        sessionId: string;
        topic: string;
        members: Runtime.AgentRoomMember[];
        pinned: Runtime.AgentRoomMessage[];
      };
    };
    saveFile: {
      mode: 'mutation';
      input: {
        sessionId: string;
        path: Runtime.WorkspacePath;
        expectedVersion: string;
      };
      output:
        | {
            kind: 'saved';
            version: string;
          }
        | {
            kind: 'conflict';
          };
    };
    saveGitHubToken: {
      mode: 'mutation';
      input: {
        host: string;
      };
      output:
        | {
            kind: 'updated';
            auth: AgentSaveGitHubTokenOutput_AgentGitHubAuthStatus;
          }
        | {
            kind: 'invalid_token';
          };
    };
    schedule: {
      mode: 'mutation';
      input: Runtime.AgentScheduleChange;
      output: Runtime.AgentScheduleResult;
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
    sessionCreate: {
      mode: 'mutation';
      input: {
        title: string;
        kind?: AgentSessionCreateInput_AgentSessionKind | null;
        labels?: string[];
        workspace?: AgentSessionCreateInput_AgentSessionWorkspaceTarget | null;
        presetId?: string | null;
        backend?: AgentSessionCreateInput_AgentBackendPreference | null;
        automaticTitle?: boolean | null;
        tools?: string[] | null;
        /**
         * Seed the new conversation from an existing Session prefix instead of starting empty.
         */
        forkFrom?: AgentSessionCreateInput_AgentSessionForkFrom | null;
      };
      output:
        | {
            kind: 'created';
            session: Runtime.AgentSession;
          }
        | {
            kind: 'forked';
            session: Runtime.AgentSession;
          }
        | {
            kind: 'revision_conflict';
            expected: number;
            actual: number;
          }
        | {
            kind: 'rejected';
            reason: Runtime.AgentRejection;
          };
    };
    sessionList: {
      mode: 'query';
      input: {
        kind?: AgentSessionListInput_AgentSessionKind | null;
        scope?: AgentSessionListInput_AgentSessionToolScope & string;
        /**
         * Optional parent Session ID when scope is "children"; defaults to your own Session.
         */
        parentSessionId?: string | null;
        /**
         * Case-insensitive substring matched against title or workspace path.
         */
        query?: string | null;
        workspacePath?: string | null;
        activity?: AgentSessionListInput_AgentSessionActivity | null;
        limit?: number | null;
        cursor?: string | null;
      };
      output: {
        sessions: AgentSessionListOutput_AgentSessionSummary[];
        nextCursor?: string | null;
      };
    };
    sessionManage: {
      mode: 'mutation';
      input: {
        sessionId: string;
        action: AgentSessionManageInput_AgentSessionManageAction;
      };
      output:
        | {
            kind: 'updated';
            session: AgentSessionManageOutput_AgentSessionSummary;
          }
        | {
            kind: 'removed';
            sessionId: string;
          }
        | {
            kind: 'queue_edited';
            result: AgentSessionManageOutput_AgentQueueMutationResult;
          }
        | {
            kind: 'continuation_started';
            execution: AgentSessionManageOutput_AgentExecution;
          }
        | {
            kind: 'continuation_rejected';
            reason: AgentSessionManageOutput_AgentContinuationRejection;
          }
        | {
            kind: 'room_updated';
            result: AgentSessionManageOutput_AgentRoomManageResult;
          }
        | {
            kind: 'revision_conflict';
            expected: number;
            actual: number;
          }
        | {
            kind: 'rejected';
            reason: AgentSessionManageOutput_AgentRejection;
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
    sessionRead: {
      mode: 'query';
      input: {
        /**
         * Target Session or Room ID. Omit to inspect your own Session.
         */
        sessionId?: string | null;
        view?: AgentSessionReadInput_AgentSessionTranscriptView & string;
        position?: AgentSessionReadInput_AgentSessionWindowPosition | null;
        /**
         * Opaque pagination token (beforeCursor or afterCursor) from a previous SessionRead.
         */
        cursor?: string | null;
        /**
         * Jump to or around a specific Room messageId.
         */
        messageId?: string | null;
        anchor?: AgentSessionReadInput_AgentRoomAnchorMode | null;
        /**
         * Full-text search within a Room; returns matching posts with snippets.
         */
        searchQuery?: string | null;
        /**
         * Exact historical row lookup emitted by Recall or Code Mode cell references.
         */
        row?: AgentSessionReadInput_AgentSessionRowLookup | null;
      };
      output: {
        session: AgentSessionReadOutput_AgentSessionSummary;
        run?: AgentSessionReadOutput_AgentSessionRunOverview | null;
        pendingInteractions?: AgentSessionReadOutput_InteractionRecord[];
        queuedMessages?: AgentSessionReadOutput_AgentQueuedMessageOverview[];
        queueRevision?: number | null;
        liveOutputPreview?: string | null;
        room?: AgentSessionReadOutput_AgentRoomOverview | null;
        transcript?: AgentSessionReadOutput_AgentSessionTranscript | null;
      };
    };
    sessionSend: {
      mode: 'mutation';
      input: {
        sessionId: string;
        message: string;
        /**
         * Defaults to steer (injects cleanly at the next step boundary without aborting in-flight tools).
         * Pass queue to wait until the current turn finishes before delivering.
         */
        delivery?: AgentSessionSendInput_AgentSendDelivery | null;
        /**
         * For Agent callers sending to a worker Session, defaults to notify_caller. Pass none to silence.
         */
        onComplete?: AgentSessionSendInput_AgentSessionNotifyMode | null;
        backend?: AgentSessionSendInput_AgentBackendPreference | null;
        expectedRunId?: AgentSessionSendInput_RunId | null;
        attachments?: string[];
        /**
         * Agent Session IDs to notify when posting in a Room.
         */
        mentions?: string[];
        /**
         * Existing Room messageId being replied to.
         */
        replyTo?: string | null;
      };
      output: Runtime.AgentSendResult;
    };
    sessionStop: {
      mode: 'mutation';
      input: {
        sessionId: string;
        /**
         * Optional exact Run ID guard; omit to stop whichever Run is currently active.
         */
        runId?: Runtime.RunId | null;
      };
      output: {
        requested: boolean;
        runId?: Runtime.RunId | null;
      };
    };
    sessionWorkspaceAvailable: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: boolean;
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
    setProjectMcpDecision: {
      mode: 'mutation';
      input: {
        workspace: AgentSetProjectMcpDecisionInput_AgentWorkspace;
        revision: string;
        decision: AgentSetProjectMcpDecisionInput_AgentProjectMcpDecisionInput;
      };
      output:
        | {
            kind: 'saved';
          }
        | {
            kind: 'changed';
          };
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
    submitMessage: {
      mode: 'mutation';
      input: {
        sessionId: string;
        idempotencyKey?: string | null;
        message: string;
        attachments?: string[];
        backend?: Runtime.AgentBackendPreference | null;
      };
      output:
        | {
            kind: 'queued';
            messageId: string;
          }
        | {
            kind: 'duplicate';
            messageId: string;
          };
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
         * Updates existing messages without advancing the unread cursor.
         */
        discoveryLink?: AgentWatchBotOutboxOutput_AgentBotDiscoveryLink | null;
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
    watchModels: {
      mode: 'subscription';
      input: {
        query?: string;
      };
      output: Runtime.AgentModelsPage;
    };
    watchSchedules: {
      mode: 'subscription';
      input: Runtime.AgentScheduleRead;
      output: Runtime.AgentSchedules;
    };
    withdrawSubmission: {
      mode: 'mutation';
      input: {
        sessionId: string;
        messageId: string;
      };
      output:
        | {
            kind: 'delivered';
          }
        | {
            kind: 'cancelled';
          };
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
        avatar: SettingsAssistantPreferencesOutput_ProfileAvatar | null;
        workspaceInstructions: boolean;
        memory: SettingsAssistantPreferencesOutput_MemoryPolicy;
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
    dictationConnections: {
      mode: 'query';
      input: {};
      output: SettingsDictationConnectionsOutput_DictationConnection[];
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
    transcribeDictation: {
      mode: 'query';
      input: {
        connection: Runtime.ConnectionVersionBasis;
        audio: string;
      };
      output: string;
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
  workspaceComputer: {
    evaluate: {
      mode: 'mutation';
      input: Runtime.ComputerEvaluate;
      output: Runtime.ComputerResult;
    };
    presentTarget: {
      mode: 'mutation';
      input: Runtime.ComputerPresentTarget;
      output: Runtime.ComputerPresentationResult;
    };
    readFrame: {
      mode: 'query';
      input: Runtime.ComputerReadFrame;
      output: Runtime.ComputerFrameResult;
    };
    reset: {
      mode: 'mutation';
      input: {};
      output: Runtime.ComputerResult;
    };
    state: {
      mode: 'query';
      input: {};
      output: Runtime.ComputerReplState;
    };
    watchFrames: {
      mode: 'subscription';
      input: Runtime.ComputerWatchFrames;
      output: Runtime.ComputerFrameNotice;
    };
    watchStage: {
      mode: 'subscription';
      input: Runtime.ComputerWatchStage;
      output: Runtime.ComputerStageSnapshot;
    };
  };
  workspaceWeb: {
    capture: {
      mode: 'query';
      input: {};
      output: Runtime.WebCapture;
    };
    checkKey: {
      mode: 'mutation';
      input: Runtime.WebKey;
      output: Runtime.WebUpdate;
    };
    deleteKey: {
      mode: 'mutation';
      input: Runtime.WebKey;
      output: Runtime.WebUpdate;
    };
    fetch: {
      mode: 'mutation';
      input: Runtime.WebCall_WebFetch;
      output: Runtime.WebResult;
    };
    probe: {
      mode: 'mutation';
      input: Runtime.WebProbe;
      output: Runtime.WebResult;
    };
    save: {
      mode: 'mutation';
      input: Runtime.WebSet;
      output: Runtime.WebUpdate;
    };
    saveKey: {
      mode: 'mutation';
      input: Runtime.WebKey;
      output: Runtime.WebUpdate;
    };
    search: {
      mode: 'mutation';
      input: Runtime.WebCall_WebQuery;
      output: Runtime.WebResult;
    };
    snapshot: {
      mode: 'query';
      input: {};
      output: Runtime.WebSnapshot;
    };
  };
}
/**
 * Most recent discovery association added after a Bot message was published.
 */
export interface AgentBotOutboxOutput_AgentBotDiscoveryLink {
  revision: number;
  messageId: string;
  turnId?: string | null;
  discovery: AgentBotOutboxOutput_AgentDiscoveryPublication;
}
export interface AgentBotOutboxOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
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
export interface AgentChangeMemoryInput_MemoryEvidenceReference {
  sessionId: string;
  sequence: number;
  itemIndex: number;
  factId: string;
  fingerprint: string;
  /**
   * UTF-8 byte offsets into the immutable message text.
   */
  start: number;
  end: number;
  quote: string;
}
export interface AgentChangeMemoryInput_MemoryMetadata {
  kind: AgentChangeMemoryInput_MemoryKind;
  statement: AgentChangeMemoryInput_MemoryStatement;
  temporal: AgentChangeMemoryInput_MemoryTemporal;
}
export interface AgentChangeMemoryInput_MemoryResolution {
  sessionId: string;
  model: AgentChangeMemoryInput_ModelSelection;
}
/**
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentChangeMemoryInput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
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
export interface AgentCodeDefinitionInput_WorkspacePath {
  bytesBase64: string;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeDefinitionInput_AgentCodePosition {
  line: number;
  column: number;
}
export interface AgentCodeDefinitionOutput_AgentCodeRange {
  start: AgentCodeDefinitionOutput_AgentCodePosition;
  end: AgentCodeDefinitionOutput_AgentCodePosition;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeDefinitionOutput_AgentCodePosition {
  line: number;
  column: number;
}
export interface AgentCodeDefinitionOutput_AgentCodeLocation {
  path: AgentCodeDefinitionOutput_WorkspacePath;
  range: AgentCodeDefinitionOutput_AgentCodeRange;
  preview: string;
}
export interface AgentCodeDefinitionOutput_WorkspacePath {
  bytesBase64: string;
}
export interface AgentCodeHoverInput_WorkspacePath {
  bytesBase64: string;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeHoverInput_AgentCodePosition {
  line: number;
  column: number;
}
export interface AgentCodeHoverOutput_AgentCodeHoverResult {
  backend: AgentCodeHoverOutput_AgentCodeBackend;
  symbol: string;
  range: AgentCodeHoverOutput_AgentCodeRange | null;
  markdown: string;
}
export interface AgentCodeHoverOutput_AgentCodeRange {
  start: AgentCodeHoverOutput_AgentCodePosition;
  end: AgentCodeHoverOutput_AgentCodePosition;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeHoverOutput_AgentCodePosition {
  line: number;
  column: number;
}
export interface AgentCodeReferencesInput_WorkspacePath {
  bytesBase64: string;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeReferencesInput_AgentCodePosition {
  line: number;
  column: number;
}
export interface AgentCodeReferencesOutput_AgentCodeLocation {
  path: AgentCodeReferencesOutput_WorkspacePath;
  range: AgentCodeReferencesOutput_AgentCodeRange;
  preview: string;
}
export interface AgentCodeReferencesOutput_WorkspacePath {
  bytesBase64: string;
}
export interface AgentCodeReferencesOutput_AgentCodeRange {
  start: AgentCodeReferencesOutput_AgentCodePosition;
  end: AgentCodeReferencesOutput_AgentCodePosition;
}
/**
 * Zero-based line and UTF-16 code-unit column, matching LSP and NSH Editor positions.
 */
export interface AgentCodeReferencesOutput_AgentCodePosition {
  line: number;
  column: number;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentCreatePresetOutput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentDeleteGitHubTokenOutput_AgentGitHubAuthStatus {
  host: string;
  authenticated: boolean;
  tokenSource: AgentDeleteGitHubTokenOutput_AgentGitHubTokenSource | null;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentDeletePresetOutput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentExternalUsageLimitsOutput_UsageQuantity {
  used: number;
  limit: number;
  unit?: string | null;
}
export interface AgentGitCompareOutput_AgentGitCompare {
  baseOid: string | null;
  headOid: string;
  entries: AgentGitCompareOutput_AgentGitCompareEntry[];
  patch: AgentGitCompareOutput_GitWorkspaceDiff | null;
}
export interface AgentGitCompareOutput_AgentGitCompareEntry {
  path: AgentGitCompareOutput_WorkspacePath;
  kind: AgentGitCompareOutput_GitChangeKind;
  digest: string;
}
export interface AgentGitCompareOutput_WorkspacePath {
  bytesBase64: string;
}
export interface AgentGitCompareOutput_GitWorkspaceDiff {
  patch: string;
  truncated: boolean;
  skippedFiles: number;
}
export interface AgentGitCompareDiffInput_WorkspacePath {
  bytesBase64: string;
}
export interface AgentGitRevisionsOutput_AgentGitRevisions {
  headBranch: string | null;
  headOid: string | null;
  defaultBase: string | null;
  branches: AgentGitRevisionsOutput_AgentGitBranchEntry[];
  commits: AgentGitRevisionsOutput_AgentGitCommitSummary[];
  remotes: AgentGitRevisionsOutput_AgentGitRemoteRepo[];
  worktrees: AgentGitRevisionsOutput_AgentGitWorktreeEntry[];
}
export interface AgentGitRevisionsOutput_AgentGitBranchEntry {
  name: string;
  oid: string;
  remote: boolean;
}
export interface AgentGitRevisionsOutput_AgentGitCommitSummary {
  oid: string;
  shortOid: string;
  summary: string;
  author: string;
  timestamp: number;
}
export interface AgentGitRevisionsOutput_AgentGitRemoteRepo {
  remote: string;
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGitRevisionsOutput_AgentGitWorktreeEntry {
  path: string;
  name: string;
  branch: string | null;
  headOid: string | null;
  isCurrent: boolean;
  isMain: boolean;
}
export interface AgentGitWorkspaceDiffOutput_GitWorkspaceDiff {
  patch: string;
  truncated: boolean;
  skippedFiles: number;
}
export interface AgentGithubCommentPullRequestInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubCommentPullRequestOutput_AgentGitHubReviewComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}
export interface AgentGithubPullRequestDetailInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubPullDetail {
  repo: AgentGithubPullRequestDetailOutput_AgentGitHubRepoRef;
  auth: AgentGithubPullRequestDetailOutput_AgentGitHubAuthStatus;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  merged: boolean;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  htmlUrl: string;
  files: AgentGithubPullRequestDetailOutput_AgentGitHubPullFile[];
  threads: AgentGithubPullRequestDetailOutput_AgentGitHubReviewThread[];
  reviews: AgentGithubPullRequestDetailOutput_AgentGitHubReviewSummary[];
  issueComments: AgentGithubPullRequestDetailOutput_AgentGitHubReviewComment[];
  patch: AgentGithubPullRequestDetailOutput_GitWorkspaceDiff | null;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubAuthStatus {
  host: string;
  authenticated: boolean;
  tokenSource: AgentGithubPullRequestDetailOutput_AgentGitHubTokenSource | null;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubPullFile {
  path: string;
  previousPath: string | null;
  status: AgentGithubPullRequestDetailOutput_AgentGitHubPullFileStatus;
  additions: number;
  deletions: number;
  digest: string;
  hasPatch: boolean;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubReviewThread {
  id: number;
  path: string;
  side: AgentGithubPullRequestDetailOutput_AgentGitHubDiffSide;
  line: number | null;
  startLine: number | null;
  outdated: boolean;
  diffHunk: string;
  comments: AgentGithubPullRequestDetailOutput_AgentGitHubReviewComment[];
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubReviewComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}
export interface AgentGithubPullRequestDetailOutput_AgentGitHubReviewSummary {
  id: number;
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}
export interface AgentGithubPullRequestDetailOutput_GitWorkspaceDiff {
  patch: string;
  truncated: boolean;
  skippedFiles: number;
}
export interface AgentGithubPullRequestFileDiffInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubPullRequestsInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubPullRequestsOutput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubPullRequestsOutput_AgentGitHubAuthStatus {
  host: string;
  authenticated: boolean;
  tokenSource: AgentGithubPullRequestsOutput_AgentGitHubTokenSource | null;
}
export interface AgentGithubPullRequestsOutput_AgentGitHubPullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  updatedAt: string;
  htmlUrl: string;
}
export interface AgentGithubReplyCommentInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubReplyCommentOutput_AgentGitHubReviewComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}
export interface AgentGithubSubmitReviewInput_AgentGitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}
export interface AgentGithubSubmitReviewInput_AgentGitHubDraftReviewComment {
  path: string;
  side: AgentGithubSubmitReviewInput_AgentGitHubDiffSide;
  line: number;
  startLine?: number | null;
  startSide?: AgentGithubSubmitReviewInput_AgentGitHubDiffSide | null;
  body: string;
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
  retry?: AgentHistoryRequestsOutput_AgentHistoryRequestRetry | null;
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
 * The exact assertion and management revision admitted to a Run, in projection order.
 */
export interface AgentLoadedMemoriesOutput_LoadedMemory {
  scope: string;
  id: string;
  revision: number;
  assertion: number;
}
/**
 * Most recent discovery association added after a Bot message was published.
 */
export interface AgentMarkBotReadOutput_AgentBotDiscoveryLink {
  revision: number;
  messageId: string;
  turnId?: string | null;
  discovery: AgentMarkBotReadOutput_AgentDiscoveryPublication;
}
export interface AgentMarkBotReadOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
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
export interface AgentMemoriesOutput_MemoryRecord {
  assertion: number;
  id: string;
  revision: number;
  mode: AgentMemoriesOutput_MemoryMode;
  state: AgentMemoriesOutput_MemoryState;
  body: string;
  metadata: AgentMemoriesOutput_MemoryMetadata;
  createdAt: number;
  modifiedAt: number;
}
export interface AgentMemoriesOutput_MemoryMetadata {
  kind: AgentMemoriesOutput_MemoryKind;
  statement: AgentMemoriesOutput_MemoryStatement;
  temporal: AgentMemoriesOutput_MemoryTemporal;
}
export interface AgentMemoryOutput_MemoryRecord {
  assertion: number;
  id: string;
  revision: number;
  mode: AgentMemoryOutput_MemoryMode;
  state: AgentMemoryOutput_MemoryState;
  body: string;
  metadata: AgentMemoryOutput_MemoryMetadata;
  createdAt: number;
  modifiedAt: number;
}
export interface AgentMemoryOutput_MemoryMetadata {
  kind: AgentMemoryOutput_MemoryKind;
  statement: AgentMemoryOutput_MemoryStatement;
  temporal: AgentMemoryOutput_MemoryTemporal;
}
export interface AgentMemoryEvidenceOutput_MemoryEvidence {
  id: number;
  source: AgentMemoryEvidenceOutput_MemorySource;
}
export interface AgentMemoryEvidenceOutput_MemoryEvidenceReference {
  sessionId: string;
  sequence: number;
  itemIndex: number;
  factId: string;
  fingerprint: string;
  /**
   * UTF-8 byte offsets into the immutable message text.
   */
  start: number;
  end: number;
  quote: string;
}
export interface AgentMemoryHistoryOutput_MemoryVersion {
  revision: number;
  body: string;
  metadata: AgentMemoryHistoryOutput_MemoryMetadata;
  source: AgentMemoryHistoryOutput_MemorySource;
  generation: AgentMemoryHistoryOutput_MemoryGeneration;
  corrects?: number | null;
}
export interface AgentMemoryHistoryOutput_MemoryMetadata {
  kind: AgentMemoryHistoryOutput_MemoryKind;
  statement: AgentMemoryHistoryOutput_MemoryStatement;
  temporal: AgentMemoryHistoryOutput_MemoryTemporal;
}
export interface AgentMemoryHistoryOutput_MemoryEvidenceReference {
  sessionId: string;
  sequence: number;
  itemIndex: number;
  factId: string;
  fingerprint: string;
  /**
   * UTF-8 byte offsets into the immutable message text.
   */
  start: number;
  end: number;
  quote: string;
}
export interface AgentPendingMemoriesOutput_MemoryRecord {
  assertion: number;
  id: string;
  revision: number;
  mode: AgentPendingMemoriesOutput_MemoryMode;
  state: AgentPendingMemoriesOutput_MemoryState;
  body: string;
  metadata: AgentPendingMemoriesOutput_MemoryMetadata;
  createdAt: number;
  modifiedAt: number;
}
export interface AgentPendingMemoriesOutput_MemoryMetadata {
  kind: AgentPendingMemoriesOutput_MemoryKind;
  statement: AgentPendingMemoriesOutput_MemoryStatement;
  temporal: AgentPendingMemoriesOutput_MemoryTemporal;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentPresetOutput_ModelSelection {
  serviceTier?: string | null;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentPresetsOutput_ModelSelection {
  serviceTier?: string | null;
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
export interface AgentReadFileInput_WorkspacePath {
  bytesBase64: string;
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
export interface AgentReconcileMemoriesInput_MemoryWrite {
  edit: AgentReconcileMemoriesInput_MemoryEdit;
  /**
   * A verified conversation source grants automatic extraction authority only.
   */
  evidence?: AgentReconcileMemoriesInput_MemoryEvidenceReference | null;
}
export interface AgentReconcileMemoriesInput_MemoryEvidenceReference {
  sessionId: string;
  sequence: number;
  itemIndex: number;
  factId: string;
  fingerprint: string;
  /**
   * UTF-8 byte offsets into the immutable message text.
   */
  start: number;
  end: number;
  quote: string;
}
export interface AgentReconcileMemoriesInput_MemoryMetadata {
  kind: AgentReconcileMemoriesInput_MemoryKind;
  statement: AgentReconcileMemoriesInput_MemoryStatement;
  temporal: AgentReconcileMemoriesInput_MemoryTemporal;
}
export interface AgentReconcileMemoriesInput_MemoryResolution {
  sessionId: string;
  model: AgentReconcileMemoriesInput_ModelSelection;
}
/**
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentReconcileMemoriesInput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
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
  consistency: AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentRestoreSessionCheckpointOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentRestoreSessionCheckpointOutput_AgentHistoryCheckpointObject;
}
export interface AgentRoomSearchOutput_AgentRoomSearchMatch {
  message: AgentRoomSearchOutput_AgentRoomMessage;
  snippet: string;
}
export interface AgentRoomSearchOutput_AgentRoomMessage {
  id: string;
  sequence: number;
  at: number;
  author: AgentRoomSearchOutput_AgentRoomAuthor;
  content: AgentRoomSearchOutput_AgentRoomContent;
  replyTo?: string | null;
  mentions: string[];
  deliveries: AgentRoomSearchOutput_RoomDelivery[];
  editedAt?: number | null;
  deletedAt?: number | null;
  reactions?: AgentRoomSearchOutput_AgentRoomReaction[];
  pinned?: boolean;
  deliveryStates?: AgentRoomSearchOutput_AgentRoomDeliveryState[];
}
export interface AgentRoomSearchOutput_ExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: AgentRoomSearchOutput_RunId;
}
export interface AgentRoomSearchOutput_AgentRoomContent {
  text: string;
  attachments: AgentRoomSearchOutput_AgentHistoryAttachment[];
}
export interface AgentRoomSearchOutput_AgentHistoryAttachment {
  name: string;
  mimeType: string;
  bytes: number;
  kind: AgentRoomSearchOutput_AttachmentKind;
}
export interface AgentRoomSearchOutput_AgentRoomReaction {
  emoji: string;
  actors: AgentRoomSearchOutput_AgentRoomActor[];
}
export interface AgentSaveGitHubTokenOutput_AgentGitHubAuthStatus {
  host: string;
  authenticated: boolean;
  tokenSource: AgentSaveGitHubTokenOutput_AgentGitHubTokenSource | null;
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
  consistency: AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceConsistency;
  warning: AgentSessionCheckpointRestoreReceiptOutput_AgentCheckpointWorkspaceWarning;
  inventory: AgentSessionCheckpointRestoreReceiptOutput_AgentHistoryCheckpointObject;
}
export interface AgentSessionCreateInput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionCreateInput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionCreateInput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionCreateInput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSessionCreateInput_AgentSessionForkFrom {
  sessionId: string;
  /**
   * Optional turn boundary to fork through; defaults to the end of the source Session.
   */
  turnId?: string | null;
  expectedRevision?: number | null;
}
export interface AgentSessionListOutput_AgentSessionSummary {
  id: string;
  kind: AgentSessionListOutput_AgentSessionKind;
  title: string;
  activity: AgentSessionListOutput_AgentSessionActivity;
  workspacePath: string;
  worktreeDirectory?: string | null;
  parentSessionId?: string | null;
  presetName?: string | null;
  backend?: AgentSessionListOutput_AgentBackendPreference | null;
  permissions: AgentSessionListOutput_AgentWorkspacePermissions;
  labels?: string[];
  pinned: boolean;
  archived: boolean;
  revision: number;
  updatedAt: number;
}
export interface AgentSessionListOutput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionListOutput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionListOutput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionListOutput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSessionListOutput_AgentWorkspacePermissions {
  access: AgentSessionListOutput_AgentWorkspaceAccess;
  requestPermissions: boolean;
}
/**
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentSessionManageInput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface AgentSessionManageOutput_AgentSessionSummary {
  id: string;
  kind: AgentSessionManageOutput_AgentSessionKind;
  title: string;
  activity: AgentSessionManageOutput_AgentSessionActivity;
  workspacePath: string;
  worktreeDirectory?: string | null;
  parentSessionId?: string | null;
  presetName?: string | null;
  backend?: AgentSessionManageOutput_AgentBackendPreference | null;
  permissions: AgentSessionManageOutput_AgentWorkspacePermissions;
  labels?: string[];
  pinned: boolean;
  archived: boolean;
  revision: number;
  updatedAt: number;
}
export interface AgentSessionManageOutput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionManageOutput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionManageOutput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionManageOutput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSessionManageOutput_AgentWorkspacePermissions {
  access: AgentSessionManageOutput_AgentWorkspaceAccess;
  requestPermissions: boolean;
}
/**
 * Stable logical Run receipt, independent of activations and the current Session tip.
 */
export interface AgentSessionManageOutput_AgentExecution {
  sessionId: string;
  turnId: string;
  runId: AgentSessionManageOutput_RunId;
  /**
   * Run-local event count, not the root-global transcript cursor.
   */
  highWater: number;
  state: AgentSessionManageOutput_AgentExecutionState;
}
export interface AgentSessionManageOutput_ToolKey {
  attempt: AgentSessionManageOutput_ModelAttemptId;
  call: string;
}
export interface AgentSessionManageOutput_ExternalPublicationKey {
  publication: AgentSessionManageOutput_ExternalPublicationId;
  index: number;
}
export interface AgentSessionManageOutput_RecoveryRef {
  source: AgentSessionManageOutput_DeploymentRef;
  namespace: AgentSessionManageOutput_InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: AgentSessionManageOutput_RecoveryContract;
  recovery: AgentSessionManageOutput_RecoveryProtocol;
}
export interface AgentSessionManageOutput_DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface AgentSessionManageOutput_RecoveryContract {
  name: string;
  version: number;
  transport: AgentSessionManageOutput_Transport;
  digest: string;
}
export interface AgentSessionManageOutput_ContentRef {
  digest: string;
  bytes: number;
}
export interface AgentSessionManageOutput_AgentRoomMessage {
  id: string;
  sequence: number;
  at: number;
  author: AgentSessionManageOutput_AgentRoomAuthor;
  content: AgentSessionManageOutput_AgentRoomContent;
  replyTo?: string | null;
  mentions: string[];
  deliveries: AgentSessionManageOutput_RoomDelivery[];
  editedAt?: number | null;
  deletedAt?: number | null;
  reactions?: AgentSessionManageOutput_AgentRoomReaction[];
  pinned?: boolean;
  deliveryStates?: AgentSessionManageOutput_AgentRoomDeliveryState[];
}
export interface AgentSessionManageOutput_ExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: AgentSessionManageOutput_RunId;
}
export interface AgentSessionManageOutput_AgentRoomContent {
  text: string;
  attachments: AgentSessionManageOutput_AgentHistoryAttachment[];
}
export interface AgentSessionManageOutput_AgentHistoryAttachment {
  name: string;
  mimeType: string;
  bytes: number;
  kind: AgentSessionManageOutput_AttachmentKind;
}
export interface AgentSessionManageOutput_AgentRoomReaction {
  emoji: string;
  actors: AgentSessionManageOutput_AgentRoomActor[];
}
export interface AgentSessionReadInput_AgentSessionRowLookup {
  through?: number | null;
  position: AgentSessionReadInput_HistoryRowAddress;
  field?: AgentSessionReadInput_HistoryField & string;
}
export interface AgentSessionReadOutput_AgentSessionSummary {
  id: string;
  kind: AgentSessionReadOutput_AgentSessionKind;
  title: string;
  activity: AgentSessionReadOutput_AgentSessionActivity;
  workspacePath: string;
  worktreeDirectory?: string | null;
  parentSessionId?: string | null;
  presetName?: string | null;
  backend?: AgentSessionReadOutput_AgentBackendPreference | null;
  permissions: AgentSessionReadOutput_AgentWorkspacePermissions;
  labels?: string[];
  pinned: boolean;
  archived: boolean;
  revision: number;
  updatedAt: number;
}
export interface AgentSessionReadOutput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionReadOutput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionReadOutput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionReadOutput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSessionReadOutput_AgentWorkspacePermissions {
  access: AgentSessionReadOutput_AgentWorkspaceAccess;
  requestPermissions: boolean;
}
export interface AgentSessionReadOutput_AgentSessionRunOverview {
  runId: AgentSessionReadOutput_RunId;
  state: string;
  stopped: boolean;
  error?: string | null;
  blockers?: string[];
}
export interface AgentSessionReadOutput_InteractionRecord {
  execution: AgentSessionReadOutput_ExecutionIdentity;
  requestId: string;
  createdAt: number;
  request: AgentSessionReadOutput_InteractionRequest;
  outcome: AgentSessionReadOutput_InteractionOutcome | null;
}
export interface AgentSessionReadOutput_ExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: AgentSessionReadOutput_RunId;
}
/**
 * Captured authority, never silently upgraded by resolving a current binding.
 */
export interface AgentSessionReadOutput_PermissionBasis {
  boundaryRevision: number;
  binding: AgentSessionReadOutput_BindingStamp;
}
export interface AgentSessionReadOutput_BindingStamp {
  id: string;
  permissionEpoch: number;
}
export interface AgentSessionReadOutput_Permissions {
  filesystem: AgentSessionReadOutput_Rule[];
  network: AgentSessionReadOutput_Network;
}
/**
 * Paths have executor-native meaning. Validate and materialize them on the
 * execution host, never on a remote Desktop. This document alone grants nothing.
 */
export interface AgentSessionReadOutput_Rule {
  path: string;
  scope: AgentSessionReadOutput_Scope;
  access: AgentSessionReadOutput_Access;
}
/**
 * Destination authority, independent of the upstream proxy used to reach it.
 * A domain grant does not authorize its subdomains or other ports.
 */
export interface AgentSessionReadOutput_Destination {
  host: string;
  port: number;
}
export interface AgentSessionReadOutput_ToolKey {
  attempt: AgentSessionReadOutput_ModelAttemptId;
  call: string;
}
export interface AgentSessionReadOutput_PermissionRequest {
  reason: string;
  command?: AgentSessionReadOutput_PermissionCommand | null;
  permissions: AgentSessionReadOutput_Permissions;
  /**
   * Network access granted for this request covers only later requests from
   * the same source; filesystem access covers all of them. Requests stored
   * before sources were recorded decode as Web, the only source that could
   * be granted network access then.
   */
  source?: AgentSessionReadOutput_PermissionSource & string;
}
export interface AgentSessionReadOutput_PermissionCommand {
  command: string;
  cwd: string;
}
export interface AgentSessionReadOutput_InteractionQuestion {
  question: string;
  /**
   * @minItems 2
   * @maxItems 3
   */
  options:
    | [AgentSessionReadOutput_QuestionOption, AgentSessionReadOutput_QuestionOption]
    | [
        AgentSessionReadOutput_QuestionOption,
        AgentSessionReadOutput_QuestionOption,
        AgentSessionReadOutput_QuestionOption,
      ];
}
export interface AgentSessionReadOutput_QuestionOption {
  label: string;
  description?: string;
}
export interface AgentSessionReadOutput_FormRequester {
  name: string;
  source?: string | null;
}
export interface AgentSessionReadOutput_FormOption {
  value: string;
  label: string;
}
export interface AgentSessionReadOutput_GrantTarget {
  providerId: string;
  contractId: string;
  serverId: string;
  toolName: string;
  capability: AgentSessionReadOutput_GrantCapability;
  scope: AgentSessionReadOutput_GrantScope;
  [k: string]: unknown | undefined;
}
export interface AgentSessionReadOutput_ComputerAppDisplay {
  name: string;
  appPath: string;
  risk?: AgentSessionReadOutput_ComputerAppRisk | null;
  warning?: string | null;
}
export interface AgentSessionReadOutput_SystemPermissionApplicationLocation {
  fileUrl: string;
  stateDomain: string;
}
export interface AgentSessionReadOutput_AgentQueuedMessageOverview {
  messageId: string;
  text: string;
  editableByCaller: boolean;
}
export interface AgentSessionReadOutput_AgentRoomOverview {
  topic?: string;
  members?: AgentSessionReadOutput_AgentRoomMember[];
  pinnedMessageIds?: string[];
}
export interface AgentSessionReadOutput_AgentRoomMember {
  sessionId: string;
  title: string;
  presetName?: string | null;
  workspacePath: string;
  activity: AgentSessionReadOutput_AgentRoomParticipantActivity;
  pendingInteractions?: number;
  archived?: boolean;
  unavailable?: boolean;
  addedAt?: number | null;
}
export interface AgentSessionReadOutput_AgentTranscriptEntry {
  role: string;
  turnId?: string | null;
  messageId?: string | null;
  toolName?: string | null;
  status?: string | null;
  /**
   * Pass to Read({ path }) to inspect the full output of this tool call.
   */
  resultPath?: string | null;
  offset?: number | null;
  totalBytes?: number | null;
  text: string;
}
export interface AgentSessionReadOutput_AgentRoomPostEntry {
  id: string;
  sequence: number;
  at: number;
  author: AgentSessionReadOutput_AgentRoomAuthor;
  authorName?: string | null;
  text: string;
  attachments?: AgentSessionReadOutput_AgentRoomAttachmentEntry[];
  replyTo?: string | null;
  mentions?: string[];
  deliveries?: AgentSessionReadOutput_RoomDelivery[];
  deliveryStates?: AgentSessionReadOutput_AgentRoomDeliveryState[];
  reactions?: AgentSessionReadOutput_AgentRoomReaction[];
  pinned?: boolean;
  editedAt?: number | null;
  deleted?: boolean;
}
export interface AgentSessionReadOutput_AgentRoomAttachmentEntry {
  name: string;
  mimeType: string;
  bytes: number;
  kind: AgentSessionReadOutput_AttachmentKind;
  /**
   * Pass directly to Read({ path }) to inspect this Room attachment.
   */
  resourcePath?: string | null;
}
export interface AgentSessionReadOutput_AgentRoomReaction {
  emoji: string;
  actors: AgentSessionReadOutput_AgentRoomActor[];
}
export interface AgentSessionSendInput_AgentExecutorSelection {
  executor: string;
  settings: AgentSessionSendInput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSessionSendInput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSessionSendInput_ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentSetProjectMcpDecisionInput_AgentWorkspace {
  /**
   * Native owner allocation; never accepted from a caller as workspace authority.
   */
  worktree?: AgentSetProjectMcpDecisionInput_Binding | null;
  /**
   * Optional membership in this Agent's canonical Project catalog.
   */
  projectId?: string | null;
  path: string;
}
/**
 * Immutable allocation intent, not the current child branch or HEAD.
 */
export interface AgentSetProjectMcpDecisionInput_Binding {
  id: string;
  common_dir: string;
  source: string;
  base_commit: string;
  directory: string;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentUpdatePresetInput_ModelSelection {
  serviceTier?: string | null;
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
 * Selected model and optional service tier, resolved from the connection at admission.
 */
export interface AgentUpdatePresetOutput_ModelSelection {
  serviceTier?: string | null;
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
/**
 * Most recent discovery association added after a Bot message was published.
 */
export interface AgentWatchBotOutboxOutput_AgentBotDiscoveryLink {
  revision: number;
  messageId: string;
  turnId?: string | null;
  discovery: AgentWatchBotOutboxOutput_AgentDiscoveryPublication;
}
export interface AgentWatchBotOutboxOutput_AgentDiscoveryPublication {
  recordId: string;
  workerSessionId: string;
  workerTurnId: string;
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
export interface SettingsAssistantPreferencesOutput_MemoryPolicy {
  enabled: boolean;
  agentReadEnabled: boolean;
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
export interface SettingsDictationConnectionsOutput_DictationConnection {
  basis: SettingsDictationConnectionsOutput_ConnectionVersionBasis;
  name: string;
  [k: string]: unknown | undefined;
}
export interface SettingsDictationConnectionsOutput_ConnectionVersionBasis {
  connectionId: string;
  revision: number;
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
export interface SettingsUsageOutput_ExternalEffectKey {
  task: SettingsUsageOutput_ExternalTaskId;
  operation: string;
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
}
