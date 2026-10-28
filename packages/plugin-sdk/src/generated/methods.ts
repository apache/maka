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

export type AgentCompactOutput_AgentExecutionState =
  | 'admitted'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type AgentCompactOutput_AgentCompactRejection =
  | 'busy'
  | 'closed'
  | 'archived'
  | 'backend_unavailable'
  | 'workspace_changed';
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
export type AgentSkillCandidatesInput_AgentSkillCandidatesBackend =
  | {
      kind: 'model';
      model: AgentSkillCandidatesInput_ModelSelection;
      thinkingLevel?: AgentSkillCandidatesInput_ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentSkillCandidatesInput_AgentExecutorSelection;
    };
export type AgentSkillCandidatesInput_ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
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
/**
 * A physical model call or tool attempt, never copied conversation membership.
 */
export type SettingsUsageOutput_UsageActivity =
  | {
      kind: 'model';
      attempt: SettingsUsageOutput_UsageModelAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'tool';
      attempt: SettingsUsageOutput_UsageToolAttempt;
      [k: string]: unknown | undefined;
    };
export type SettingsUsageOutput_UsageOrigin =
  | {
      kind: 'agent';
      invocation: SettingsUsageOutput_Invocation;
      purpose: SettingsUsageOutput_ModelPurpose;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'auxiliary';
      source: SettingsUsageOutput_UsageAuxiliarySource;
      [k: string]: unknown | undefined;
    };
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
      invocation: SettingsUsageOutput_Invocation;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent';
      invocation: SettingsUsageOutput_Invocation;
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
export type SettingsUsageOutput_ToolOrigin =
  | {
      kind: 'provider';
      step_id: string;
    }
  | {
      kind: 'code_mode';
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'code_cell';
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'standalone';
    }
  | {
      kind: 'host_sdk';
      package_id: string;
      entry_id: string;
      activation: string;
      parent_operation_id: string | null;
      parent_relationship?: SettingsUsageOutput_HostSdkRelationship | null;
    };
export type SettingsUsageOutput_HostSdkRelationship = {
  kind: 'evaluation_observer';
  epoch: string;
};
export type SettingsUsageOutput_UsageToolResult =
  | {
      kind: 'rejected';
      reason: SettingsUsageOutput_RejectionKind;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'settled';
      startedAt: number;
      outcome: SettingsUsageOutput_UsageToolStatus;
      [k: string]: unknown | undefined;
    };
/**
 * Refusal category without input-derived explanation text.
 */
export type SettingsUsageOutput_RejectionKind =
  | 'unavailable'
  | 'invalid_input'
  | 'policy_denied'
  | 'preparation_failed'
  | 'exclusive_conflict'
  | 'cancelled';
export type SettingsUsageOutput_UsageToolStatus = 'success' | 'error' | 'unknown';
/**
 * Breakdown selected for a bounded summary page.
 */
export type SettingsUsageSummaryOutput_UsageGroup = 'byProvider' | 'byModel' | 'byTool';
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
    changePlan: {
      mode: 'mutation';
      input: Runtime.AgentPlanChange;
      output: Runtime.AgentPlanResult;
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
    compact: {
      mode: 'mutation';
      input: {
        sessionId: string;
        model: Runtime.ModelSelection;
        thinkingLevel?: Runtime.ThinkingLevel | null;
        /**
         * One invocation only; omission uses the global preference.
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
    create: {
      mode: 'mutation';
      input: Runtime.AgentCreate;
      output: Runtime.AgentCreated;
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
    execute: {
      mode: 'mutation';
      input: Runtime.AgentExecute;
      output: Runtime.AgentSendResult;
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
    goalReceipt: {
      mode: 'query';
      input: Runtime.AgentGoalReceiptRead;
      output: Runtime.AgentGoalResult | null;
    };
    history: {
      mode: 'query';
      input: Runtime.AgentHistoryRead;
      output: Runtime.AgentHistoryPage;
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
    markRead: {
      mode: 'mutation';
      input: Runtime.AgentMarkRead;
      output: Runtime.AgentMarkReadResult;
    };
    metadata: {
      mode: 'mutation';
      input: Runtime.AgentMetadata;
      output: Runtime.AgentMetadataResult;
    };
    observe: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentObservation;
    };
    pendingInteractions: {
      mode: 'query';
      input: Runtime.AgentSessionRead;
      output: Runtime.AgentPendingInteractions;
    };
    plan: {
      mode: 'query';
      input: Runtime.AgentPlanRead;
      output: Runtime.AgentPlanView;
    };
    planHistory: {
      mode: 'query';
      input: Runtime.AgentPlanHistoryRead;
      output: Runtime.AgentPlanHistory;
    };
    planReceipt: {
      mode: 'query';
      input: Runtime.AgentPlanReceiptRead;
      output: Runtime.AgentPlanResult | null;
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
            patch: Runtime.AgentWorkspacePatch;
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
    respond: {
      mode: 'mutation';
      input: Runtime.AgentInteractionRespond;
      output: Runtime.AgentInteractionResult;
    };
    resume: {
      mode: 'mutation';
      input: Runtime.AgentResume;
      output: Runtime.AgentResumeResult;
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
    send: {
      mode: 'mutation';
      input: Runtime.AgentSend;
      output: Runtime.AgentSendResult;
    };
    skillCandidates: {
      mode: 'query';
      /**
       * Read-only suggestions resolved against the session's actual skill context.
       */
      input: {
        sessionId: string;
        backend: AgentSkillCandidatesInput_AgentSkillCandidatesBackend;
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
      output: Runtime.AgentPatchResult;
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
    watchPlan: {
      mode: 'subscription';
      input: Runtime.AgentPlanRead;
      output: Runtime.AgentPlanView;
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
  };
  settings: {
    assistantPreferences: {
      mode: 'query';
      input: {};
      output: {
        language: Runtime.LanguagePreference | null;
        resolvedLanguage: Runtime.Language;
        compactionPrompt: string;
        defaultCompactionPrompt: string;
        revision: number;
        displayName: string;
        workspaceInstructions: boolean;
        incognitoActive: boolean;
        shellTitles: boolean;
      };
    };
    connection: {
      mode: 'query';
      input: {
        connectionId: string;
        revision: number;
        /**
         * Opt in to the complete editing projection; credential reads stay narrow.
         */
        includeEditingFacts?: boolean;
      };
      output: Runtime.SettingsConnectionDetail;
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
}
/**
 * Canonical physical execution receipt, independent of the current Session tip.
 */
export interface AgentCompactOutput_AgentExecution {
  sessionId: string;
  turnId: string;
  runId: string;
  invocationId: string;
  /**
   * Run-local event count, not the root-global transcript cursor.
   */
  highWater: number;
  state: AgentCompactOutput_AgentExecutionState;
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
/**
 * Exact public selection observed by a caller, checked once at run admission.
 */
export interface AgentSkillCandidatesInput_ModelSelection {
  connectionId: string;
  revision: number;
  modelId: string;
}
export interface AgentSkillCandidatesInput_AgentExecutorSelection {
  executor: string;
  settings: AgentSkillCandidatesInput_ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface AgentSkillCandidatesInput_ExecutorSettings {
  model?: string | null;
  thinkingLevel?: AgentSkillCandidatesInput_ThinkingLevel | null;
}
export interface AgentSkillCandidatesOutput_AgentSkillCandidate {
  reference: string;
  name: string;
  description: string;
  invocation: string;
  [k: string]: unknown | undefined;
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
   * Public adapter contribution name; omitted selects the wire's default.
   */
  adapter?: string;
  /**
   * Omitted means model-specific defaults; false is an explicit opt-out.
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
  stateDomain: string;
  /**
   * @minItems 8
   * @maxItems 8
   */
  partitions: [number, number, number, number, number, number, number, number];
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
export interface SettingsUsageOutput_Invocation {
  session_id: string;
  turn_id: string;
  run_id: string;
  invocation_id: string;
  [k: string]: unknown | undefined;
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
export interface SettingsUsageOutput_UsageToolAttempt {
  requestId: string;
  invocation: SettingsUsageOutput_Invocation;
  call: SettingsUsageOutput_ToolCallIdentity;
  name: string;
  binding: SettingsUsageOutput_ModelBinding | null;
  completedAt: number;
  result: SettingsUsageOutput_UsageToolResult;
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
export interface SettingsUsageOutput_UsageActivityCursor {
  completedAt: number;
  partition: number;
  requestId: string;
}
export interface SettingsUsageSummaryOutput_UsageFence {
  stateDomain: string;
  /**
   * @minItems 8
   * @maxItems 8
   */
  partitions: [number, number, number, number, number, number, number, number];
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
  /**
   * None is the unknown-provider group, not the beginning of pagination.
   */
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
