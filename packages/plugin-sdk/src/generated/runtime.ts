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

export type RuntimeProtocol =
  | ClientDraft
  | ClientDraftEdit
  | ClientDraftAttachment
  | ClientDraftKey
  | ClientDraftReference
  | ClientUploadReference
  | ClientOperation
  | HostLogRequest
  | HostLogPage
  | CompositionInput
  | Deployment
  | DeploymentRead
  | UiRead
  | UiWatch
  | UiInstance
  | UiCatalog
  | PackageInstall
  | PackageInstalled
  | DeploymentReplace
  | ManagedDeployment
  | DeploymentInstances
  | ManagedInstancesPage
  | InstanceSetEnabled
  | DeploymentDocument
  | DeploymentDocumentRead
  | InstanceSettingsRead
  | InstanceSettingsPage
  | InstanceConfigure
  | InstanceConfigureBatch
  | BindingCandidatesRead
  | BindingCandidatesPage
  | PackageSettingsRead
  | PackageSettingsPage
  | CompositionEdit
  | DeploymentDocumentChunk
  | ManagementResultForPackageInstalled
  | ManagementResultForDeploymentRef
  | PackageDeclaration
  | PackageRef
  | Contract
  | Import
  | Export
  | CallerIntent
  | AgentConfiguration
  | WorkspaceDecisionsApiConfiguration
  | DecisionsApiSet
  | DecisionsApiCredential
  | DecisionsApiUpdate
  | DecisionsEvaluation
  | DecisionsApiResult
  | WorkspaceWebConfiguration
  | WebCapture
  | WebCall_WebFetch
  | WebCall_WebQuery
  | WebSet
  | WebKey
  | WebUpdate
  | WebResult
  | WebProbe
  | WebEndpoint
  | AgentModelsRead
  | AgentModelsPage
  | AgentModelRead
  | AgentModelResult
  | AgentGlobalInstructionsRead
  | AgentGlobalInstructionsView
  | AgentGlobalInstructionsUpdate
  | AgentGlobalInstructionsUpdated
  | AgentExecutorsRead
  | AgentExecutors
  | AgentExternalAgentsRead
  | AgentExternalAgents
  | ExecutorExecute
  | AgentExecutorSetup
  | ExecutorSetupAction
  | ExecutorSetupResult
  | ExecutorSetupProgress
  | ComputerConfiguration
  | ComputerEvaluate
  | ComputerReplState
  | ComputerResult
  | ProtocolProcessLaunch
  | AcpExecutorConfiguration
  | ExecutorOutcome
  | ExecutorOutput
  | ProtocolProcessRun
  | ProtocolProcessInput
  | ProtocolProcessProgress
  | ProtocolProcessCompletion
  | ProtocolProcessWritten
  | AgentToolNames
  | AgentWorkRead
  | AgentWork
  | ModelSelection
  | SettingsModelsRead
  | SettingsUsageRead
  | SettingsUsagePage
  | SettingsUsageSummary
  | SettingsUsageSummaryRead
  | SettingsPricingResult
  | PricingQuery
  | PricingPage
  | PricingUpdate
  | SettingsAssistantPreferences
  | SettingsNetworkSnapshot
  | SettingsNetworkUpdate
  | SettingsNetworkUpdated
  | SettingsPreferencesUpdate
  | SettingsPreferencesUpdated
  | SettingsModelsPage
  | SettingsUpdateModelSettings
  | SettingsConnectionsRead
  | SettingsConnectionsPage
  | SettingsConnectionDetail
  | SettingsProvidersRead
  | SettingsProvidersPage
  | SettingsProvider
  | SettingsCredentialLogin
  | SettingsLoginPrompt
  | SettingsCredentialLoginResult
  | SettingsSaveCredential
  | SettingsCredentialSaveResult
  | CreateCatalogConnectionInput
  | UpdateCatalogConnectionInput
  | RemoveCatalogConnectionInput
  | CredentialVaultQueryInput
  | CredentialVaultQueryResult
  | DeleteCredentialInput
  | CredentialMutationResult
  | SetDefaultConnectionTargetInput
  | CatalogMutationResult
  | AgentMcpConfigurations
  | AgentMcpConfigurationList
  | AgentMcpConfigurationChange
  | AgentMcpConfigurationResult
  | SkillLibraryConfiguration
  | SkillLibraryList
  | SkillLibraryPage
  | SkillLibraryRead
  | SkillLibraryDocument
  | SkillLibraryDiscoverSource
  | SkillLibraryDiscoveredSource
  | SkillLibraryInstall
  | SkillLibraryInstallResult
  | SkillLibraryManageSkill
  | SkillLibraryChangeResult
  | SkillLibrarySetPreference
  | SkillLibraryPreferenceResult
  | SkillModelSearch
  | SkillModelLoad
  | SkillModelSearchResult
  | SkillModelLoadResult
  | SkillPrepare
  | SkillPreparation
  | SkillPreparationRecord
  | AgentList
  | AgentCreate
  | AgentGoalRead
  | AgentGoalView
  | AgentGoalChange
  | AgentGoalResult
  | AgentChecklistRead
  | AgentChecklist
  | AgentRecapRead
  | AgentRecapGenerate
  | AgentRecapReceipt
  | AgentScheduleRead
  | AgentSchedules
  | AgentScheduleChange
  | AgentScheduleResult
  | AgentScheduleAlerts
  | RecallQuery
  | AgentRecallPage
  | AgentImportsRead
  | AgentImportsPage
  | AgentImportChange
  | AgentImportResult
  | AgentProjectsRead
  | AgentProjectsPage
  | AgentProjectChange
  | AgentProjectResult
  | AgentCreated
  | AgentForkPosition
  | AgentFork
  | AgentForkResult
  | AgentForkReceipt
  | AgentForkReceiptResult
  | AgentSessionBranch
  | AgentDirectories
  | AgentDirectoryPage
  | AgentMetadata
  | AgentMetadataResult
  | AgentSelectBackend
  | AgentChangeSession
  | AgentSessionChanged
  | AgentSend
  | AgentStop
  | AgentExecutionRead
  | AgentExecutionResult
  | AgentContinueRun
  | AgentContinuationResult
  | AgentUploadAttachment
  | AgentAttachment
  | AgentAttachmentUploadResult
  | AgentMarkRead
  | AgentMarkReadResult
  | AgentWatch
  | AgentPendingInteractions
  | AgentInteractionRead
  | AgentInteractionRespond
  | AgentInteractionResult
  | QuestionAsk
  | FormAsk
  | FormResponse
  | WorkspaceProcessConfiguration
  | WorkspacePath
  | AgentContextRead
  | AgentContextReport
  | AgentContextRequest
  | AgentContextRequestState
  | PreparedContextBreakdown
  | ContextBucket
  | ContextCounts
  | AgentFileListRead
  | AgentFileCandidatesRead
  | AgentFileCandidates
  | AgentFileWatch
  | AgentFileCursor
  | AgentFilePage
  | AgentFileEntry
  | AgentFileKind
  | AgentFileChange
  | AgentFileUnavailable
  | GitArea
  | GitChangeKind
  | GitStatusEntry
  | GitStatus
  | GitDiff
  | AgentGitDiffRead
  | TerminalList
  | TerminalTarget
  | TerminalOutputRequest
  | TerminalOutputEvent
  | TerminalOutputUnavailable
  | TerminalOutcome_TerminalOutputEvent
  | TerminalStart
  | TerminalController
  | TerminalControl
  | TerminalPage
  | TerminalLeaseUpdate
  | TerminalControlReceipt
  | TerminalReleased
  | TerminalStopped
  | TerminalOutcome_TerminalPage
  | TerminalOutcome_ResourceUpdate
  | TerminalOutcome_TerminalLeaseUpdate
  | TerminalOutcome_TerminalControlReceipt
  | TerminalOutcome_TerminalReleased
  | TerminalOutcome_TerminalStopped
  | QuestionResult
  | InteractionRecord
  | AgentSession
  | AgentSessionPage
  | AgentSendResult
  | AgentStopped
  | AgentDelivery
  | AgentDeliveryFact
  | AgentContentKind
  | AgentObservation
  | AgentDiagnostics
  | AgentDiagnosticPage
  | AgentDiagnosticChange
  | AgentSessionRead
  | AgentHistoryRead
  | AgentHistoryLandmarksRead
  | AgentHistoryLandmarks
  | AgentHistoryLandmark
  | AgentHistoryPromptRead
  | AgentHistoryPrompt
  | AgentDeliveryPage
  | AgentQueue
  | AgentQueueMessage
  | AgentQueueMessageResult
  | AgentQueueMutation
  | AgentQueueMutationResult
  | AgentHistoryChunk
  | AgentHistoryPage
  | AgentHistorySearch
  | AgentHistorySearchPage
  | AgentHistorySourceRead
  | AgentHistorySourcePage
  | AgentToolImageFrame
  | AgentToolImageRead
  | AgentToolImagePage
  | AgentAttachmentImageRead
  | AgentAttachmentImageSource
  | AgentAttachmentImagePage
  | Read
  | HostActivation
  | HostRequest
  | HostObservation
  | OperationObservation
  | OperationReply
  | ResourceMetadata
  | StateRecord
  | StatePage;
/**
 * JavaScript epoch milliseconds, preserving fractional timestamps within Date's range.
 */
export type CaptureTime = number;
/**
 * Hierarchical, stable source keys. Display aliases never become data identities.
 */
export type InstanceId = string[];
export type Transport = 'local' | 'remote';
export type RecoveryProtocol = 'journal_v1';
/**
 * A caller's receipt observation, never an execution grant. Unavailable makes
 * no claim about the journal's contents or physical cleanup.
 */
export type Receipt =
  | {
      kind: 'not_recorded';
    }
  | {
      kind: 'recorded';
      outcome: OperationOutcome;
      cleanup: OperationCleanup;
    }
  | {
      kind: 'unavailable';
      diagnostic: string;
    };
/**
 * Unresolved and Unknown may advance to authoritative original evidence.
 * Returned and NotExecuted are immutable; handler errors are Returned too.
 */
export type OperationOutcome =
  | {
      kind: 'unresolved';
    }
  | {
      kind: 'returned';
      result: OperationResult;
    }
  | {
      kind: 'not_executed';
      proof: NotExecutedProof;
    }
  | {
      kind: 'unknown';
      diagnostic: string;
    };
/**
 * A definite handler return. Failure does not imply absence of side effects.
 */
export type OperationResult =
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
export type NotExecutedProof = {
  kind: 'provider_prevented_before_start';
};
export type OperationCleanup =
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
export type HostLogPosition =
  | {
      kind: 'tail';
    }
  | {
      kind: 'after';
      cursor: HostLogCursor;
    };
export type HostLogCursor = string;
export type HostLogPage =
  | {
      kind: 'missing';
    }
  | {
      kind: 'data';
      cursor: HostLogCursor;
      bytes: string;
      reset?: HostLogReset | null;
      truncated: boolean;
      hasMore: boolean;
    };
export type HostLogReset = 'replaced' | 'truncated';
export type PackageUse = 'host' | 'ui' | 'composition';
export type Target =
  | {
      kind: 'instance';
      path: string[];
      export: string;
    }
  | {
      kind: 'import';
      name: string;
    }
  | {
      kind: 'remote';
      deployment: string;
      instance: InstanceId;
      export: string;
    };
/**
 * Templates can select an entry in their own immutable package without a
 * self-referential content hash. Deployment roots must select a pinned revision.
 */
export type PackageSelection =
  | {
      source: 'pinned';
      package: PackageRef;
    }
  | {
      source: 'current';
    };
export type Interface =
  | {
      kind: 'service';
      methods: {
        [k: string]: Method | undefined;
      };
    }
  | {
      kind: 'value';
      schema: unknown;
    }
  | {
      kind: 'resource';
      resource: string;
      schema: unknown;
    };
export type MethodMode = 'query' | 'mutation' | 'subscription';
export type Availability = 'required' | 'optional';
export type UiContribution =
  | {
      kind: 'root';
    }
  | {
      kind: 'view';
      contract: string;
    }
  | {
      kind: 'panel';
      title: UiText;
    }
  | {
      kind: 'command';
      title: UiText;
      description?: UiText | null;
      shortcut?: string | null;
      order?: number | null;
      trigger?: string | null;
      takesArgument?: boolean;
      hint?: UiText | null;
    }
  | {
      kind: 'tool_renderer';
      presentation: string;
    }
  | {
      kind: 'settings';
      title: UiText;
    };
/**
 * A fixed committed source for continuation; no runtime or permission claim.
 */
export type DeploymentInstances =
  | {
      kind: 'start';
    }
  | {
      kind: 'continue';
      source: DeploymentRef;
      after?: InstanceId | null;
    };
export type SettingKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'unsupported';
export type SettingValue =
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'number';
      text: string;
    }
  | {
      kind: 'boolean';
      value: boolean;
    }
  | {
      kind: 'null';
    };
export type BindingConsumer =
  | {
      kind: 'root';
      name: string;
    }
  | {
      kind: 'package';
      package: PackageRef;
    };
export type BindingCandidate =
  | {
      kind: 'bound';
      key: string;
      label: string;
      presentation?: PackagePresentation;
      target: Target;
    }
  | {
      kind: 'package';
      key: string;
      label: string;
      presentation?: PackagePresentation;
      package: PackageRef;
      export: string;
    };
export type Cardinality =
  | {
      kind: 'one';
    }
  | {
      kind: 'optional';
    }
  | {
      kind: 'many';
      min: number;
      max: number;
    };
/**
 * One atomic patch to the original source, not a saved plan or draft registry.
 */
export type CompositionChange =
  | {
      kind: 'insert';
      name: string;
      package: PackageRef;
      usePackage: PackageUse;
      settings: SettingChange[];
      bindings: {
        [k: string]: Target[] | undefined;
      };
    }
  | {
      kind: 'update';
      name: string;
      configuration: {
        [k: string]: unknown | undefined;
      };
      bindings: {
        [k: string]: Target[] | undefined;
      };
    }
  | {
      kind: 'remove';
      name: string;
    };
/**
 * A deterministic refusal is a recorded business result. Uncertain SQL/worker
 * failures remain in the original operation journal's Unknown outcome.
 */
export type ManagementResultForPackageInstalled =
  | {
      status: 'committed';
      value: PackageInstalled;
    }
  | {
      status: 'conflict';
      currentRevision: number;
    }
  | {
      status: 'rejected';
      reason: ManagementRejection;
      diagnostic?: string | null;
    };
export type ManagementRejection =
  | 'invalid_bundle'
  | 'download_failed'
  | 'invalid_document'
  | 'invalid_source'
  | 'package_unavailable'
  | 'instance_unavailable'
  | 'parent_disabled';
/**
 * A deterministic refusal is a recorded business result. Uncertain SQL/worker
 * failures remain in the original operation journal's Unknown outcome.
 */
export type ManagementResultForDeploymentRef =
  | {
      status: 'committed';
      value: DeploymentRef;
    }
  | {
      status: 'conflict';
      currentRevision: number;
    }
  | {
      status: 'rejected';
      reason: ManagementRejection;
      diagnostic?: string | null;
    };
export type Implementation =
  | {
      kind: 'javascript';
      module: string;
      realm: Realm;
    }
  | {
      kind: 'native';
      implementation: string;
    };
export type Realm = 'shared' | 'dedicated';
export type McpTransport =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      /**
       * Absolute working directory, independent of model-controlled arguments.
       */
      cwd: string;
      env?: {
        [k: string]: string | undefined;
      };
      /**
       * Environment variable names explicitly forwarded from the Host.
       */
      passEnv?: string[];
    }
  | {
      type: 'streamable_http';
      url: string;
      headers?: {
        [k: string]: string | undefined;
      };
      /**
       * Header name to Host environment variable; keeps tokens out of config.
       */
      headerEnv?: {
        [k: string]: string | undefined;
      };
    };
/**
 * Session sandbox policy. Full access disables isolation and permits Computer Use
 * without additional application, browser or audio consent.
 */
export type AgentWorkspaceAccess = 'read_only' | 'workspace_write' | 'danger_full_access';
export type AgentToolInput = ('json' | 'skill' | 'web') | 'shell';
export type AgentToolResult = ('json' | 'image') | 'computer';
export type AgentToolConfirmation = 'required' | 'preapproved';
/**
 * A selected service is either an imported provider or the caller's own export.
 */
export type ServiceTarget =
  | {
      kind: 'import';
      name: string;
    }
  | {
      kind: 'export';
      name: string;
    };
export type Network =
  | ('denied' | 'allowed')
  | {
      restricted: {
        destinations: Destination[];
      };
    };
export type DecisionsProtocol = 'jev' | 'openai_decisions';
export type DecisionsApiCredentialTarget =
  | {
      kind: 'api_key';
    }
  | {
      kind: 'header';
      name: string;
    };
export type DecisionsApiCredentialChange = 'replace' | 'remove';
export type DecisionsApiUpdate =
  | {
      kind: 'updated';
      snapshot: DecisionsSnapshot;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'invalid';
    };
export type DecisionsQuestion =
  | {
      type: 'predicate';
      instructions: unknown;
      criteria?: {
        [k: string]: unknown | undefined;
      } | null;
    }
  | {
      type: 'choice';
      instructions: unknown;
      choices: DecisionsChoice[];
    }
  | {
      type: 'score';
      instructions: unknown;
      levels: DecisionsLevel[];
    };
export type DecisionsChoiceValue = string | boolean;
export type DecisionsApiResult =
  | {
      kind: 'completed';
      value: DecisionsEvaluationResult;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type DecisionsAnswer =
  | {
      type: 'predicate';
      probability: number;
    }
  | {
      type: 'choice';
      choice: DecisionsChoiceValue;
      confidence: number;
      probabilities: DecisionsChoiceProbability[];
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      probabilities: DecisionsScoreProbability[];
      legend: {
        [k: string]: unknown | undefined;
      };
    }
  | {
      type: 'refusal';
    };
export type WebSource = 'model' | 'tavily';
export type WebUpdate =
  | {
      kind: 'updated';
      snapshot: WebSnapshot;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'invalid_key';
    }
  | {
      kind: 'check_unavailable';
    };
export type WebCheckOutcome =
  | 'valid'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network_error'
  | 'timeout';
export type WebResult =
  | {
      kind: 'completed';
      value: unknown;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type WebEndpoint =
  | {
      state: 'not_checked';
    }
  | {
      state: 'unknown';
      target: string;
      error: string;
    }
  | {
      state: 'checked';
      target: string;
      httpStatus: number;
      elapsedMs: number;
      health: WebReadiness;
    };
export type WebReadiness = 'healthy' | 'unknown' | 'unhealthy';
export type AgentModelsRead =
  | {
      kind: 'start';
      query?: string;
    }
  | {
      kind: 'continue';
      revision: string;
      cursor: AgentModelsCursor;
    };
export type AgentModelsPage =
  | {
      kind: 'ready';
      revision: string;
      choices: AgentModelChoice[];
      complete: boolean;
      next?: AgentModelsCursor | null;
    }
  | {
      kind: 'changed';
    };
/**
 * The next turn's choice, independent of an already admitted execution.
 * Model revisions are resolved afresh; preferences never grant execution authority.
 */
export type AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      thinkingLevel?: ThinkingLevel | null;
    }
  | {
      kind: 'executor';
      selection: AgentExecutorSelection;
    };
export type ThinkingLevel =
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
export type ExecutorEffort = string;
export type AgentModelResult =
  | {
      kind: 'ready';
      choice: AgentModelChoice;
    }
  | {
      kind: 'unavailable';
      message: string;
    };
export type AgentGlobalInstructionsView =
  | {
      kind: 'available';
      source: AgentGlobalInstructionSource;
      path: string;
      revision: string;
      content: string;
      exists: boolean;
    }
  | {
      kind: 'unavailable';
    };
export type AgentGlobalInstructionSource = 'maka' | 'agents';
export type AgentGlobalInstructionsUpdated =
  | {
      kind: 'saved';
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    };
export type AgentNativeRuntime = 'antigravity' | 'codex' | 'claude';
export type AgentExternalAgentsState =
  | {
      kind: 'disabled';
    }
  | {
      kind: 'enabled';
    }
  | {
      kind: 'workspace_required';
    }
  | {
      kind: 'unavailable';
      message: string;
    }
  | {
      kind: 'ready';
      runtimes: AgentExternalRuntime[];
    };
export type AgentExternalInstallation =
  | {
      kind: 'available';
      version?: string | null;
    }
  | {
      kind: 'not_found';
    }
  | {
      kind: 'unsupported';
      detail: string;
    }
  | {
      kind: 'error';
      detail: string;
    };
export type AgentExternalAuthentication =
  | {
      kind: 'authenticated';
      source: string;
    }
  | {
      kind: 'unauthenticated';
      source: string;
      detail?: string | null;
    }
  | {
      kind: 'unsupported';
    }
  | {
      kind: 'unknown';
      detail?: string | null;
      source?: string | null;
      configured?: string[] | null;
    }
  | {
      kind: 'error';
      detail: string;
    };
export type AgentExternalModels =
  | {
      kind: 'ready';
      count: number;
    }
  | {
      kind: 'unauthenticated';
      detail?: string | null;
    }
  | {
      kind: 'unsupported';
      detail: string;
    }
  | {
      kind: 'unavailable';
    }
  | {
      kind: 'error';
      detail: string;
    };
export type ExternalTaskId = string;
export type Language = 'en' | 'zh-CN' | 'zh-TW';
export type RunId = string;
export type ExecutorSetupAction =
  | {
      kind: 'check';
    }
  | {
      kind: 'authenticate';
      methodId: string;
    };
export type ExecutorSetupResult =
  | {
      kind: 'checked';
      info?: ExecutorSetupInfo | null;
      methods: ExecutorAuthenticationMethod[];
    }
  | {
      kind: 'authenticated';
    }
  | {
      kind: 'unresolved';
      diagnostic: string;
    };
export type ExecutorSetupProgress = {
  kind: 'authorization_url';
  url: string;
};
/**
 * Selects the Host's local desktop or its Windows host when running in WSL.
 * Executables and transport addresses are exclusively Host configuration.
 */
export type Desktop = 'auto' | 'local' | 'windows';
export type ComputerReplState = 'fresh' | 'ready' | 'reset_required';
export type ComputerResult =
  | {
      kind: 'completed';
      artifact: string;
      state: ComputerReplState;
    }
  | {
      kind: 'failed';
      message: string;
      state: ComputerReplState;
    };
export type Scope = 'subtree' | 'exact';
/**
 * Equal-path conflict priority is different from authority breadth: deny wins.
 */
export type Access = 'read' | 'write' | 'deny';
export type ExecutorOutcome =
  | {
      status: 'completed';
      /**
       * Final completed assistant message, or no answer for a tool-only turn.
       */
      message_id?: string | null;
    }
  | {
      status: 'cancelled';
      reason?: string | null;
    }
  | {
      status: 'failed';
      message: string;
      code?: string | null;
      recoverable?: boolean;
    };
/**
 * External tool activity is observation, never a request to dispatch a Host tool.
 */
export type ExecutorOutput =
  | {
      type: 'message_start';
      messageId: string;
    }
  | {
      type: 'output_delta';
      messageId: string;
      text: string;
    }
  | {
      type: 'thinking_delta';
      messageId: string;
      text: string;
    }
  | {
      type: 'message_end';
      messageId: string;
    }
  | {
      type: 'tool_start';
      toolCallId: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool_progress';
      toolCallId: string;
      text: string;
    }
  | {
      type: 'tool_result';
      toolCallId: string;
      text: string;
      isError?: boolean;
      details?: ToolResultDetails | null;
    }
  | {
      type: 'turn_usage';
      usage: ExecutorTurnUsage;
    };
export type ProtocolProcessProgress =
  | {
      kind: 'started';
      id: string;
      /**
       * Original protected private-task resource address, not launch authority.
       */
      resource_ref: string;
    }
  | {
      kind: 'output';
      stream: ProtocolProcessStream;
      /**
       * @maxItems 8192
       */
      bytes: number[];
    };
export type ProtocolProcessStream = 'stdout' | 'stderr';
export type ProtocolProcessCompletion =
  | {
      kind: 'exited';
      code?: number | null;
      success: boolean;
      stopped: boolean;
      error?: string | null;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type AgentWorkTarget =
  | {
      kind: 'run';
      runId: RunId;
    }
  | {
      kind: 'message';
      messageId: string;
    };
export type AgentWork =
  | {
      kind: 'missing';
    }
  | {
      kind: 'pending';
    }
  | {
      kind: 'cancelled';
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'delivered';
      shared: boolean;
      execution: AgentExecution;
      answer?: AgentAnswerPage | null;
      /**
       * Count for this exact Run; original Session interactions retain all authority.
       */
      pendingInteractions: number;
    };
export type AgentExecutionState =
  | {
      kind: 'admitted';
    }
  | {
      kind: 'running';
    }
  | {
      kind: 'waiting';
      waits: WaitReason[];
      authorityUnavailable: boolean;
    }
  | {
      kind: 'completed';
    }
  | {
      kind: 'failed';
      reason?: BlockerKind | null;
    }
  | {
      kind: 'cancelled';
    };
export type WaitReason =
  | {
      kind: 'cell';
      cell: CellId;
    }
  | {
      kind: 'external';
      task: ExternalTaskId;
    }
  | {
      kind: 'provider_backoff';
      attempt: ModelAttemptId;
    }
  | {
      kind: 'model';
      attempt: ModelAttemptId;
    }
  | {
      kind: 'approval';
      approval: ApprovalId;
    }
  | {
      kind: 'retry';
      attempt: ModelAttemptId;
    }
  | {
      kind: 'operation';
      tool: ToolKey;
    }
  | {
      kind: 'child';
      run: RunId;
    }
  | {
      kind: 'blocker';
      blocker: BlockerId;
    };
export type CellId = string;
export type ModelAttemptId = string;
export type ApprovalId = string;
export type BlockerId = string;
export type BlockerKind =
  | {
      kind: 'external_publication_unavailable';
      publication: ExternalPublicationId;
      diagnostic: string;
    }
  | {
      kind: 'external_publication_item';
      key: ExternalPublicationKey;
      reason: ExternalPublicationBlocker;
    }
  | {
      kind: 'current_authority_unavailable';
      stage: AuthorityStage;
      diagnostic: string;
    }
  | {
      kind: 'external_effect_unknown';
      task: ExternalTaskId;
      operation: string;
    }
  | {
      kind: 'operation_unknown';
      tool: ToolKey;
      reference: RecoveryRef;
    }
  | {
      kind: 'provider_effect_unknown';
      attempt: ModelAttemptId;
      call: string;
    }
  | {
      kind: 'original_admission_unknown';
      tool: ToolKey;
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
      tool: ToolKey;
      diagnostic: string;
    }
  | {
      kind: 'model_cleanup_unconfirmed';
      attempt: ModelAttemptId;
      diagnostic: string;
    }
  | {
      kind: 'cleanup_unconfirmed';
      reference: RecoveryRef;
    }
  | {
      kind: 'resources_unavailable';
      tool: ToolKey;
    }
  | {
      kind: 'external_task_unobservable';
      descriptor: ContentRef;
    };
export type ExternalPublicationId = string;
export type ExternalPublicationBlocker =
  | 'unknown'
  | 'conflict'
  | 'unsupported'
  | 'failed'
  | 'not_attempted'
  | 'cleanup_unconfirmed';
export type AuthorityStage =
  | 'current_session'
  | 'workspace_scope'
  | 'tool_bindings'
  | 'backend_scope'
  | 'input_codec';
export type SettingsModelsRead =
  | {
      kind: 'start';
      query?: string;
      connectionId?: string | null;
    }
  | {
      kind: 'continue';
      revision: number;
      cursor: SettingsModelCursor;
    };
export type UsageActivityKind = 'model' | 'tool';
export type UsageActivityStatus = 'success' | 'error' | 'aborted' | 'unknown' | 'rejected';
export type UsageActivity =
  | {
      kind: 'model';
      attempt: UsageModelAttempt;
    }
  | {
      kind: 'tool';
      attempt: ToolUsage;
    };
export type UsageOrigin =
  | {
      kind: 'agent';
      execution: ExecutionIdentity;
      link: AgentStepLink;
      purpose: ModelPurpose;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'auxiliary';
      source: UsageAuxiliarySource;
      [k: string]: unknown | undefined;
    };
export type StepId = string;
export type ModelPurpose = 'main' | 'summary';
export type UsageAuxiliarySource =
  | {
      kind: 'application_operation';
      source: DeploymentRef;
      namespace: InstanceId;
      operation: string;
      fingerprint: string;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session_title';
      execution: ExecutionIdentity;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent';
      execution: ExecutionIdentity;
      operation_id: string;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'host_effect';
      id: string;
      [k: string]: unknown | undefined;
    };
export type UsageOutcome = ('success' | 'error' | 'aborted') | 'unknown';
export type ToolUsageSource =
  | {
      kind: 'agent';
      execution: ExecutionIdentity;
      call: ToolCallIdentity;
    }
  | {
      kind: 'cell';
      cell: CellId;
      owner: CellOwner;
      operation: string;
    }
  | {
      kind: 'external';
      task: ExternalTaskId;
      owner: RunOwner;
      operation: string;
    };
export type ToolOrigin =
  | {
      kind: 'provider';
      link: AgentStepLink;
    }
  | {
      kind: 'code_mode';
      cell: CellId;
      owner: CellOwner;
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'code_cell';
      cell: CellId;
      owner: CellOwner;
      parent_operation_id: string;
      parent_tool_call_id: string;
    }
  | {
      kind: 'standalone';
    }
  | {
      kind: 'external';
      task: ExternalTaskId;
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
      parent_operation_id?: string | null;
      parent_relationship?: HostSdkRelationship | null;
    };
export type CellOwner =
  | {
      kind: 'agent';
      link: AgentStepLink;
      call: string;
    }
  | {
      kind: 'standalone';
      session: string;
    };
export type HostSdkRelationship = {
  kind: 'evaluation_observer';
  epoch: string;
};
export type ToolUsageResult =
  | {
      kind: 'rejected';
      reason?: RejectionKind | null;
    }
  | {
      kind: 'settled';
      startedAt: number;
      outcome: UsageToolStatus;
    };
/**
 * Refusal category without input-derived explanation text.
 */
export type RejectionKind =
  | 'superseded'
  | 'unavailable'
  | 'invalid_input'
  | 'policy_denied'
  | 'preparation_failed'
  | 'exclusive_conflict'
  | 'cancelled';
export type UsageToolStatus = 'success' | 'error' | 'unknown';
/**
 * Breakdown selected for a bounded summary page.
 */
export type UsageGroup = 'byProvider' | 'byModel' | 'byTool';
export type SettingsPricingResult =
  | {
      kind: 'updated';
      result: PricingUpdated;
    }
  | {
      kind: 'rejected';
    };
export type PricingUpdated =
  | {
      kind: 'committed';
      revision: number;
    }
  | {
      kind: 'unchanged';
      revision: number;
    }
  | {
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    };
export type PricingQuery =
  | {
      kind: 'start';
    }
  | {
      kind: 'continue';
      revision: number;
      offset: number;
    };
export type PricingPage =
  | {
      kind: 'page';
      revision: number;
      offset: number;
      entries: PricingEntry[];
      nextOffset?: number | null;
    }
  | {
      kind: 'revision_changed';
      expectedRevision: number;
      actualRevision: number;
    };
export type PricingEntry =
  | {
      source: 'builtin';
      pricing: Pricing;
    }
  | {
      source: 'custom';
      pricing: Pricing;
      resetEffect: PricingResetEffect;
    };
export type PricingResetEffect = 'restore_builtin' | 'become_unpriced';
export type PricingMutation =
  | {
      kind: 'upsert';
      pricing: Pricing;
    }
  | {
      kind: 'delete';
      modelKey: string;
    };
export type LanguagePreference = 'auto' | 'en' | 'zh-CN' | 'zh-TW';
/**
 * User-facing isolation preset, independent of whether approval may be requested.
 */
export type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ShellPreference = 'auto' | 'git_bash';
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type CredentialLocator =
  | {
      scope: 'connection';
      connectionId: string;
      kind: ConnectionCredentialKind;
    }
  | {
      scope: 'network_proxy';
      kind: PasswordKind;
    };
export type ConnectionCredentialKind = 'provider' | 'request_headers' | 'usage';
export type PasswordKind = 'password';
export type SettingsNetworkCredentialAction = 'keep' | 'delete' | 'replace';
export type SettingsNetworkUpdated =
  | {
      kind: 'applied';
      result: NetworkProxyUpdateResult;
    }
  | {
      kind: 'rejected';
    };
export type NetworkProxyUpdateResult =
  | {
      kind: 'committed';
      revision: number;
      credentialStatus: CredentialStatus;
    }
  | {
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }
  | {
      kind: 'proxy_target_mismatch';
      expected: CredentialTarget;
      actual: CredentialTarget;
    }
  | {
      kind: 'credential_stale';
      expected: CredentialVersionBasis | null;
      actual: CredentialVersionBasis | null;
    };
export type SettingsPreferencesMutation =
  | {
      kind: 'message_predictions';
      settings: MessagePredictionSettings;
    }
  | {
      kind: 'language';
      preference: LanguagePreference;
    }
  | {
      kind: 'compaction_prompt';
      prompt?: string | null;
    }
  | {
      kind: 'personalization';
      displayName: string;
    }
  | {
      kind: 'workspace_instructions';
      enabled: boolean;
    }
  | {
      kind: 'default_sandbox';
      mode: Mode;
    }
  | {
      kind: 'shell';
      value: ShellPolicy;
    };
export type SettingsPreferencesUpdated =
  | {
      kind: 'committed';
      revision: number;
    }
  | {
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }
  | {
      kind: 'rejected';
    };
export type SettingsModelsPage =
  | {
      kind: 'changed';
      revision: number;
    }
  | {
      kind: 'ready';
      revision: number;
      /**
       * @maxItems 16
       */
      choices:
        | []
        | [SettingsModelChoice]
        | [SettingsModelChoice, SettingsModelChoice]
        | [SettingsModelChoice, SettingsModelChoice, SettingsModelChoice]
        | [SettingsModelChoice, SettingsModelChoice, SettingsModelChoice, SettingsModelChoice]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ]
        | [
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
            SettingsModelChoice,
          ];
      defaultModel: SettingsDefaultModel;
      next: SettingsModelCursor | null;
    };
/**
 * Interpreter used only for model-facing Code Mode cells.
 */
export type CodeLanguage = 'javascript' | 'python';
export type SettingsDefaultModel =
  | {
      kind: 'none';
    }
  | {
      kind: 'unavailable';
      target: ConnectionTarget;
    }
  | {
      kind: 'ready';
      choice: SettingsModelChoice;
      defaults: SettingsModelDefaults | null;
    };
export type SettingsConnectionsRead =
  | {
      kind: 'start';
    }
  | {
      kind: 'continue';
      revision: number;
      offset: number;
    };
export type SettingsConnectionsPage =
  | {
      kind: 'changed';
      revision: number;
    }
  | {
      kind: 'ready';
      revision: number;
      defaultTarget: ConnectionTarget | null;
      /**
       * @maxItems 16
       */
      connections:
        | []
        | [SettingsConnectionSummary]
        | [SettingsConnectionSummary, SettingsConnectionSummary]
        | [SettingsConnectionSummary, SettingsConnectionSummary, SettingsConnectionSummary]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ]
        | [
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
            SettingsConnectionSummary,
          ];
      next: number | null;
    };
export type SettingsConnectionDetail =
  | {
      kind: 'stale';
      actual: ConnectionVersionBasis | null;
    }
  | {
      kind: 'ready';
      target: ConnectionCredentialTarget;
      name: string;
      enabled: boolean;
      enabledModelCount: number;
      editing?: SettingsConnectionEditingFacts;
    };
export type ApiProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
export type ModelModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';
export type RelayServiceTier = 'fast';
export type UsageAuthentication = 'provider' | 'access_key' | 'team_access_key';
export type SettingsCredentialLoginResult =
  | {
      kind: 'saved';
      connection: ConnectionIdentity;
    }
  | {
      kind: 'rejected';
      reason: SettingsCredentialRejection;
    }
  | {
      kind: 'failed';
      reason: SettingsLoginFailure;
      message: string;
    };
export type SettingsCredentialRejection =
  | 'invalid_input'
  | 'invalid_secret'
  | 'secret_unavailable'
  | 'provider_unavailable'
  | 'authentication_unavailable'
  | 'attempt_conflict'
  | 'connection_changed'
  | 'credential_changed'
  | 'slug_taken'
  | 'authentication';
export type SettingsLoginFailure = 'cancelled' | 'expired' | 'transport' | 'authentication';
export type SettingsCredentialSaveResult =
  | {
      kind: 'saved';
      connection: ConnectionIdentity;
    }
  | {
      kind: 'rejected';
      reason: SettingsCredentialRejection;
    };
export type Nullable_MapOf_ModelOverride = {
  [k: string]: ModelOverride | undefined;
} | null;
export type CredentialVaultQueryResult =
  | {
      kind: 'status';
      status: CredentialStatus;
    }
  | {
      kind: 'connection_not_found';
    };
export type CredentialMutationResult =
  | {
      kind: 'rejected';
      reason: ConfigurationRejection;
    }
  | {
      kind: 'committed';
      vaultRevision: number;
      status: CredentialStatus;
    }
  | {
      kind: 'connection_not_found';
    }
  | {
      kind: 'connection_stale';
      expected: ConnectionVersionBasis;
      actual: ConnectionVersionBasis | null;
    }
  | {
      kind: 'credential_stale';
      expected: CredentialVersionBasis | null;
      actual: CredentialVersionBasis | null;
    };
/**
 * A confirmed rejection contains no provider diagnostics or user input.
 */
export type ConfigurationRejection =
  | 'invalid_input'
  | 'invalid_configuration'
  | 'provider_unavailable';
export type CatalogMutationResult =
  | {
      kind: 'rejected';
      reason: ConfigurationRejection;
    }
  | {
      kind: 'committed';
      catalogRevision: number;
      connection?: ConnectionVersionBasis | null;
    }
  | {
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }
  | {
      kind: 'connection_exists';
      slug: string;
    }
  | {
      kind: 'connection_stale';
      expected: ConnectionVersionBasis;
      actual: ConnectionVersionBasis | null;
    }
  | {
      kind: 'invalid_default_target';
      target: ConnectionTarget;
    };
/**
 * Standard user/project configuration locations, ordered from highest precedence.
 */
export type ConfigurationLocation = 'project:maka' | 'project:agents' | 'user:maka' | 'user:agents';
export type AgentMcpServerChange =
  | {
      kind: 'save';
      configuration: unknown;
    }
  | {
      kind: 'delete';
    };
export type AgentMcpConfigurationResult =
  | {
      kind: 'saved';
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'rejected';
      reason: string;
    };
export type SkillLibraryPage =
  | {
      kind: 'page';
      writable: boolean;
      targets: SkillLibraryTarget[];
      preferencesWritable: boolean;
      preferenceRevision: number;
      revision: string;
      entries: SkillLibraryEntry[];
      after?: SkillLibraryCursor | null;
      diagnostics: string[];
    }
  | {
      kind: 'changed';
    };
/**
 * The exact source snapshot selected during discovery, or last installed.
 */
export type SkillLibrarySourceSnapshot =
  | {
      kind: 'git';
      url: string;
      reference?: string | null;
      revision: string;
    }
  | {
      kind: 'directory';
      path: string;
    };
export type SkillLibraryDocument =
  | {
      kind: 'page';
      writable: boolean;
      preferencesWritable: boolean;
      preferenceRevision: number;
      entry: SkillLibraryEntry;
      revision: string;
      text: string;
      offset: number;
      before?: number | null;
      after?: number | null;
      totalBytes: number;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    };
export type SkillLibraryInstallOutcome =
  | {
      kind: 'installed';
      reference: string;
    }
  | {
      kind: 'rejected';
      directory: string;
      reason: string;
    };
export type SkillLibraryChangeResult =
  | {
      kind: 'applied';
      reference: string;
    }
  | {
      kind: 'rejected';
      reason: string;
    };
export type SkillLibraryPreferenceResult =
  | {
      kind: 'applied';
      revision: number;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'rejected';
      reason: string;
    };
export type SkillScope = 'project' | 'workspace' | 'user' | 'custom';
export type SkillSource = 'maka' | 'agents' | 'custom';
export type SkillModelLoadResult =
  | {
      kind: 'loaded';
      revision: string;
      metadata: SkillMetadata;
      instructions: string;
      instructionOffset: number;
      next?: SkillModelLoad | null;
      relativePath: string;
      declaredTools: string[];
      declaredToolsTruncated: boolean;
      receipt: SkillInvocationReceipt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'resource';
      revision: string;
      reference: string;
      path: string;
      content: string;
      offset: number;
      returnedLines: number;
      totalLines: number;
      partialLine: boolean;
      next?: SkillModelLoad | null;
      receipt: SkillInvocationReceipt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'changed';
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'unavailable';
      reason: SkillFailureReason;
      receipt: SkillInvocationReceipt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'resource_unavailable';
      reason: string;
      [k: string]: unknown | undefined;
    };
/**
 * Boolean wire discriminants are validated here, not retained as mutable
 * business fields beside a contradictory enum variant.
 */
export type SkillInvocationReceipt =
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: true;
      ref: string;
      id: string;
      name: string;
      scope: SkillScope;
      source: SkillSource;
    }
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: false;
      reason: SkillFailureReason;
    };
export type SkillInvocationMode = 'explicit' | 'model_tool';
export type SkillFailureReason =
  | 'invalid_name'
  | 'not_found'
  | 'disabled'
  | 'host_incompatible'
  | 'resolution_failed';
export type SkillPreparation =
  | {
      kind: 'ready';
      /**
       * None preserves the original message exactly.
       */
      text?: string | null;
      record: SkillPreparationRecord;
      requiredTools: string[];
    }
  | {
      kind: 'blocked';
      invocation: SkillInvocationResult;
    };
export type SkillInvocationFailure = SkillRequestFailure;
export type AgentSessionFilter = 'all' | 'archived' | 'needs_you';
export type AgentSessionPosition =
  | {
      kind: 'start';
    }
  | {
      kind: 'at';
      cursor: string;
    }
  | {
      kind: 'after';
      revision: string;
      cursor: string;
    }
  | {
      kind: 'before';
      revision: string;
      cursor: string;
    };
export type AgentSessionListScope =
  | {
      kind: 'all';
    }
  | {
      kind: 'project';
      projectId: string;
    }
  | {
      kind: 'children';
      sessionId: string;
    }
  | {
      kind: 'workspace';
      sessionId: string;
    };
export type AgentWorkspaceSelection =
  | {
      kind: 'isolated_git';
      path: string;
    }
  | {
      kind: 'project';
      project: AgentProjectRef;
      path: string;
    }
  | {
      kind: 'directory';
      path: string;
    }
  | {
      kind: 'session';
      sessionId: string;
    };
export type GoalStatus =
  | 'armed'
  | 'active'
  | 'paused'
  | 'achieved'
  | 'cancelled'
  | 'budget_limited'
  | 'blocked';
export type GoalReportKind = 'progress' | 'achieved' | 'blocked' | 'paused';
export type AgentGoalChange =
  | {
      kind: 'create';
      sessionId: string;
      objective: string;
      tokenBudget?: number | null;
      start: boolean;
      approval: AgentGoalApproval;
    }
  | {
      kind: 'control';
      sessionId: string;
      goalId: string;
      revision: number;
      action: GoalControl;
      budget?: AgentGoalBudget | null;
      /**
       * Explicit renewed model and session authority, only for Resume without a pending iteration.
       */
      approval?: AgentGoalApproval | null;
    };
export type GoalControl = 'pause' | 'resume' | 'cancel' | 'complete' | 'set_budget';
export type AgentGoalResult =
  | {
      kind: 'committed';
      goalId: string;
      revision: number;
    }
  | {
      kind: 'conflict';
      actual?: number | null;
    }
  | {
      kind: 'rejected';
      reason: string;
    };
export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed';
export type AgentRecapReceipt =
  | {
      kind: 'pending';
      operationId: string;
      through: number;
    }
  | {
      kind: 'ready';
      operationId: string;
      through: number;
      text: string;
      modelId: string;
    }
  | {
      kind: 'failed';
      operationId: string;
      through: number;
      reason: AgentRecapFailure;
    };
export type AgentRecapFailure =
  | 'empty_or_oversized_output'
  | 'incomplete_output'
  | 'model_unavailable';
export type AgentScheduleRead =
  | {
      kind: 'discovery';
      sessionId: string;
      cursor?: string | null;
      expectedRevision?: number | null;
    }
  | {
      kind: 'list';
      cursor?: string | null;
      expectedRevision?: number | null;
    }
  | {
      kind: 'get';
      taskId: string;
    };
export type AgentSchedules =
  | {
      kind: 'page';
      revision: number;
      tasks: AgentScheduledSummary[];
      nextCursor?: string | null;
    }
  | {
      kind: 'task';
      detail?: AgentScheduledDetail | null;
    }
  | {
      kind: 'changed';
      revision: number;
    };
export type Status = 'active' | 'paused' | 'completed' | 'expired';
export type AgentInvestigationPhase = 'investigating' | 'delivering' | 'stopping';
export type Intent = {
  kind: 'text';
  body: string;
};
export type Schedule =
  | {
      kind: 'once';
      runAt: number;
    }
  | {
      kind: 'interval';
      everySeconds: number;
      startAt: number;
    }
  | {
      kind: 'calendar';
      recurrence: Recurrence;
      anchorAt: number;
    }
  | {
      kind: 'cron';
      expression: string;
      startAt: number;
    };
export type Recurrence = 'daily' | 'weekly' | 'monthly';
export type AgentScheduledEffect =
  | {
      kind: 'reminder';
    }
  | {
      kind: 'session';
      target: AgentScheduledTarget;
      model: ModelSelection;
      thinkingLevel?: ThinkingLevel | null;
    }
  | {
      kind: 'agent_run';
      target: AgentScheduledTarget;
      model: ModelSelection;
      thinkingLevel?: ThinkingLevel | null;
    }
  | {
      kind: 'discovery';
      target: AgentScheduledTarget;
      model: ModelSelection;
      thinkingLevel?: ThinkingLevel | null;
    };
export type Creator =
  | {
      kind: 'user';
    }
  | {
      kind: 'agent';
      sessionId: string;
    }
  | {
      kind: 'system';
    };
export type Outcome = 'ok' | 'failed' | 'blocked';
export type Misfire = 'skip' | 'latest';
export type AgentScheduleChange =
  | {
      kind: 'create';
      input: AgentScheduledInput;
    }
  | {
      kind: 'update';
      taskId: string;
      revision: number;
      input: AgentScheduledInput;
    }
  | {
      kind: 'approve';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'pause';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'resume';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'trigger_now';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'snooze';
      taskId: string;
      revision: number;
      delayMs: number;
    }
  | {
      kind: 'acknowledge';
      taskId: string;
      revision: number;
      fireId: string;
    }
  | {
      kind: 'clear_history';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'delete';
      taskId: string;
      revision: number;
    };
export type AgentScheduleResult =
  | {
      kind: 'committed';
      taskId: string;
      revision: number;
    }
  | {
      kind: 'conflict';
      actual?: number | null;
    }
  | {
      kind: 'rejected';
      reason: string;
    };
export type PresetRevision = number;
/**
 * A complete logical Turn boundary within the source session.
 */
export type AgentForkPosition =
  | {
      kind: 'start';
    }
  | {
      kind: 'end';
    }
  | {
      kind: 'through_turn';
      turnId: string;
    }
  | {
      kind: 'before_turn';
      turnId: string;
    }
  | {
      kind: 'through_source_turn';
      position: HistoryRowAddress;
    }
  | {
      kind: 'before_source_turn';
      position: HistoryRowAddress;
    };
/**
 * An original row within the actual read capability supplied by the caller.
 * Marker paths are relative to that capability; none of these fields grants access.
 */
export type HistoryRowAddress =
  | {
      kind: 'live';
      sequence: number;
      fact: FactId;
      itemIndex: number;
    }
  | {
      kind: 'snapshot';
      path: RunId[];
      snapshot: string;
      sequence: number;
      fact: FactId;
      itemIndex: number;
    }
  | {
      kind: 'imported';
      path: RunId[];
      snapshot: string;
      messageOrdinal: number;
      partOrdinal: number;
    };
export type FactId = string;
export type AgentSessionActivity = 'idle' | 'working' | 'waiting';
export type AgentImportsRead =
  | {
      kind: 'sources';
    }
  | {
      kind: 'catalog';
      source: AgentImportSourceRef;
      query: AgentImportQuery;
    }
  | {
      kind: 'preview';
      source: AgentImportSourceRef;
      entry: AgentImportEntryRef;
      digest: string | null;
      after: number;
    }
  | {
      kind: 'copies';
      after: string | null;
    };
export type AgentImportsPage =
  | {
      kind: 'sources';
      revision: number;
      sources: AgentImportSource[];
    }
  | {
      kind: 'catalog';
      source: AgentImportSourceRef;
      /**
       * @maxItems 16
       */
      entries:
        | []
        | [AgentImportEntry]
        | [AgentImportEntry, AgentImportEntry]
        | [AgentImportEntry, AgentImportEntry, AgentImportEntry]
        | [AgentImportEntry, AgentImportEntry, AgentImportEntry, AgentImportEntry]
        | [AgentImportEntry, AgentImportEntry, AgentImportEntry, AgentImportEntry, AgentImportEntry]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ]
        | [
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
            AgentImportEntry,
          ];
      next: string | null;
    }
  | {
      kind: 'preview';
      preview: AgentImportPreview;
    }
  | {
      kind: 'copies';
      /**
       * @maxItems 16
       */
      sessions:
        | []
        | [AgentSession]
        | [AgentSession, AgentSession]
        | [AgentSession, AgentSession, AgentSession]
        | [AgentSession, AgentSession, AgentSession, AgentSession]
        | [AgentSession, AgentSession, AgentSession, AgentSession, AgentSession]
        | [AgentSession, AgentSession, AgentSession, AgentSession, AgentSession, AgentSession]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ]
        | [
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
            AgentSession,
          ];
      next: string | null;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    }
  | {
      kind: 'invalid';
    };
export type AgentImportLocation =
  | {
      kind: 'codex';
      path: string;
    }
  | {
      kind: 'claude_code';
      path: string;
    }
  | {
      kind: 'open_code';
      path: string;
      database: string;
    };
export type AgentImportRecordKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'note';
export type AgentImportChange =
  | {
      kind: 'save_source';
      revision: number;
      id: string | null;
      name: string;
      location: AgentImportLocation;
    }
  | {
      kind: 'remove_source';
      revision: number;
      id: string;
    }
  | {
      kind: 'copy';
      selection: AgentImportSelection;
      path: string;
      title: string;
    };
export type AgentImportResult =
  | {
      kind: 'sources';
      revision: number;
      sources: AgentImportSource[];
    }
  | {
      kind: 'imported';
      session: AgentSession;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    }
  | {
      kind: 'invalid';
    };
export type AgentProjectsRead =
  | {
      kind: 'list';
      cursor: AgentProjectCursor | null;
    }
  | {
      kind: 'directory';
      path: string;
    };
export type AgentProjectsPage =
  | {
      kind: 'projects';
      revision: string;
      /**
       * @maxItems 16
       */
      projects:
        | []
        | [AgentProject]
        | [AgentProject, AgentProject]
        | [AgentProject, AgentProject, AgentProject]
        | [AgentProject, AgentProject, AgentProject, AgentProject]
        | [AgentProject, AgentProject, AgentProject, AgentProject, AgentProject]
        | [AgentProject, AgentProject, AgentProject, AgentProject, AgentProject, AgentProject]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ]
        | [
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
            AgentProject,
          ];
      next: AgentProjectCursor | null;
    }
  | {
      kind: 'directory';
      location: AgentProjectLocation;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    };
export type AgentProjectChange =
  | {
      kind: 'register';
      path: string;
      expected: AgentProjectRef | null;
    }
  | {
      kind: 'rename';
      project: AgentProjectRef;
      name: string;
    }
  | {
      kind: 'archive';
      project: AgentProjectRef;
    }
  | {
      kind: 'restore';
      project: AgentProjectRef;
    }
  | {
      kind: 'relocate';
      project: AgentProjectRef;
      path: string;
      destination: AgentProjectRef | null;
    };
export type AgentProjectResult =
  | {
      kind: 'committed';
      project: AgentProject;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
    }
  | {
      kind: 'busy';
    }
  | {
      kind: 'invalid';
    };
export type AgentCreated =
  | {
      kind: 'created';
      session: AgentSession;
    }
  | {
      kind: 'rejected';
      reason: AgentRejection;
    };
export type AgentRejection =
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
export type AgentForkResult =
  | {
      kind: 'forked';
      session: AgentSession;
    }
  | {
      kind: 'revision_conflict';
      expected: number;
      actual: number;
    }
  | {
      kind: 'rejected';
      reason: AgentRejection;
    };
export type AgentDirectories =
  | {
      kind: 'roots';
    }
  | {
      kind: 'children';
      path: string;
      after: string | null;
    };
export type AgentDirectoryPage =
  | {
      kind: 'roots';
      roots: AgentDirectory[];
    }
  | {
      kind: 'children';
      directory: AgentDirectory;
      /**
       * @maxItems 32
       */
      children: AgentDirectory[];
      after: string | null;
    };
export type AgentMetadataResult =
  | {
      kind: 'committed';
      session: AgentSession;
    }
  | {
      kind: 'revision_conflict';
      expected: number;
      actual: number;
    }
  | {
      kind: 'rejected';
      reason: AgentRejection;
    };
export type AgentSessionAction = 'archive' | 'restore' | 'remove';
export type AgentSessionChanged =
  | {
      kind: 'changed';
      session: AgentSession;
    }
  | {
      kind: 'removed';
      sessionId: string;
    }
  | {
      kind: 'revision_conflict';
      expected: number;
      actual: number;
    }
  | {
      kind: 'rejected';
      reason: AgentRejection;
    };
export type AgentOnComplete = 'notify_caller';
export type AgentSendDelivery = 'steer' | 'queue';
export type AgentExecutionResult =
  | {
      kind: 'missing';
    }
  | {
      kind: 'found';
      execution: AgentExecution;
    };
export type AgentContinuationResult =
  | {
      kind: 'started';
      execution: AgentExecution;
    }
  | {
      kind: 'rejected';
      reason: AgentContinuationRejection;
    };
export type AgentContinuationRejection =
  | 'closed'
  | 'archived'
  | 'busy'
  | 'source_missing'
  | 'source_changed'
  | 'source_not_terminal'
  | 'already_continued'
  | 'workspace_changed'
  | 'safety_check_failed';
export type AgentAttachmentUploadResult =
  | {
      kind: 'uploaded';
      attachment: AgentAttachment;
    }
  | {
      kind: 'rejected';
      reason: AgentAttachmentRejection;
    };
export type AgentAttachmentRejection = 'invalid_file' | 'closed' | 'archived';
export type AgentMarkReadResult =
  | {
      kind: 'observed';
      session: AgentSession;
    }
  | {
      kind: 'rejected';
      reason: AgentRejection;
    };
export type AgentInteractionKind =
  | 'session_approval'
  | 'service_approval'
  | 'question'
  | 'permissions'
  | 'form'
  | 'client_capability'
  | 'computer_app'
  | 'system_permission';
export type InteractionAnswer =
  | {
      kind: 'session_approval';
      decision: Decision;
    }
  | {
      kind: 'service_approval';
      decision: Decision;
    }
  | {
      kind: 'permissions';
      decision: PermissionDecision;
    }
  | {
      kind: 'question';
      answers: (string | null)[];
    }
  | ((
      | {
          action: 'accept';
          values: {
            [k: string]: FormValue | undefined;
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
      kind: 'form';
      [k: string]: unknown | undefined;
    })
  | {
      kind: 'client_capability';
      decision: Decision;
    }
  | {
      kind: 'computer_app';
      decision: ComputerAppDecision;
    }
  | {
      kind: 'computer_app_cancel';
    }
  | {
      kind: 'system_permission_cancel';
    };
export type Decision = 'allow' | 'deny';
export type PermissionDecision =
  | {
      decision: 'deny';
    }
  | {
      decision: 'allow';
      permissions: Permissions;
      scope: PermissionScope;
    };
/**
 * The Host supplies the real operation description; it is display information,
 * not authority inferred from a command string or a plugin-supplied Session ID.
 */
export type PermissionScope = 'once' | 'run' | 'session';
export type FormValue = string | number | boolean | string[];
export type ComputerAppDecision = 'once' | 'session' | 'always' | 'deny';
export type AgentInteractionResult =
  | {
      kind: 'recorded';
      record: InteractionRecord;
    }
  | {
      kind: 'rejected';
      reason: AgentInteractionRejection;
    };
export type InteractionRequest =
  | {
      kind: 'session_approval';
      toolUseId: string;
      basis: PermissionBasis;
      sessionId: string;
      requestId: string;
      answer: SessionApprovalAnswer;
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
      target: AuthorizationObligation;
      toolUseId: string | null;
      basis: PermissionBasis;
      request: PermissionRequest;
    }
  | {
      kind: 'question';
      toolUseId: string;
      questions: InteractionQuestion[];
    }
  | {
      kind: 'form';
      toolUseId: string;
      message: string;
      requester: FormRequester;
      fields: FormField[];
    }
  | {
      kind: 'client_capability';
      toolUseId: string;
      target: GrantTarget;
      /**
       * Agent-owned approvals expire with this original permission boundary.
       * Unbound capabilities are explicit; Agent-owned capabilities capture a full binding stamp.
       */
      basis?: PermissionBasis | null;
    }
  | {
      kind: 'computer_app';
      toolUseId: string;
      nativeOperationId: string;
      target: GrantTarget;
      basis: PermissionBasis;
      display: ComputerAppDisplay;
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
      grants: [SystemPermissionGrant, ...SystemPermissionGrant[]];
      /**
       * The application name the operating system lists in its settings.
       */
      application: string;
      applicationLocation?: SystemPermissionApplicationLocation | null;
    };
/**
 * Only access-expanding child decisions can require a parent's human confirmation.
 */
export type SessionApprovalAnswer =
  | {
      kind: 'service_approval';
      decision: ApprovalAllow;
    }
  | {
      kind: 'permissions';
      decision: PermissionApproval;
    }
  | {
      kind: 'client_capability';
      decision: ApprovalAllow;
    }
  | {
      kind: 'computer_app';
      decision: ComputerAppApproval;
    };
export type ApprovalAllow = 'allow';
export type PermissionApproval = {
  decision: 'allow';
  permissions: Permissions;
  scope: PermissionScope;
};
export type ComputerAppApproval = 'once' | 'session' | 'always';
export type AuthorizationObligation =
  | {
      kind: 'external';
      task: ExternalTaskId;
      operation: string;
    }
  | {
      kind: 'tool';
      tool: ToolKey;
    }
  | {
      kind: 'cell';
      cell: CellId;
      operation: string;
    };
export type FormField = {
  name: string;
  label: string;
  required: boolean;
  description?: string | null;
  [k: string]: unknown | undefined;
} & FormField1;
export type FormField1 =
  | {
      kind: 'string';
      default?: string | null;
      minLength?: number | null;
      maxLength?: number | null;
      format?: FormFormat | null;
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
      options: FormOption[];
      default?: string | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'multi_select';
      options: FormOption[];
      default?: string[] | null;
      minItems?: number | null;
      maxItems?: number | null;
      [k: string]: unknown | undefined;
    };
export type FormFormat = 'email' | 'uri' | 'date' | 'date-time';
export type GrantCapability =
  | ('browser' | 'computer_use' | 'computer_audio' | 'desktop_mcp' | 'mcp')
  | 'browser_download'
  | 'browser_history'
  | 'browser_upload';
export type GrantScope =
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
      platform: ComputerAppPlatform;
      applicationId: string;
    };
export type ComputerAppPlatform = 'macos' | 'windows';
export type ComputerAppRisk = 'low' | 'high';
/**
 * A macOS privacy grant (TCC) that the Host process itself needs before native
 * Computer Use can run. This is operating-system state the user changes in
 * System Settings, not a Maka grant; the Host observes it and commits the outcome.
 */
export type SystemPermissionGrant = 'accessibility' | 'screen_recording';
export type InteractionOutcome =
  | {
      kind: 'session_approval_decision';
      decision: Decision;
      committedAt: number;
    }
  | {
      kind: 'service_approval_decision';
      decision: Decision;
      committedAt: number;
    }
  | {
      kind: 'permissions_decision';
      decision: PermissionDecision;
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
            [k: string]: FormValue | undefined;
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
      decision: Decision;
      committedAt: number;
    }
  | {
      kind: 'computer_app_decision';
      decision: ComputerAppDecision;
      committedAt: number;
    }
  | {
      kind: 'system_permission_granted';
      committedAt: number;
    }
  | {
      kind: 'closure';
      reason: ClosureReason;
      committedAt: number;
    };
export type ClosureReason =
  | 'steered'
  | 'run_stopped'
  | 'run_terminal'
  | 'producer_cancelled'
  | 'timed_out'
  | 'host_restarted'
  | 'provider_disconnected';
export type AgentInteractionRejection =
  | 'not_your_child'
  | 'human_action_required'
  | 'authorization_changed'
  | 'permission_requests_disabled'
  | 'closed'
  | 'unavailable'
  | 'invalid_answer'
  | 'unsupported';
export type FormResponse =
  | {
      kind: 'answered';
      result: FormResult;
    }
  | {
      kind: 'closed';
      reason: ClosureReason;
    }
  | {
      kind: 'rejected';
      reason: QuestionRejection;
    };
export type FormResult =
  | {
      action: 'accept';
      values: {
        [k: string]: FormValue | undefined;
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
    };
export type QuestionRejection = 'invalid_input' | 'unavailable';
export type AgentContextRequestState = 'requested' | 'completed' | 'interrupted';
/**
 * Read-only completion context before or after a conversation is created.
 */
export type AgentCompletionTarget =
  | {
      kind: 'session';
      sessionId: string;
    }
  | {
      kind: 'draft';
      workspace: AgentWorkspaceSelection | null;
    };
export type AgentFileKind = 'file' | 'directory' | 'symlink' | 'other';
export type AgentFileChange =
  | {
      kind: 'ready';
      directoryIdentity: string;
    }
  | {
      kind: 'changed';
    }
  | {
      kind: 'unavailable';
      reason: AgentFileUnavailable;
    };
export type AgentFileUnavailable = 'directory_changed';
export type GitArea = 'staged' | 'worktree' | 'untracked';
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'type_changed' | 'conflicted';
export type GitDiff =
  | {
      kind: 'text';
      patch: string;
    }
  | {
      kind: 'binary';
    }
  | {
      kind: 'unchanged';
    }
  | {
      kind: 'unsupported';
    };
/**
 * Ephemeral output observation; Closed is not a process cleanup receipt.
 */
export type TerminalOutputEvent =
  | {
      kind: 'data';
      sequence: number;
      size: TerminalSize;
      initialSize: TerminalSize;
      dataBase64: string;
    }
  | {
      kind: 'resize';
      sequence: number;
      size: TerminalSize;
      initialSize: TerminalSize;
    }
  | {
      kind: 'pending';
      after: number;
      size: TerminalSize;
      initialSize: TerminalSize;
    }
  | {
      kind: 'closed';
      after: number;
      size: TerminalSize;
      initialSize: TerminalSize;
    }
  | {
      kind: 'unavailable';
      reason: TerminalOutputUnavailable;
    };
export type TerminalOutputUnavailable = 'not_retained';
export type TerminalOutcome_TerminalOutputEvent =
  | {
      kind: 'completed';
      value: TerminalOutputEvent;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type RawAction =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'paste';
      text: string;
    }
  | {
      type: 'key';
      key: string;
      modifiers?: TerminalModifiers;
    }
  | {
      type: 'mouse';
      event: RawEvent;
      x: number;
      y: number;
      button?: MouseButton;
      direction?: ScrollDirection;
      modifiers?: TerminalModifiers;
    };
/**
 * @maxItems 3
 */
export type TerminalModifiers =
  | []
  | [Modifier]
  | [Modifier, Modifier]
  | [Modifier, Modifier, Modifier];
export type Modifier = 'ctrl' | 'alt' | 'shift';
export type RawEvent = 'click' | 'press' | 'release' | 'move' | 'scroll';
export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down';
export type Ownership =
  | {
      kind: 'local';
    }
  | {
      kind: 'source_owned';
      sourceSessionId: string;
      ownerSessionId: string;
    }
  | {
      kind: 'source_unavailable';
      sourceSessionId: string;
    };
export type ShellVisibility = 'model' | 'user';
export type SnapshotKind = 'shell_run';
export type ShellMode = 'pipes' | 'pty';
export type ShellStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'orphaned';
export type ShellOutput =
  | {
      mode: 'pipes';
      stdout: string;
      stderr: string;
      latestStream?: PipeStream;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      redacted: boolean;
    }
  | {
      mode: 'pty';
      screen: string;
      scrollback: string;
      lastAlternateScreen?: string;
      cols: number;
      rows: number;
      cursor: TerminalCursor;
      alternateScreen: boolean;
      truncated: boolean;
      redacted: boolean;
    };
export type PipeStream = 'stdout' | 'stderr';
export type TerminalOutcome_TerminalPage =
  | {
      kind: 'completed';
      value: TerminalPage;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type TerminalOutcome_ResourceUpdate =
  | {
      kind: 'completed';
      value: ResourceUpdate;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type TerminalOutcome_TerminalLeaseUpdate =
  | {
      kind: 'completed';
      value: TerminalLeaseUpdate;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type TerminalOutcome_TerminalControlReceipt =
  | {
      kind: 'completed';
      value: TerminalControlReceipt;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type TerminalOutcome_TerminalReleased =
  | {
      kind: 'completed';
      value: TerminalReleased;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type TerminalOutcome_TerminalStopped =
  | {
      kind: 'completed';
      value: TerminalStopped;
    }
  | {
      kind: 'failed';
      message: string;
    };
export type QuestionResult =
  | {
      kind: 'answered';
      answers: QuestionResponse[];
    }
  | {
      kind: 'closed';
      reason: ClosureReason;
    }
  | {
      kind: 'rejected';
      reason: QuestionRejection;
    };
export type AgentSendResult =
  | {
      kind: 'rejected';
      sessionId: string;
      reason: AgentSendRejection;
      skills?: SkillInvocationResult | null;
    }
  | {
      kind: 'started';
      sessionId: string;
      runId: RunId;
      messageId: string;
      completion?: AgentCompletionRegistration | null;
    }
  | {
      kind: 'queued';
      sessionId: string;
      messageId: string;
      revision: number;
      completion?: AgentCompletionRegistration | null;
    }
  | {
      kind: 'not_your_worker';
      sessionId: string;
    };
export type AgentSendRejection =
  | 'model_unavailable'
  | 'skills_unavailable'
  | 'turn_stopped'
  | 'original_operation_unsettled';
export type AgentCompletionRegistration = 'registered';
export type AgentDeliveryFact =
  | {
      kind: 'opened';
    }
  | {
      kind: 'executor_started';
    }
  | {
      kind: 'executor_message_started';
      messageId: string;
      stepId: StepId;
      attemptId: ModelAttemptId;
    }
  | {
      kind: 'executor_text_changed';
      messageId: string;
      thinking: boolean;
    }
  | {
      kind: 'transcript_changed';
    }
  | {
      kind: 'step_ended';
      stepId: StepId;
      attemptId: ModelAttemptId;
      /**
       * The model/executor completed; this says nothing about tool business success.
       */
      completed: boolean;
    }
  | {
      kind: 'part_committed';
      stepId: StepId;
      attemptId: ModelAttemptId;
      messageId: string;
      ordinal: number;
    }
  | {
      kind: 'delta';
      stepId: StepId;
      attemptId: ModelAttemptId;
      partId: string;
      text: string;
    }
  | {
      kind: 'tool_input_ready';
      toolUseId: string;
      stepId: StepId;
      attemptId: ModelAttemptId;
      name: string;
      providerExecuted: boolean;
    }
  | {
      kind: 'tool_dispatched';
      toolUseId: string;
      name: string;
      title?: DisplayText | null;
    }
  | {
      kind: 'tool_rejected';
      toolUseId: string;
    }
  | {
      kind: 'tool_settled';
      toolUseId: string;
      settlement: ToolSettlement;
    }
  | {
      kind: 'provider_tool_result';
      toolUseId: string;
      isError: boolean;
    }
  | {
      kind: 'executor_tool_start';
      toolUseId: string;
      name: string;
      title?: DisplayText | null;
    }
  | {
      kind: 'executor_tool_progress';
      toolUseId: string;
      /**
       * The most recent at most 2048 codepoints of reported progress, not the complete result.
       */
      text: string;
    }
  | {
      kind: 'executor_tool_result';
      toolUseId: string;
      isError: boolean;
    }
  | {
      kind: 'ended';
      failed: boolean;
    };
/**
 * Recorded Host settlement for presentation; returned is not business success.
 * Foreign/provider results do not establish this Host evidence.
 */
export type ToolSettlement = 'returned' | 'failed' | 'unknown' | 'rejected';
export type AgentContentKind = 'text' | 'thinking';
/**
 * Execution kind frozen at admission, independent of the next-turn preference.
 */
export type AgentRunBackend = 'model' | 'executor';
export type AgentRunState = 'admitted' | 'running' | 'waiting_for_user';
export type AgentDiagnosticPosition =
  | {
      kind: 'latest';
    }
  | {
      kind: 'before';
      through: number;
      sequence: number;
    };
export type DiagnosticDetail =
  | {
      kind: 'execution';
      execution: ExecutionIdentity;
      reason: ExecutionFailureReason;
      modelFailure?: ModelFailureCause | null;
    }
  | {
      kind: 'model_step';
      execution: ExecutionIdentity;
      stepId: StepId;
      attemptId: ModelAttemptId;
      status: ModelInterruption;
      modelFailure?: ModelFailureCause | null;
    }
  | {
      kind: 'session_title';
      execution: ExecutionIdentity;
      cause: TitleFailureCause;
    };
export type ExecutionFailureReason =
  | 'session_busy'
  | 'continuation_changed'
  | 'reconciliation_required'
  | 'invalid_input'
  | 'cancelled'
  | 'model_incomplete'
  | 'model_interrupted'
  | 'event_commit'
  | 'event_store'
  | 'model_timeout'
  | 'model_http'
  | 'model_adapter'
  | 'model_provider'
  | 'context_overflow'
  | 'tool_execution'
  | 'runtime_internal'
  | 'cleanup_unconfirmed'
  | 'executor'
  | 'message_preparation_failed'
  | 'host_interrupted'
  | 'outcome_unknown'
  | 'execution_failed';
/**
 * Safe failure evidence, separate from provider-owned diagnostic text.
 */
export type ModelFailureCause =
  | {
      kind: 'http';
      status: number;
    }
  | {
      kind: 'timed_out';
    }
  | {
      kind: 'context_overflow';
    }
  | {
      kind: 'provider';
      reason: ProviderFailureReason;
      retry_at_unix_ms?: number | null;
    }
  | {
      kind: 'adapter';
    };
export type ProviderFailureReason =
  | 'network'
  | 'timed_out'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'provider_unavailable'
  | 'stream_truncated';
export type ModelInterruption =
  | ('steered' | 'cancelled' | 'timed_out' | 'failed')
  | 'retryable_failure';
export type TitleFailureCause =
  | {
      kind: 'preparation';
    }
  | {
      kind: 'model';
      cause: ModelFailureCause;
    }
  | {
      kind: 'invalid_output';
    }
  | {
      kind: 'output_limit';
    }
  | {
      kind: 'empty_output';
    };
/**
 * Row reveals an exact field; Before/After continue at byte boundaries and
 * Event addresses the raw event log. Returned chunks retain ascending presentation
 * order, including a reverse window.
 */
export type HistoryPosition =
  | {
      kind: 'start';
    }
  | {
      kind: 'tail';
    }
  | {
      kind: 'row';
      position: HistoryRowAddress;
      field: HistoryField;
    }
  | {
      kind: 'before';
      cursor: Cursor;
    }
  | {
      kind: 'after';
      cursor: Cursor;
    }
  | {
      kind: 'event';
      sequence: number;
    };
/**
 * A readable field in a conversation window, in presentation order.
 */
export type HistoryField = 'thinking' | 'body';
/**
 * Tool output is available through source reads in both views. Conversation
 * windows carry tool metadata only, keeping large results out of chat paging.
 */
export type HistoryView = 'text' | 'conversation';
/**
 * Trusted producer attribution, preserved independently of editable content.
 */
export type MessageOrigin =
  | {
      kind: 'session_completion';
      sessionId: string;
      messageId: string;
    }
  | {
      kind: 'session';
      execution: ExecutionIdentity;
    }
  | {
      kind: 'goal';
      goalId: string;
      objective: string;
    }
  | {
      kind: 'bot_worker';
      sessionId: string;
    };
export type AgentDeliveryPage =
  | {
      kind: 'events';
      through: number;
      nextAfter: number;
      events: AgentDelivery[];
    }
  | {
      kind: 'preview';
      page: AgentPreviewPage;
    }
  | {
      kind: 'queue';
      queue: AgentQueue;
    }
  | {
      kind: 'interactions';
      pending: AgentPendingInteractions;
    }
  | {
      kind: 'computer_apps';
      apps: AgentComputerApps;
    };
/**
 * Current display material, independent of the durable Events cursor.
 */
export type AgentPreviewPage =
  | {
      kind: 'empty';
      hostEpoch: string;
    }
  | {
      kind: 'cut';
      hostEpoch: string;
      runId: RunId;
      turnId: string;
      stepId: StepId;
      attemptId: ModelAttemptId;
      revision: number;
      dependsOn: number;
      first: boolean;
      last: boolean;
      parts: AgentPreviewPart[];
    };
export type AgentPreviewField =
  | {
      kind: 'text';
      textKind: AgentContentKind;
      finalAnswer?: boolean;
    }
  | {
      kind: 'tool_input';
      toolUseId: string;
      name: string;
      providerExecuted: boolean;
    };
export type AgentQueueKind = 'in_flight' | 'steering' | 'followup';
export type AgentQueueMessageResult =
  | {
      kind: 'ready';
      revision: number;
      hasAttachments: boolean;
      message: string;
    }
  | {
      kind: 'revision_conflict';
      expected: number;
      actual: number;
    }
  | {
      kind: 'missing';
      reason: AgentQueueMessageMissingReason;
    };
export type AgentQueueMessageMissingReason = 'delivered' | 'cancelled' | 'unknown';
export type AgentQueueAction =
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
export type AgentQueueMutationResult =
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
      reason: AgentQueueRejection;
    };
export type AgentQueueRejection =
  | 'not_your_message'
  | 'closed'
  | 'missing'
  | 'in_flight'
  | 'invalid_edit'
  | 'execution_changed'
  | 'not_running';
/**
 * Model identity recorded for the exact historical assistant step.
 */
export type HistoryModel =
  | {
      kind: 'native';
      requestedModelId: string;
      reportedModelId: string | null;
    }
  | {
      kind: 'imported';
      modelId: string;
    };
export type AttachmentKind = 'image' | 'pdf' | 'doc' | 'code' | 'other';
export type HistoryTurnOutcome = 'completed' | 'failed' | 'aborted';
/**
 * Canonical message author/kind; the field identifies body versus thinking.
 * Tool body JSON contributes string values, never its keys.
 */
export type Role =
  | 'system'
  | 'context'
  | 'tool'
  | 'compaction'
  | 'failure'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result';
/**
 * Who made a call: a model step, a script the model wrote, a tool's own work
 * through the Host SDK, or a foreign record.
 */
export type HistoryToolCallOrigin = 'provider' | 'executor' | 'code_mode' | 'host_sdk' | 'imported';
export type ExternalToolTarget =
  | {
      kind: 'command';
      command: string;
      cwd?: string | null;
    }
  | {
      kind: 'file';
      path: string;
    }
  | {
      kind: 'search';
      query: string;
    };
export type AgentHistoryPage = {
  kind: 'ready';
  through: number | null;
  chunks: AgentHistoryChunk[];
  before: Cursor | null;
  after: Cursor | null;
};
export type AgentHistorySearchPage = {
  kind: 'ready';
  through: number;
  /**
   * @maxItems 16
   */
  matches:
    | []
    | [AgentHistoryMatch]
    | [AgentHistoryMatch, AgentHistoryMatch]
    | [AgentHistoryMatch, AgentHistoryMatch, AgentHistoryMatch]
    | [AgentHistoryMatch, AgentHistoryMatch, AgentHistoryMatch, AgentHistoryMatch]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ]
    | [
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
        AgentHistoryMatch,
      ];
  /**
   * Continue even when this batch has no matches. Null is the end of the scan.
   */
  nextAfter: HistoryRowAddress | null;
};
/**
 * An explicitly selected canonical transcript field, never an execution grant.
 */
export type SourceField =
  | ('body' | 'thinking' | 'tool_name' | 'failure_message' | 'error_class' | 'arguments' | 'result')
  | 'receipt'
  | 'provider_metadata'
  | 'original';
export type AgentHistorySourceReference =
  | {
      kind: 'row';
      position: HistoryRowAddress;
    }
  | {
      kind: 'tool_use';
      toolUseId: string;
    };
/**
 * A structural selector into an original JSON field. Keys and array indices
 * remain distinct; neither locates a filesystem resource nor grants access.
 */
export type HistorySourceSegment = string | number;
export type SourcePosition =
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
export type AgentHistorySourcePage = {
  kind: 'ready';
  through: number;
  source: HistorySource;
  /**
   * Complete file-path evidence resolved on the Host for copying only.
   * This is display text, never a filesystem capability or open command.
   */
  filePath?: string | null;
};
/**
 * Presentation role of the exact row. This carries no execution authority.
 */
export type HistorySourceRole =
  | 'system'
  | 'context'
  | 'tool'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'failure';
export type SourceFormat = 'text' | 'json' | 'image_descriptor';
/**
 * Bounded image bytes from a selected subscription. Complete is a producer
 * return value, never an emitted item or an executor-cleanup acknowledgement.
 */
export type AgentToolImageFrame =
  | {
      kind: 'chunk';
      mimeType: string;
      totalBytes: number;
      offset: number;
      data: string;
    }
  | {
      kind: 'complete';
      detail?: ImageDetail | null;
    };
export type ImageDetail = 'auto' | 'low' | 'high' | 'original';
export type AgentToolImagePage = {
  kind: 'ready';
  through: number;
  position: HistoryRowAddress;
  offset: number;
  totalBytes: number;
  mimeType: string;
  digest: string;
  /**
   * Standard padded Base64 of at most 32KiB of encoded image bytes.
   */
  data: string;
};
export type AgentAttachmentImageSource =
  | {
      kind: 'uploaded';
      id: string;
    }
  | {
      kind: 'history';
      through: number;
      position: HistoryRowAddress;
      attachmentIndex: number;
    };
export type AgentAttachmentImagePage = {
  kind: 'ready';
  source: AgentAttachmentImageSource;
  offset: number;
  totalBytes: number;
  mimeType: string;
  digest: string;
  /**
   * Standard padded Base64 of at most 32KiB of encoded image bytes.
   */
  data: string;
};
/**
 * Resource names select slots in the current request, not durable grants.
 */
export type HostRequest =
  | {
      operation: 'stateRead';
      key: string;
    }
  | {
      operation: 'stateScan';
      query: Scan;
    }
  | {
      operation: 'completeState';
      mutations: Mutation[];
      value: unknown;
    }
  | {
      operation: 'emit';
      value: unknown;
    }
  | {
      operation: 'call';
      import: string;
      provider: number;
      method: string;
      input: unknown;
      attachments: {
        [k: string]: string | undefined;
      };
    }
  | {
      operation: 'mutate';
      import: string;
      provider: number;
      method: string;
      input: unknown;
      operationId: string;
      recovery: unknown;
      attachments: {
        [k: string]: string | undefined;
      };
    }
  | {
      operation: 'lookupIntent';
      operationId: string;
    }
  | {
      operation: 'recover';
      reference: RecoveryRef;
    }
  | {
      operation: 'metadata';
      slot: string;
    }
  | {
      operation: 'read';
      slot: string;
      start: number;
      end: number;
    };
export type Data =
  | {
      kind: 'present';
      value: unknown;
    }
  | {
      kind: 'deleted';
    };
export type Identity2 =
  | {
      kind: 'native';
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent';
      execution: ExecutionIdentity;
      operationId?: string | null;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'remote';
      requestId: string;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'background';
      grant: Id;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'browser_lease';
      sessionId: string;
      turnId: string;
      [k: string]: unknown | undefined;
    };
/**
 * Resolving a reference requires the original package/scope, a live activation,
 * an unrevoked Host record and the issuing principal's current authorization.
 */
export type Id = string;

export interface ClientDraft {
  revision: number;
  text: string;
  attachments: ClientDraftAttachment[];
  quotes?: QuoteRef[];
}
/**
 * Display metadata for an immutable Host upload in this exact draft owner.
 */
export interface ClientDraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
}
export interface QuoteRef {
  sourceMessageId?: string | null;
  text: string;
  label?: string | null;
  sourceTurnId?: string | null;
  source?: SessionQuoteSource | null;
}
/**
 * Display provenance of an immutable excerpt, never authority to read its source.
 */
export interface SessionQuoteSource {
  sessionId: string;
  sessionName: string;
  capturedAt: CaptureTime;
  truncated: boolean;
}
/**
 * One complete editor revision, including the upload receipts it has handled.
 */
export interface ClientDraftEdit {
  text: string;
  quotes?: QuoteRef[];
  attachments?: ClientDraftAttachment[];
  settledUploads?: string[];
}
/**
 * Stable product owner, independent of endpoint aliases, VM instances and UI nodes.
 */
export interface ClientDraftKey {
  stateDomain: string;
  deployment: string;
  namespace: InstanceId;
  export: string;
  sessionId: string;
  editorId: string;
}
export interface ClientDraftReference {
  key: ClientDraftKey;
  revision: number;
}
export interface ClientUploadReference {
  key: ClientDraftKey;
  name: string;
  bytes: number;
  digest: string;
}
/**
 * One user attempt. Neither this observation nor its original reference grants access.
 */
export interface ClientOperation {
  id: string;
  host: DeploymentRef;
  endpoint: string;
  method: string;
  sessionId?: string | null;
  correlation: unknown;
  draft?: ClientDraftReference | null;
  upload?: ClientUploadReference | null;
  /**
   * Durable fence proving that this attempt did not dispatch.
   */
  abandoned: boolean;
  /**
   * Present only after original preparation has been durably recorded.
   */
  reference?: RecoveryRef | null;
  /**
   * A terminal business outcome; absent is never proof that it did not run.
   */
  receipt?: Receipt | null;
}
export interface DeploymentRef {
  stateDomain: string;
  deployment: string;
  revision: number;
}
export interface RecoveryRef {
  source: DeploymentRef;
  namespace: InstanceId;
  export: string;
  method: string;
  operation: string;
  fingerprint: string;
  contract: RecoveryContract;
  recovery: RecoveryProtocol;
}
/**
 * Contract identity for a journal lookup. The original request retains the
 * complete contract; a receipt carries only its digest.
 */
export interface RecoveryContract {
  name: string;
  version: number;
  transport: Transport;
  digest: string;
}
export interface HostLogRequest {
  position: HostLogPosition;
}
/**
 * Durable deployment input. Plans are derived and never persisted as overrides.
 */
export interface CompositionInput {
  /**
   * Optional immutable root composition. Its children remain deployment roots,
   * so selecting a baseline does not prepend a namespace to instance identities.
   */
  base?: RootComposition | null;
  instances: {
    [k: string]: CompositionNode | undefined;
  };
  ui?: UiTarget | null;
}
/**
 * A composition selected at deployment scope, without introducing an instance.
 * Additional roots remain in Input.instances; inherited roots are edited with overrides.
 */
export interface RootComposition {
  package: PackageRef;
  parameters?: {
    [k: string]: unknown | undefined;
  };
  overrides?: Override[];
  /**
   * Absent inherits the template UI; null explicitly selects no UI.
   */
  ui?: UiTarget | null;
}
export interface PackageRef {
  id: string;
  revision: string;
}
/**
 * An override belongs to its containing structural instance. Missing paths fail;
 * removal/upgrade never guesses how to discard independent user intent.
 */
export interface Override {
  path: string[];
  /**
   * A persistent deletion, distinct from disabling an instance.
   */
  remove?: boolean;
  package?: PackageRef | null;
  usePackage?: PackageUse | null;
  parameters?: {
    [k: string]: unknown | undefined;
  };
  configuration?: {
    [k: string]: unknown | undefined;
  };
  configurationFields?: ConfigurationField[];
  bindings?: {
    [k: string]: Target[] | undefined;
  };
  disabled?: boolean | null;
}
/**
 * An exact object-field edit. Missing value deletes the field; JSON null is a value.
 */
export interface ConfigurationField {
  path: string[];
  value?: unknown;
}
export interface UiTarget {
  path: string[];
  id: string;
}
export interface CompositionNode {
  key: string;
  package: PackageSelection;
  usePackage: PackageUse;
  configuration?: Configuration;
  parameters?: Configuration;
  bindings?: {
    [k: string]: Target[] | undefined;
  };
  disabled?: boolean;
  overrides?: Override[];
}
export interface Configuration {
  values?: {
    [k: string]: unknown | undefined;
  };
  /**
   * Configuration field -> parameter name of the containing template.
   */
  parameters?: {
    [k: string]: string | undefined;
  };
}
export interface Deployment {
  reference: DeploymentRef;
  input: CompositionInput;
  remoteExports: RemoteObservation[];
}
/**
 * A static compatibility observation, never a remote registration or grant.
 */
export interface RemoteObservation {
  capability: RemoteCapability;
  declaration: Export;
}
export interface RemoteCapability {
  deployment: string;
  instance: InstanceId;
  export: string;
}
export interface Export {
  contract: Contract;
  availability: Availability;
}
/**
 * Public contract definitions are package data, not live registration records.
 */
export interface Contract {
  name: string;
  version: number;
  transport: Transport;
  interface: Interface;
}
export interface Method {
  mode: MethodMode;
  input: unknown;
  output: unknown;
  /**
   * Bounded transient observations from this mutation, separate from its
   * original final receipt. Only mutation methods may declare progress.
   */
  progress?: {
    [k: string]: unknown | undefined;
  };
  resources: {
    [k: string]: ResourceSlot | undefined;
  };
}
/**
 * One declared input slot: its nominal type and whether the caller may omit it.
 */
export interface ResourceSlot {
  type: ResourceType;
  optional: boolean;
}
/**
 * Nominal read-only resource shape, not a resource id or authorization token.
 */
export interface ResourceType {
  name: string;
  version: number;
}
export interface DeploymentRead {}
/**
 * UI contributions derived from one committed deployment source.
 */
export interface UiRead {
  source?: DeploymentRef | null;
}
export interface UiWatch {
  source: DeploymentRef;
}
export interface UiInstance {
  instance: InstanceId;
  path: string[];
  package: PackageRef;
  configuration: unknown;
  module: string;
  definitionBasis: string;
  bindingBasis: string;
  imports: {
    [k: string]: number | undefined;
  };
  contributions: {
    [k: string]: UiContribution | undefined;
  };
}
export interface UiText {
  fallback: string;
  translations?: {
    [k: string]: string | undefined;
  };
}
export interface UiCatalog {
  source: DeploymentRef;
  ui?: UiRoot | null;
  instances: UiInstance[];
}
export interface UiRoot {
  instance: InstanceId;
  id: string;
}
export interface PackageInstall {
  expectedRevision: number;
}
export interface PackageInstalled {
  source: DeploymentRef;
  package: PackageRef;
}
export interface DeploymentReplace {
  expectedRevision: number;
}
/**
 * Committed desired source and available immutable packages, not runtime readiness.
 */
export interface ManagedDeployment {
  source: Deployment;
  packages: PackageRef[];
}
export interface ManagedInstancesPage {
  source: DeploymentRef;
  /**
   * @maxItems 8
   */
  instances:
    | []
    | [ManagedInstance]
    | [ManagedInstance, ManagedInstance]
    | [ManagedInstance, ManagedInstance, ManagedInstance]
    | [ManagedInstance, ManagedInstance, ManagedInstance, ManagedInstance]
    | [ManagedInstance, ManagedInstance, ManagedInstance, ManagedInstance, ManagedInstance]
    | [
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
      ]
    | [
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
      ]
    | [
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
        ManagedInstance,
      ];
  next?: InstanceId | null;
}
export interface ManagedInstance {
  instance: InstanceId;
  path: string[];
  package: PackageRef;
  presentation?: PackagePresentation;
  structural: boolean;
  disabled: boolean;
  parentDisabled: boolean;
}
export interface PackagePresentation {
  displayName: string;
  description: string;
  localizations?: {
    [k: string]: PackageDescription | undefined;
  };
}
/**
 * Author-provided copy for plugin discovery; never an authority declaration.
 */
export interface PackageDescription {
  displayName: string;
  description: string;
}
export interface InstanceSetEnabled {
  expectedRevision: number;
  instance: InstanceId;
  enabled: boolean;
}
/**
 * Source document edited by one native buffer, never a second desired plan.
 */
export interface DeploymentDocument {
  input: CompositionInput;
  remoteExports: RemoteObservation[];
  packages: PackageRef[];
}
export interface DeploymentDocumentRead {
  source: DeploymentRef;
  offset: number;
}
export interface InstanceSettingsRead {
  source: DeploymentRef;
  instance: InstanceId;
  path: string[];
  after?: string | null;
}
export interface InstanceSettingsPage {
  source: DeploymentRef;
  instance: InstanceId;
  path: string[];
  /**
   * @maxItems 8
   */
  fields:
    | []
    | [SettingField]
    | [SettingField, SettingField]
    | [SettingField, SettingField, SettingField]
    | [SettingField, SettingField, SettingField, SettingField]
    | [SettingField, SettingField, SettingField, SettingField, SettingField]
    | [SettingField, SettingField, SettingField, SettingField, SettingField, SettingField]
    | [
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
      ]
    | [
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
        SettingField,
      ];
  next?: string | null;
}
export interface SettingField {
  key: string;
  label: string;
  description: string;
  kind: SettingKind;
  present: boolean;
  required: boolean;
  nullable: boolean;
  editable: boolean;
  value?: SettingValue | null;
  options: SettingValue[];
}
export interface InstanceConfigure {
  expectedRevision: number;
  instance: InstanceId;
  /**
   * @minItems 1
   */
  changes: [SettingChange, ...SettingChange[]];
}
export interface SettingChange {
  /**
   * @minItems 1
   */
  path: [string, ...string[]];
  /**
   * None removes the field; all other fields retain their original source.
   */
  value?: SettingValue | null;
}
export interface InstanceConfigureBatch {
  expectedRevision: number;
  /**
   * @minItems 1
   */
  edits: [InstanceConfigureEdit, ...InstanceConfigureEdit[]];
}
export interface InstanceConfigureEdit {
  instance: InstanceId;
  /**
   * @minItems 1
   */
  changes: [SettingChange, ...SettingChange[]];
}
export interface BindingCandidatesRead {
  source?: DeploymentRef | null;
  consumer: BindingConsumer;
  import: string;
  includePackages: boolean;
  after?: string | null;
}
export interface BindingCandidatesPage {
  source: DeploymentRef;
  configuration: {
    [k: string]: unknown | undefined;
  };
  current: Target[];
  candidates: BindingCandidate[];
  next?: string | null;
}
export interface PackageSettingsRead {
  source: DeploymentRef;
  package: PackageRef;
  usePackage: PackageUse;
  path: string[];
  after?: string | null;
  changes: SettingChange[];
}
export interface PackageSettingsPage {
  source: DeploymentRef;
  package: PackageRef;
  path: string[];
  fields: SettingField[];
  next?: string | null;
  imports: ManagedImport[];
}
export interface ManagedImport {
  name: string;
  contract: string;
  cardinality: Cardinality;
}
export interface CompositionEdit {
  expectedRevision: number;
  edits: CompositionChange[];
}
export interface DeploymentDocumentChunk {
  source: DeploymentRef;
  offset: number;
  totalBytes: number;
  text: string;
  next?: number | null;
}
export interface PackageDeclaration {
  host?: EntryDeclaration | null;
  ui?: UiEntry | null;
  composition?: Template | null;
}
export interface EntryDeclaration {
  implementation: Implementation;
  configuration: unknown;
  imports?: {
    [k: string]: Import | undefined;
  };
  exports?: {
    [k: string]: Export | undefined;
  };
}
export interface Import {
  contract: Contract;
  cardinality: Cardinality;
}
export interface UiEntry {
  module: string;
  configuration: unknown;
  imports?: {
    [k: string]: Import | undefined;
  };
  contributions: {
    [k: string]: UiContribution | undefined;
  };
}
export interface Template {
  /**
   * Default UI selection when this template is used at deployment scope.
   */
  ui?: UiTarget | null;
  parameters?: {
    [k: string]: Parameter | undefined;
  };
  imports?: {
    [k: string]: Import | undefined;
  };
  exports?: {
    [k: string]: Target | undefined;
  };
  children: {
    [k: string]: CompositionNode | undefined;
  };
}
export interface Parameter {
  schema: unknown;
  default?: unknown;
}
export interface CallerIntent {
  cursor: number;
  caller: DeploymentRef;
  consumer: InstanceId;
  reference: RecoveryRef;
  recovery?: unknown;
}
export interface AgentConfiguration {
  /**
   * Explicitly trusted MCP servers. Catalogs are captured on Agent activation.
   */
  mcpServers?: McpServerConfiguration[];
  /**
   * Deployment locale fallback; saved Root preference takes precedence.
   */
  locale?: string;
  /**
   * Defer optional tool schemas until the model discovers them. This affects
   * presentation only; every call still uses its current authorized binding.
   */
  toolDiscovery?: boolean;
  /**
   * Permit creation of Host-owned Git worktrees from published directories.
   */
  isolatedWorkspaces?: boolean;
  /**
   * Select Maka's assistant policy and workspace guidance explicitly.
   */
  assistant?: AgentAssistantConfiguration | null;
  /**
   * Enable model proposals and approved scheduled work for this Agent.
   */
  scheduledTasks?: boolean;
  /**
   * Enable explicitly approved Goal continuation.
   */
  goals?: boolean;
  /**
   * Enable the session-scoped, model-maintained checklist.
   */
  todo?: boolean;
  /**
   * Enable the Bot mode: one persistent Session that reaches its user only
   * through `SendUser`, with a Host-owned outbox.
   */
  bot?: boolean;
  /**
   * Generate a bounded auxiliary title for automatically named conversations.
   */
  automaticTitles?: boolean;
  /**
   * Enable explicit, bounded session recap requests and cached reads.
   */
  recaps?: boolean;
  /**
   * Explicit access to this Agent’s earlier conversations for model tools.
   */
  recall?: boolean;
  /**
   * Explicit service backends; discovery does not authorize execution.
   */
  executors?: AgentServiceExecutor[];
  external?: AgentExternalConfiguration | null;
  /**
   * Explicit Library import for immutable skill input preparation and metadata.
   * This does not select model tools or confer a service grant.
   */
  skillLibrary?: string | null;
  /**
   * Initial policy within the selected workspace capability.
   */
  permissions: AgentWorkspacePermissions;
  /**
   * Installation-published directories, captured without creating workspace markers.
   */
  workspaceRoots: DirectoryRootSpec[];
  /**
   * Explicit read-only roots for user-selected conversation sources.
   */
  importRoots?: DirectoryRootSpec[];
  /**
   * Explicitly selected, frozen application service tools, alongside configured native tools.
   */
  tools: AgentServiceTool[];
}
/**
 * Explicit trust for an external MCP server; tool annotations never expand it.
 * Installation changes require reactivation; client subscriptions own their scope.
 */
export interface McpServerConfiguration {
  /**
   * Stable namespace, using ASCII letters, digits, underscores and hyphens.
   */
  name: string;
  transport: McpTransport;
  /**
   * Omitted selects all tools discovered from this explicitly trusted server.
   */
  tools?: string[] | null;
  /**
   * Explicitly permit these remote tools in read-only workspaces.
   * The server's readOnlyHint is descriptive and cannot grant this access.
   */
  readOnlyTools?: string[];
  /**
   * Skip per-call confirmation only when the installer explicitly grants it.
   */
  preapproved?: boolean;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}
export interface AgentAssistantConfiguration {
  /**
   * Select this home for global instructions and explicit AGENTS.md editing.
   */
  home?: string | null;
}
export interface AgentServiceExecutor {
  name: string;
  import: string;
  /**
   * Exact member of the explicitly bound import, never a discovery index.
   */
  member?: number;
  setup?: ExecutorSetupBinding | null;
}
export interface ExecutorSetupBinding {
  import: string;
  member?: number;
}
/**
 * Explicit opt-in to the three CLIs' native full-access tools and permissions.
 */
export interface AgentExternalConfiguration {
  runtimes?: AgentNativeRuntimeSwitches;
  commands?: AgentNativeCommands;
}
export interface AgentNativeRuntimeSwitches {
  antigravity?: boolean;
  codex?: boolean;
  claude?: boolean;
}
export interface AgentNativeCommands {
  antigravity?: AgentNativeCommand | null;
  codex?: AgentNativeCommand | null;
  claude?: AgentNativeCommand | null;
}
/**
 * Ordinary launch overrides. Authentication remains in the native CLI login store.
 */
export interface AgentNativeCommand {
  executable: string;
  args?: string[];
  env?: {
    [k: string]: string | undefined;
  };
}
export interface AgentWorkspacePermissions {
  access: AgentWorkspaceAccess;
  requestPermissions: boolean;
}
export interface DirectoryRootSpec {
  label: string;
  path: string;
}
export interface AgentServiceTool {
  /**
   * Allow this selected service inside Code Mode. Binding and permission
   * checks are identical to a direct call; omitted keeps direct-only behavior.
   */
  nestable?: boolean;
  /**
   * Explicit input projection. Skill tools receive the actual Agent tool names,
   * outside model-controlled arguments; this is compatibility data, not authority.
   */
  input?: AgentToolInput & string;
  /**
   * Explicit versioned renderer key, frozen with the call; never inferred from its name.
   */
  presentation?: string | null;
  /**
   * Display only; the selected name, contract and binding still identify execution.
   */
  title?: DisplayText | null;
  /**
   * Explicit model projection; JSON data never implicitly grants image access.
   */
  result: AgentToolResult;
  /**
   * Additional user consent for this exact call; service grants remain independent.
   */
  confirmation: AgentToolConfirmation;
  name: string;
  description: string;
  target: ServiceTarget;
  method: string;
}
/**
 * Presentation text is distinct from the stable identity used for navigation.
 */
export interface DisplayText {
  fallback: string;
  translations?: {
    [k: string]: string | undefined;
  };
}
export interface WorkspaceDecisionsApiConfiguration {
  network: Network;
}
/**
 * Destination authority, independent of the upstream proxy used to reach it.
 * A domain grant does not authorize its subdomains or other ports.
 */
export interface Destination {
  host: string;
  port: number;
}
export interface DecisionsApiSet {
  revision?: number | null;
  settings: DecisionsSettings;
}
export interface DecisionsSettings {
  protocol: DecisionsProtocol;
  enabled: boolean;
  url: string;
  model: string;
  timeoutMs: number;
}
export interface DecisionsApiCredential {
  url: string;
  revision?: number | null;
  target: DecisionsApiCredentialTarget;
  change: DecisionsApiCredentialChange;
}
export interface DecisionsSnapshot {
  revision?: number | null;
  settings: DecisionsSettings;
  credentialRevision?: number | null;
  configured: boolean;
  apiKeyConfigured: boolean;
  headerNames: string[];
  [k: string]: unknown | undefined;
}
export interface DecisionsEvaluation {
  input: unknown;
  questions: {
    [k: string]: DecisionsQuestion | undefined;
  };
}
export interface DecisionsChoice {
  value: DecisionsChoiceValue;
  description?: unknown;
}
export interface DecisionsLevel {
  label: string;
  description?: unknown;
}
export interface DecisionsEvaluationResult {
  model: string;
  answers: {
    [k: string]: DecisionsAnswer | undefined;
  };
  usage: DecisionsUsage;
}
export interface DecisionsChoiceProbability {
  value: DecisionsChoiceValue;
  probability: number;
}
export interface DecisionsScoreProbability {
  value: number;
  label: string;
  probability: number;
}
export interface DecisionsUsage {
  input_tokens: number;
  output_tokens: number;
}
export interface WorkspaceWebConfiguration {
  network: Network;
}
export interface WebCapture {
  basis: WebBasis;
  available: boolean;
  source: WebSource;
  credentialConfigured: boolean;
}
export interface WebBasis {
  revision?: number | null;
  credentialRevision?: number | null;
}
export interface WebCall_WebFetch {
  basis: WebBasis;
  input: WebFetch;
}
export interface WebFetch {
  url: string;
}
export interface WebCall_WebQuery {
  basis: WebBasis;
  input: WebQuery;
}
export interface WebQuery {
  query: string;
  limit?: number;
}
export interface WebSet {
  revision?: number | null;
  settings: WebSettings;
}
export interface WebSettings {
  enabled: boolean;
  source: WebSource;
}
export interface WebKey {
  revision?: number | null;
}
export interface WebSnapshot {
  revision?: number | null;
  settings: WebSettings;
  credential: WebCredential;
  [k: string]: unknown | undefined;
}
export interface WebCredential {
  revision?: number | null;
  configured: boolean;
  check?: WebCheck | null;
  [k: string]: unknown | undefined;
}
export interface WebCheck {
  credential_revision: number;
  outcome: WebCheckOutcome;
}
export interface WebProbe {
  url: string;
}
export interface AgentModelsCursor {
  query: string;
  offset: number;
}
export interface AgentModelChoice {
  selection: AgentBackendPreference;
  sourceName: string;
  label: string;
  thinkingLevels: string[];
  defaultThinkingLevel?: string | null;
}
export interface AgentExecutorSelection {
  executor: string;
  settings: ExecutorSettings;
}
/**
 * Executor-owned model selection, independent of Host model connections.
 */
export interface ExecutorSettings {
  model?: string | null;
  thinkingLevel?: ExecutorEffort | null;
  runtime?: string | null;
}
export interface AgentModelRead {
  backend: AgentBackendPreference;
}
export interface AgentGlobalInstructionsRead {}
export interface AgentGlobalInstructionsUpdate {
  source: AgentGlobalInstructionSource;
  revision: string;
  content: string;
}
export interface AgentExecutorsRead {}
export interface AgentExecutors {
  executors: string[];
  setup: string[];
}
export interface AgentExternalAgentsRead {
  inspect?: boolean;
}
export interface AgentExternalAgents {
  target: AgentExternalAgentsTarget;
  configured: boolean;
  runtimes: AgentExternalRuntimeOption[];
  state: AgentExternalAgentsState;
}
export interface AgentExternalAgentsTarget {
  source: AgentDataSource;
  path: string[];
}
/**
 * Stable business-data origin, independent of package or activation revisions.
 */
export interface AgentDataSource {
  stateDomain: string;
  deployment: string;
  namespace: InstanceId;
}
export interface AgentExternalRuntimeOption {
  id: AgentNativeRuntime;
  name: string;
  enabled: boolean;
  usageLimits: boolean;
}
export interface AgentExternalRuntime {
  id: string;
  name: string;
  installation: AgentExternalInstallation;
  authentication: AgentExternalAuthentication;
  models: AgentExternalModels;
}
/**
 * Observations and text; immutable attachments travel in the actual request resources.
 * No path, invocation or conversation key is authority.
 */
export interface ExecutorExecute {
  taskId: ExternalTaskId;
  language?: Language;
  execution: ExecutionIdentity;
  conversationKey: string;
  message: string;
  cwd: string;
  instructions?: string | null;
  settings: ExecutorSettings;
}
export interface ExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: RunId;
}
export interface AgentExecutorSetup {
  executor: string;
  action: ExecutorSetupAction;
}
export interface ExecutorSetupInfo {
  title?: string | null;
  name: string;
  version: string;
}
export interface ExecutorAuthenticationMethod {
  id: string;
  name: string;
  description?: string | null;
  supported: boolean;
}
export interface ComputerConfiguration {
  desktop?: Desktop & string;
  browsers?: BrowserConnection[];
  /**
   * Explicit opt-in to recording computer output audio.
   */
  audio?: boolean;
  /**
   * Optional browser preparation allowed by Maka Host policy.
   *
   * This policy is captured for one activation. Updated configuration applies
   * to new admissions after the replacement is ready; accepted work drains
   * under its captured policy. Commit/adoption acknowledges desired input only.
   * Old header removal and native cleanup require their own completion.
   */
  browserPreparation?: ComputerBrowserPreparation;
}
/**
 * An explicitly configured browser provider. The REPL cannot supply endpoints,
 * restart a browser, switch profiles or enable remote debugging by itself.
 */
export interface BrowserConnection {
  id: string;
  endpoint: string;
}
/**
 * Maka Host policy for requesting or adopting optional browser preparations.
 * The raw fields are independently configurable. Effective Maka popup adoption
 * and relay use `popup || !request_headers.is_empty()` so headers can reach the
 * first request.
 *
 * | `popup` | `request_headers` | Effective Maka popup adoption/relay |
 * | --- | --- | --- |
 * | `false` | empty | `false` |
 * | `true` | empty | `true` |
 * | `false` | nonempty | `true` |
 * | `true` | nonempty | `true` |
 *
 * Defaults request neither preparation; they do not report native hook state.
 * Original full preparation may still run fixed preparers enabled natively.
 */
export interface ComputerBrowserPreparation {
  /**
   * Raw Maka opt-in for popup adoption and relay.
   *
   * Nonempty `request_headers` also enables effective Maka popup adoption and
   * relay, even when this raw flag is `false`.
   *
   * `false` or omitting an enable call does not confirm that Original page
   * hooks are off. No native popup-state query or disable RPC is established.
   */
  popup?: boolean;
  /**
   * Request headers passed to the native browser preparation boundary.
   *
   * A nonempty list also enables effective Maka popup adoption and relay so
   * headers can reach the first request.
   *
   * An empty list alone does not confirm that existing native hooks are off.
   * An explicitly submitted empty list needs an actual disable acknowledgement;
   * leaving the default empty list unsubmitted provides no such confirmation.
   */
  requestHeaders?: ComputerBrowserPreparationHeader[];
}
/**
 * A request header selected by Maka Host browser preparation policy.
 */
export interface ComputerBrowserPreparationHeader {
  /**
   * Header name validated by the native browser provider.
   */
  name: string;
  /**
   * Header value validated by the native browser provider.
   */
  value: string;
}
export interface ComputerEvaluate {
  code: string;
  /**
   * Execution budget. Trusted consent and macOS/Windows native waits pause it.
   * Ordinary asynchronous waits remain charged. Interrupted REPLs require reset.
   */
  timeout_ms?: number;
  /**
   * Short, user-facing description of this call, in the user’s language.
   */
  title?: string | null;
}
export interface ProtocolProcessLaunch {
  executable: string;
  args?: string[];
  env?: {
    [k: string]: string | undefined;
  };
}
export interface AcpExecutorConfiguration {
  agent: AcpAgent;
  /**
   * Requested launch access, still subject to installation limits and consent.
   */
  permissions?: Permissions | null;
}
export interface AcpAgent {
  id: string;
  displayName: string;
  executable: string;
  args?: string[];
  /**
   * Ordinary launch settings only. Credentials belong to the agent's login store.
   */
  env?: {
    [k: string]: string | undefined;
  };
}
export interface Permissions {
  filesystem: Rule[];
  network: Network;
}
/**
 * Paths have executor-native meaning. Validate and materialize them on the
 * execution host, never on a remote Desktop. This document alone grants nothing.
 */
export interface Rule {
  path: string;
  scope: Scope;
  access: Access;
}
export interface ToolResultDetails {
  exitCode?: number | null;
  durationMs?: number | null;
}
export interface ExecutorTurnUsage {
  tokens: ModelUsage;
  totalTokens?: number | null;
  durationMs?: number | null;
}
export interface ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  [k: string]: unknown | undefined;
}
export interface ProtocolProcessRun {
  executable: string;
  args?: string[];
  env?: {
    [k: string]: string | undefined;
  };
  additionalPermissions?: Permissions | null;
  justification?: string | null;
}
export interface ProtocolProcessInput {
  id: string;
  additionalPermissions?: Permissions | null;
  justification?: string | null;
  /**
   * Null closes stdin. Empty data is a successful zero-byte write.
   *
   * @maxItems 8192
   */
  bytes?: number[] | null;
}
export interface ProtocolProcessWritten {
  bytes: number;
  closed: boolean;
}
export interface AgentToolNames {
  names: string[];
}
export interface AgentWorkRead {
  sessionId: string;
  target: AgentWorkTarget;
  cursor?: AgentAnswerCursor | null;
}
export interface AgentAnswerCursor {
  runId: RunId;
  offset: number;
}
/**
 * Stable logical Run receipt, independent of activations and the current Session tip.
 */
export interface AgentExecution {
  sessionId: string;
  turnId: string;
  runId: RunId;
  /**
   * Run-local event count, not the root-global transcript cursor.
   */
  highWater: number;
  state: AgentExecutionState;
}
export interface ToolKey {
  attempt: ModelAttemptId;
  call: string;
}
export interface ExternalPublicationKey {
  publication: ExternalPublicationId;
  index: number;
}
export interface ContentRef {
  digest: string;
  bytes: number;
}
export interface AgentAnswerPage {
  text: string;
  next?: AgentAnswerCursor | null;
}
/**
 * Stable model identity, resolved from current connection settings at admission.
 */
export interface ModelSelection {
  connectionId: string;
  modelId: string;
  [k: string]: unknown | undefined;
}
export interface SettingsModelCursor {
  query: string;
  connectionId: string | null;
  connection: number;
  model: number;
}
export interface SettingsUsageRead {
  range: SettingsUsageRange;
  selection: UsageSelection;
  cursor: UsageActivityCursor | null;
}
export interface SettingsUsageRange {
  from: number;
  to: number;
  sessionId: string | null;
  through: UsageFence | null;
}
export interface UsageFence {
  schemaVersion: number;
  stateDomain: string;
  sequence: number;
  auxiliarySequence: number;
  cellSequence: number;
  queryDigest: string;
}
/**
 * Filters only the activity list, never headline accounting for the range.
 */
export interface UsageSelection {
  kind?: UsageActivityKind | null;
  status?: UsageActivityStatus | null;
  search?: string;
}
export interface UsageActivityCursor {
  completedAt: number;
  requestId: string;
}
export interface SettingsUsagePage {
  through: UsageFence;
  /**
   * @maxItems 32
   */
  attempts: UsageActivity[];
  total: number;
  nextCursor?: UsageActivityCursor | null;
}
export interface UsageModelAttempt {
  requestId: string;
  origin: UsageOrigin;
  sessionId?: string | null;
  binding?: ModelBinding | null;
  modelId: string;
  startedAt: number;
  completedAt: number;
  outcome: UsageOutcome;
  usage: ModelUsage;
  quote?: Quote | null;
  costUsd?: number | null;
}
export interface AgentStepLink {
  run: RunId;
  step: StepId;
  attempt: ModelAttemptId;
}
/**
 * Public model identity. Credentials and provider handles never belong here.
 */
export interface ModelBinding {
  connection_id: string;
  connection_slug: string;
  model: string;
  [k: string]: unknown | undefined;
}
export interface Quote {
  providerId: string;
  revision: number;
  pricing?: Pricing | null;
}
export interface Pricing {
  modelKey: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
}
export interface ToolUsage {
  requestId: string;
  source: ToolUsageSource;
  name: string;
  binding?: ModelBinding | null;
  completedAt: number;
  result: ToolUsageResult;
  cleanup?: OperationCleanup | null;
}
/**
 * A Tool Call is distinct from its durable host operation. Origin determines
 * model visibility; it is not an independent flag that can contradict ancestry.
 */
export interface ToolCallIdentity {
  tool_call_id: string;
  origin: ToolOrigin;
  [k: string]: unknown | undefined;
}
export interface RunOwner {
  deployment: string;
  namespace: InstanceId;
}
export interface SettingsUsageSummary {
  through: UsageFence;
  summary: SettingsUsageTotals;
  nextCursor?: UsageGroupCursor | null;
}
export interface SettingsUsageTotals {
  models: UsageModelTotals;
  tools: UsageToolTotals;
  pending: UsagePending;
  /**
   * @maxItems 32
   */
  byProvider: UsageProviderSummary[];
  /**
   * @maxItems 32
   */
  byModel: UsageModelSummary[];
  /**
   * @maxItems 32
   */
  byTool: UsageToolSummary[];
}
export interface UsageModelTotals {
  calls: number;
  success: number;
  error: number;
  aborted: number;
  unknown: number;
  /**
   * Sum of observed durations; unknown outcomes are excluded. Not wall-clock time.
   */
  durationMs: number;
  input: UsageTokens;
  output: UsageTokens;
  cacheRead: UsageTokens;
  cacheWrite: UsageTokens;
  reasoning: UsageTokens;
  cost: UsageCost;
}
/**
 * Sum of reported counters, qualified by calls that omitted this counter.
 */
export interface UsageTokens {
  known: number;
  missing: number;
}
export interface UsageCost {
  knownUsd: number;
  /**
   * Calls without a persisted valuation; includes unpriced calls.
   */
  unvalued: number;
  unpriced: number;
}
export interface UsageToolTotals {
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
  meanLatencyMs?: number | null;
}
export interface UsagePending {
  models: number;
  tools: number;
}
export interface UsageProviderSummary {
  /**
   * Unknown identity is not inferred from a transport protocol or current settings.
   */
  providerId?: string | null;
  totals: UsageModelTotals;
}
export interface UsageModelSummary {
  modelId: string;
  totals: UsageModelTotals;
}
export interface UsageToolSummary {
  name: string;
  totals: UsageToolTotals;
}
export interface UsageGroupCursor {
  group: UsageGroup;
  key?: string | null;
}
export interface SettingsUsageSummaryRead {
  range: SettingsUsageRange;
  group: UsageGroup;
  cursor: UsageGroupCursor | null;
}
export interface PricingUpdate {
  expectedRevision: number;
  mutation: PricingMutation;
}
export interface SettingsAssistantPreferences {
  predictions: MessagePredictionSettings;
  defaultPredictionPrompt: string;
  language?: LanguagePreference | null;
  resolvedLanguage: Language;
  compactionPrompt: string;
  defaultCompactionPrompt: string;
  revision: number;
  displayName: string;
  workspaceInstructions: boolean;
  defaultSandboxMode: Mode;
  shell: ShellPolicy;
}
export interface MessagePredictionSettings {
  enabled: boolean;
  ordinarySessionsOnly: boolean;
  liveSamplePercent: number;
  catchUpSamplePercent: number;
  /**
   * None or blank selects the localized built-in instructions.
   */
  prompt?: string | null;
}
export interface ShellPolicy {
  preference: ShellPreference;
  executable: string;
  titles: boolean;
}
export interface SettingsNetworkSnapshot {
  revision: number;
  proxy: NetworkProxy;
  credential: CredentialStatus;
  rootId: string;
  rootPath: string;
}
export interface NetworkProxy {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  authEnabled: boolean;
  username: string;
  bypassList: string[];
  autoBypassDomains: string[];
}
export interface CredentialStatus {
  locator: CredentialLocator;
  configured: boolean;
  credentialId: string | null;
  revision: number | null;
  updatedAt: number | null;
}
export interface SettingsNetworkUpdate {
  expectedPolicyRevision: number;
  expectedCredential: CredentialVersionBasis | null;
  networkProxy: NetworkProxy;
  credential: SettingsNetworkCredentialAction;
}
export interface CredentialVersionBasis {
  locator: CredentialLocator;
  credentialId: string;
  revision: number;
}
export interface CredentialTarget {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
}
export interface SettingsPreferencesUpdate {
  expectedRevision: number;
  mutation: SettingsPreferencesMutation;
}
export interface SettingsModelChoice {
  tools?: SettingsModelToolPreferences | null;
  limits?: SettingsModelLimitSettings | null;
  selection: ModelSelection;
  connectionName: string;
  label: string;
  /**
   * @maxItems 8
   */
  thinkingLevels:
    | []
    | [ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
      ]
    | [
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
      ];
  defaultThinkingLevel: ThinkingLevel | null;
}
export interface SettingsModelToolPreferences {
  codeMode: boolean | null;
  codeModeLanguage: CodeLanguage | null;
  applyPatch: boolean | null;
}
export interface SettingsModelLimitSettings {
  overrides: SettingsModelLimits;
  contextWindow: number | null;
  inputLimit: number | null;
  maxOutputTokens: number | null;
}
export interface SettingsModelLimits {
  contextWindow: number | null;
  inputLimit: number | null;
  maxOutputTokens: number | null;
  compactionThreshold: number | null;
}
export interface ConnectionTarget {
  connectionId: string;
  modelId: string;
}
export interface SettingsModelDefaults {
  catalogMatched: boolean;
  label: string;
  contextWindow: number | null;
  inputLimit: number | null;
  maxOutputTokens: number | null;
  compactionThreshold: number | null;
  codeMode: boolean;
  codeModeLanguage: CodeLanguage;
  applyPatch: boolean;
  /**
   * @maxItems 8
   */
  thinkingLevels:
    | []
    | [ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
      ]
    | [
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
        ThinkingLevel,
      ];
  defaultThinkingLevel: ThinkingLevel | null;
}
export interface SettingsUpdateModelSettings {
  expected: ConnectionVersionBasis;
  modelId: string;
  tools: SettingsModelToolPreferences;
  limits: SettingsModelLimits;
}
export interface ConnectionVersionBasis {
  connectionId: string;
  revision: number;
}
export interface SettingsConnectionSummary {
  /**
   * Editing controls implemented by this Settings service for the provider.
   */
  editable: boolean;
  basis: ConnectionVersionBasis;
  slug: string;
  name: string;
  provider: Identity;
  enabled: boolean;
  enabledModelCount: number;
  usageLimits: boolean;
}
/**
 * Durable recipient, not a registration lease. Re-loading the same package can
 * restore it; another package, Entry or scope cannot inherit its credentials.
 */
export interface Identity {
  packageId: string;
  entryId: string;
  scope: string;
  name: string;
}
export interface ConnectionCredentialTarget {
  connectionId: string;
  revision: number;
  slug: string;
  provider: Identity;
  configuration: {
    [k: string]: unknown | undefined;
  };
}
export interface SettingsConnectionEditingFacts {
  enabledModelIds: string[];
  modelOverrides: {
    [k: string]: ModelOverride | undefined;
  } | null;
  requestBodyOverlay: {
    [k: string]: unknown | undefined;
  } | null;
}
export interface ModelOverride {
  /**
   * Catalog defaults for this connection's model; the request model ID is unchanged.
   */
  catalogModel?: CatalogModelReference;
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
  codeModeLanguage?: CodeLanguage;
  /**
   * Independent of Code Mode: select patch editing or structured Edit/Write.
   */
  applyPatch?: boolean;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  vision?: boolean;
  /**
   * Explicit route image declarations; replaces catalog image constraints.
   */
  imageInput?: ImageInput | null;
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
  apiProtocol?: ApiProtocol;
  knowledgeCutoff?: string;
  capabilities?: ModelOverrideCapabilities;
  modalities?: ModelModalities;
  serviceTier?: RelayServiceTier;
}
export interface CatalogModelReference {
  provider: string;
  modelId: string;
}
/**
 * Route declarations for image input; absent fields remain unknown.
 */
export interface ImageInput {
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
export interface ModelOverrideCapabilities {
  chat?: boolean;
  reasoning?: boolean;
  functionCalling?: boolean;
  parallelToolCalls?: boolean;
  imageGeneration?: boolean;
  webSearch?: boolean;
}
export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}
export interface SettingsProvidersRead {
  offset: number;
}
export interface SettingsProvidersPage {
  providers: SettingsProviderSummary[];
  next: number | null;
}
export interface SettingsProviderSummary {
  customEndpoint: boolean;
  identity: Identity;
  label: string;
  authentication: SettingsProviderAuthenticationSummary[];
}
export interface SettingsProviderAuthenticationSummary {
  label: string;
  interactive: boolean;
}
export interface SettingsProvider {
  identity: Identity;
  descriptor: Descriptor;
}
export interface Descriptor {
  label: string;
  /**
   * Offers a user-selected endpoint instead of a named service.
   */
  customEndpoint?: boolean;
  configurationSchema: unknown;
  configurationDefaults: unknown;
  authentication: Method2[];
  /**
   * Whether the provider supports a connection without a stored credential.
   * Presentation metadata; authorization remains the provider's decision.
   */
  anonymous: boolean;
  discovery: boolean;
  usageAuthentication?: UsageAuthentication | null;
}
export interface Method2 {
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
export interface SettingsCredentialLogin {
  expected: ConnectionCredentialTarget;
  expectedCredential: CredentialVersionBasis | null;
  method: string;
}
export interface SettingsLoginPrompt {
  url: string;
  userCode: string;
}
export interface ConnectionIdentity {
  connectionId: string;
  slug: string;
  provider: Identity;
}
export interface SettingsSaveCredential {
  expected: ConnectionCredentialTarget;
  expectedCredential: CredentialVersionBasis | null;
}
export interface CreateCatalogConnectionInput {
  expectedCatalogRevision: number;
  connection: ConnectionCatalogEntryDraft;
}
export interface ConnectionCatalogEntryDraft {
  slug: string;
  name: string;
  provider: Identity;
  configuration: {
    [k: string]: unknown | undefined;
  };
  enabled: boolean;
  enabledModelIds: string[];
  modelOverrides?: {
    [k: string]: ModelOverride | undefined;
  };
  requestBodyOverlay?: {
    [k: string]: unknown | undefined;
  };
}
export interface UpdateCatalogConnectionInput {
  expected: ConnectionVersionBasis;
  changes: ConnectionCatalogEntryUpdate;
}
export interface ConnectionCatalogEntryUpdate {
  name?: string;
  configuration?: {
    [k: string]: unknown | undefined;
  };
  enabled?: boolean;
  enabledModelIds?: string[];
  modelOverrides?: Nullable_MapOf_ModelOverride;
  requestBodyOverlay?: {
    [k: string]: unknown | undefined;
  } | null;
}
export interface RemoveCatalogConnectionInput {
  expected: ConnectionVersionBasis;
}
export interface CredentialVaultQueryInput {
  locator: CredentialLocator;
}
export interface DeleteCredentialInput {
  expected: CredentialVersionBasis;
  /**
   * Required for connection credentials; null for network credentials.
   */
  expectedConnection: ConnectionCredentialTarget | null;
}
export interface SetDefaultConnectionTargetInput {
  expectedCatalogRevision: number;
  target: ConnectionTarget | null;
}
export interface AgentMcpConfigurations {
  workspace?: AgentWorkspace | null;
}
export interface AgentWorkspace {
  /**
   * Native owner allocation; never accepted from a caller as workspace authority.
   */
  worktree?: Binding | null;
  /**
   * Optional membership in this Agent's canonical Project catalog.
   */
  projectId?: string | null;
  path: string;
  directoryIdentity: string;
  identity: string;
}
/**
 * Immutable allocation intent, not the current child branch or HEAD.
 */
export interface Binding {
  id: string;
  common_dir: string;
  source: string;
  source_identity: string;
  base_commit: string;
  directory: string;
}
export interface AgentMcpConfigurationList {
  locations: AgentMcpConfigurationLocation[];
}
export interface AgentMcpConfigurationLocation {
  location: ConfigurationLocation;
  path: string;
  revision: string;
  servers: AgentMcpConfigurationEntry[];
}
export interface AgentMcpConfigurationEntry {
  name: string;
  configuration: unknown;
  shadowedBy?: ConfigurationLocation | null;
}
export interface AgentMcpConfigurationChange {
  workspace?: AgentWorkspace | null;
  location: ConfigurationLocation;
  name: string;
  revision: string;
  change: AgentMcpServerChange;
}
/**
 * Installation-selected skill collections. No ambient home or workspace scan.
 */
export interface SkillLibraryConfiguration {
  /**
   * Explicit user root; only its standard .maka/skills and .agents/skills collections are scanned.
   */
  home?: string | null;
  /**
   * Explicit ceilings for a request's selected project. An observation grants no access.
   */
  projectRoots?: DirectoryRootSpec[];
  /**
   * Include the immutable skill instructions and resources shipped with this build.
   */
  bundled?: boolean;
  /**
   * Allow management of the configured standard user and project skill directories.
   */
  manage?: boolean;
  /**
   * Allow edits to enabled/pinned preferences, independently of file management.
   */
  preferences?: boolean;
  sources: SkillLibrarySource[];
}
export interface SkillLibrarySource {
  id: string;
  label: string;
  /**
   * Absolute directory containing skill directories. Captured at activation.
   */
  path: string;
}
export interface SkillLibraryList {
  workspace?: AgentWorkspace | null;
  query: string;
  cursor?: SkillLibraryCursor | null;
}
export interface SkillLibraryCursor {
  revision: string;
  query: string;
  offset: number;
}
export interface SkillLibraryTarget {
  location: ConfigurationLocation;
  path: string;
}
export interface SkillLibraryEntry {
  bundled: boolean;
  location?: ConfigurationLocation | null;
  path: string;
  installation?: SkillLibraryInstallation | null;
  preference: SkillPreference;
  reference: string;
  source: string;
  name: string;
  description: string;
  valid: boolean;
  shadowedBy?: string | null;
  issues: string[];
}
export interface SkillLibraryInstallation {
  source: SkillLibrarySourceSnapshot;
  directory: string;
}
export interface SkillPreference {
  enabled: boolean;
  pinned: boolean;
}
export interface SkillLibraryRead {
  workspace?: AgentWorkspace | null;
  reference: string;
  /**
   * Complete catalog revision from the list/read response.
   */
  revision: string;
  offset: number;
}
export interface SkillLibraryDiscoverSource {
  workspace?: AgentWorkspace | null;
  source: string;
}
export interface SkillLibraryDiscoveredSource {
  source: SkillLibrarySourceSnapshot;
  skills: SkillLibrarySourceSkill[];
}
export interface SkillLibrarySourceSkill {
  directory: string;
  name: string;
  description: string;
}
export interface SkillLibraryInstall {
  workspace?: AgentWorkspace | null;
  location: ConfigurationLocation;
  source: SkillLibrarySourceSnapshot;
  skills: string[];
}
export interface SkillLibraryInstallResult {
  results: SkillLibraryInstallOutcome[];
}
export interface SkillLibraryManageSkill {
  workspace?: AgentWorkspace | null;
  reference: string;
}
export interface SkillLibrarySetPreference {
  reference: string;
  revision: number;
  preference: SkillPreference;
}
export interface SkillModelSearch {
  query: string;
  /**
   * Omission returns the complete matching catalog.
   */
  limit?: number | null;
}
export interface SkillModelLoad {
  /**
   * Exact ref from search, or a skill id/name resolved before eligibility checks.
   */
  name: string;
  /**
   * Catalog revision from search or a previous load/resource response.
   */
  revision: string;
  /**
   * UTF-8 resource path relative to this skill, or its exact continuation.
   */
  resource?: ReadInput | null;
  /**
   * UTF-8 byte offset from a returned instruction continuation; omit initially.
   */
  instructionOffset?: number | null;
}
export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}
export interface SkillModelSearchResult {
  revision: string;
  query: string;
  matches: SearchMatch[];
  totalEligible: number;
  matchedCount: number;
  truncated: boolean;
  [k: string]: unknown | undefined;
}
export interface SearchMatch {
  ref: string;
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  metadataTruncated: boolean;
  score: number;
  [k: string]: unknown | undefined;
}
export interface SkillMetadata {
  ref: string;
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  metadataTruncated: boolean;
  [k: string]: unknown | undefined;
}
export interface SkillPrepare {
  language: Language;
  message: string;
  /**
   * Actual selected tools bound to this Library; these names grant no access.
   */
  loadTool?: string | null;
  searchTool?: string | null;
}
export interface SkillPreparationRecord {
  revision: string;
  metadataPrompt: string;
  invocation: SkillInvocationResult;
}
export interface SkillInvocationResult {
  loaded: LoadedSkill[];
  failed: SkillInvocationFailure[];
  receipts: SkillInvocationReceipt[];
}
export interface LoadedSkill {
  id: string;
  name: string;
}
export interface SkillRequestFailure {
  request: string;
  reason: SkillFailureReason;
}
export interface AgentList {
  filter: AgentSessionFilter;
  /**
   * Include archived conversations alongside active ones.
   */
  includeArchived?: boolean;
  /**
   * Only conversations without a parent; omitted queries still include children.
   */
  rootsOnly?: boolean;
  position: AgentSessionPosition;
  scope?: AgentSessionListScope;
  /**
   * Literal, case-sensitive title substring; an empty query matches all titles.
   */
  titleQuery?: string;
}
export interface AgentCreate {
  /**
   * Apply a preset at creation; mutually exclusive with backend.
   */
  presetId?: string | null;
  /**
   * Initial next-turn preference; admission resolves it again.
   */
  backend?: AgentBackendPreference | null;
  /**
   * Treat title as a placeholder for one title derived from the first user message.
   */
  automaticTitle?: boolean;
  /**
   * Immutable narrowing of this Agent's installed tools. None uses the installation;
   * an empty list permits no model tools. External executors cannot enforce this.
   */
  tools?: string[] | null;
  /**
   * A concise, specific task name people can recognize in navigation; avoid generic worker numbers.
   */
  title: string;
  labels: string[];
  workspace: AgentWorkspaceSelection;
}
export interface AgentProjectRef {
  id: string;
  revision: string;
}
export interface AgentGoalRead {
  sessionId: string;
}
export interface AgentGoalView {
  enabled: boolean;
  current?: AgentGoalDetail | null;
}
export interface AgentGoalDetail {
  id: string;
  revision: number;
  objective: string;
  status: GoalStatus;
  iterations: number;
  tokenBudget?: number | null;
  consumed: GoalMeter;
  remainingTokens?: number | null;
  elapsedSeconds: number;
  retryAt?: number | null;
  createdAt: number;
  pending: boolean;
  report?: GoalReport | null;
  note: string;
}
export interface GoalMeter {
  known: number;
  missing: number;
  [k: string]: unknown | undefined;
}
export interface GoalReport {
  status: GoalReportKind;
  note: string;
}
export interface AgentGoalApproval {
  target: AgentScheduledTarget;
  model: ModelSelection;
  thinkingLevel?: ThinkingLevel | null;
}
/**
 * Exact observed source boundary. This data is checked against the original
 * Session; passing it never grants execution by itself.
 */
export interface AgentScheduledTarget {
  sessionId: string;
  workspace: AgentWorkspace;
  permissions: AgentWorkspacePermissions;
  boundaryRevision: number;
  binding: BindingStamp;
}
export interface BindingStamp {
  id: string;
  permissionEpoch: number;
}
export interface AgentGoalBudget {
  tokenBudget?: number | null;
}
export interface AgentChecklistRead {
  sessionId: string;
  offset?: number;
  limit?: number | null;
}
export interface AgentChecklist {
  enabled: boolean;
  revision?: number | null;
  digest?: string | null;
  total: number;
  completed: number;
  activeIndex?: number | null;
  current?: AgentTodoItem | null;
  offset: number;
  items: AgentTodoItem[];
  nextOffset?: number | null;
}
export interface AgentTodoItem {
  content: string;
  status: AgentTodoStatus;
}
export interface AgentRecapRead {
  sessionId: string;
  operationId?: string | null;
}
export interface AgentRecapGenerate {
  sessionId: string;
  model: ModelSelection;
}
export interface AgentScheduledSummary {
  id: string;
  revision: number;
  title: string;
  status: Status;
  approved: boolean;
  /**
   * A Bot-created one-time discovery that no longer needs approval.
   */
  backgroundFollowup?: boolean;
  nextFireAt?: number | null;
  pendingFire?: string | null;
  reminder: boolean;
  lastError?: string | null;
}
export interface AgentScheduledDetail {
  investigation?: AgentScheduledInvestigation | null;
  revision: number;
  task: Task;
  timezone: string;
  misfire: Misfire;
  approved: boolean;
  pendingFire?: string | null;
}
export interface AgentScheduledInvestigation {
  sessionId: string;
  turnId: string;
  phase: AgentInvestigationPhase;
}
export interface Task {
  id: string;
  title: string;
  intent: Intent;
  schedule: Schedule;
  effect: AgentScheduledEffect;
  status: Status;
  nextFireAt?: number | null;
  lastFireAt?: number | null;
  fireCount: number;
  maxFires?: number | null;
  expiresAt?: number | null;
  createdBy: Creator;
  createdAt: number;
  updatedAt: number;
  runs: Run[];
  lastError?: string | null;
}
export interface Run {
  id: string;
  at: number;
  outcome: Outcome;
  message: string;
  sessionId?: string | null;
  runId?: RunId | null;
}
export interface AgentScheduledInput {
  task: Create;
  timezone: string;
  misfire: Misfire;
}
export interface Create {
  title: string;
  intentBody: string;
  schedule: Schedule;
  effect: AgentScheduledEffect;
  maxFires?: number | null;
  expiresAt?: number | null;
}
export interface AgentScheduleAlerts {
  pending: number;
  reminders: AgentScheduledReminder[];
}
export interface AgentScheduledReminder {
  taskId: string;
  fireId: string;
  title: string;
  body: string;
}
export interface RecallQuery {
  /**
   * @minItems 1
   */
  terms: [string, ...string[]];
  /**
   * An explicit caller-selected result budget; omission retains all matching results.
   */
  limit?: number | null;
  session_id?: string | null;
  since?: number | null;
  until?: number | null;
}
export interface AgentRecallPage {
  titles: AgentSession[];
  passages: AgentRecallPassage[];
  complete: boolean;
  gaps: string[];
}
export interface AgentSession {
  appliedPreset?: AppliedPreset | null;
  /**
   * Session that initiated creation, independent of fork ancestry and task ownership.
   */
  parentSessionId: string | null;
  branch: AgentSessionBranch | null;
  backend?: AgentBackendPreference | null;
  tools?: string[] | null;
  dataSource: AgentDataSource;
  permissions: AgentWorkspacePermissions;
  boundaryRevision: number;
  binding: BindingStamp;
  id: string;
  title: string;
  labels: string[];
  workspace: AgentWorkspace;
  revision: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  hasUnread: boolean;
  /**
   * Exact durable visible tail accepted by markRead; independent of preview clocks.
   */
  tailMessageId: string | null;
  activity: AgentSessionActivity;
}
/**
 * Immutable execution configuration captured when a session is created.
 */
export interface AppliedPreset {
  id: string;
  revision: PresetRevision;
  name: string;
  instruction: string;
  model: ModelSelection;
  thinkingLevel?: ThinkingLevel | null;
}
/**
 * Frozen conversation ancestry for presentation, not authority over the source.
 */
export interface AgentSessionBranch {
  sessionId: string;
  position: AgentForkPosition;
}
export interface AgentRecallPassage {
  session: AgentSession;
  anchorMessageId: string;
  anchorPosition: HistoryRowAddress;
  /**
   * Display preview beginning at the first match. The anchor opens the complete source.
   */
  excerpt: string;
  /**
   * Highlight ranges in UTF-16 code units within `excerpt`.
   */
  highlights: AgentRecallHighlight[];
  matchedTerms: string[];
}
export interface AgentRecallHighlight {
  start: number;
  end: number;
}
export interface AgentImportSourceRef {
  id: string;
  revision: number;
}
export interface AgentImportQuery {
  text: string;
  includeArchived: boolean;
  cursor: string | null;
}
export interface AgentImportEntryRef {
  sessionId: string;
  path: string;
}
export interface AgentImportSource {
  id: string;
  name: string;
  location: AgentImportLocation;
  path: string;
}
export interface AgentImportEntry {
  id: string;
  path: string;
  title: string;
  cwd: string | null;
  updatedAt: number | null;
  archived: boolean;
}
export interface AgentImportPreview {
  selection: AgentImportSelection;
  title: string;
  cwd: string | null;
  records: number;
  bytes: number;
  incompleteTail: boolean;
  /**
   * @maxItems 8
   */
  items:
    | []
    | [AgentImportPreviewItem]
    | [AgentImportPreviewItem, AgentImportPreviewItem]
    | [AgentImportPreviewItem, AgentImportPreviewItem, AgentImportPreviewItem]
    | [
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
      ]
    | [
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
      ]
    | [
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
      ]
    | [
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
      ]
    | [
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
        AgentImportPreviewItem,
      ];
  next: number | null;
}
export interface AgentImportSelection {
  source: AgentImportSourceRef;
  entry: AgentImportEntryRef;
  digest: string;
}
export interface AgentImportPreviewItem {
  index: number;
  kind: AgentImportRecordKind;
  text: string;
  truncated: boolean;
}
export interface AgentProjectCursor {
  revision: string;
  after: string;
}
export interface AgentProject {
  reference: AgentProjectRef;
  name: string;
  archived: boolean;
  available: boolean;
  /**
   * The location the Project was last used at, when it is available.
   */
  path: string | null;
}
export interface AgentProjectLocation {
  path: string;
  name: string;
  project: AgentProject | null;
}
export interface AgentFork {
  sessionId: string;
  expectedRevision: number;
  position: AgentForkPosition;
  title: string;
  labels: string[];
}
export interface AgentForkReceipt {
  /**
   * The complete original fork operation reference, including its fingerprint.
   */
  reference: RecoveryRef;
}
export interface AgentForkReceiptResult {
  /**
   * A currently readable published fork. Null neither proves no effect nor
   * authorizes replacing or redispatching the original operation.
   */
  session: AgentSession | null;
}
export interface AgentDirectory {
  name: string;
  path: string;
}
export interface AgentMetadata {
  /**
   * Omission preserves the conversation's position in the catalog.
   */
  pinned?: boolean | null;
  /**
   * Omission leaves the permission boundary and its approvals unchanged.
   */
  permissions?: AgentPermissionChange | null;
  sessionId: string;
  expectedRevision: number;
  title: string;
  labels: string[];
}
export interface AgentPermissionChange {
  settings: AgentWorkspacePermissions;
  /**
   * Invalidate additive approvals even when the base policy is unchanged.
   */
  revokeGrants: boolean;
}
export interface AgentSelectBackend {
  sessionId: string;
  backend: AgentBackendPreference;
}
export interface AgentChangeSession {
  sessionId: string;
  expectedRevision: number;
  action: AgentSessionAction;
}
export interface AgentSend {
  /**
   * Best-effort notification to the native model caller when this message finishes,
   * fails or is cancelled, and once per pending interaction or authority blocker
   * that needs attention. An attention notification keeps the completion watch.
   * When registration is confirmed, the caller can yield rather than poll.
   * The watch and task admission commit together;
   * check the completion field of the send receipt.
   */
  onComplete?: AgentOnComplete | null;
  /**
   * Immutable user-selected excerpts; source metadata grants no read authority.
   *
   * @maxItems 16
   */
  quotes?:
    | []
    | [QuoteRef]
    | [QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef, QuoteRef]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ]
    | [
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
        QuoteRef,
      ];
  /**
   * Defaults to steer. Omit or use steer for updates to ongoing work;
   * use queue only when this message should wait until the current turn ends.
   */
  delivery?: AgentSendDelivery;
  /**
   * An active send must not start new work after Stop fences its original Run.
   */
  expectedRunId?: RunId | null;
  /**
   * IDs of immutable user uploads in this Session; metadata is resolved by the owner.
   */
  attachments?: string[];
  /**
   * Omission uses the session’s saved next-turn preference.
   */
  backend?: AgentBackendPreference | null;
  sessionId: string;
  message: string;
}
export interface AgentStop {
  sessionId: string;
  runId: RunId;
}
export interface AgentExecutionRead {
  sessionId: string;
  runId: RunId;
}
/**
 * Manual continuation of a terminal Run always admits a new Run. Recovery of an
 * unfinished Run is internal reconciliation, not this user command.
 */
export interface AgentContinueRun {
  sessionId: string;
  sourceRunId: RunId;
  /**
   * Exact immutable source fence returned by execution.
   */
  sourceHighWater: number;
  model: ModelSelection;
  thinkingLevel?: ThinkingLevel | null;
}
export interface AgentUploadAttachment {
  sessionId: string;
  name: string;
  bytes: number;
  digest: string;
}
export interface AgentAttachment {
  sessionId: string;
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
}
export interface AgentMarkRead {
  sessionId: string;
  messageId: string;
}
export interface AgentWatch {
  sessionId: string;
  after: number;
}
export interface AgentPendingInteractions {
  revision: number;
  entries: AgentInteractionSummary[];
}
export interface AgentInteractionSummary {
  requestId: string;
  kind: AgentInteractionKind;
  toolUseId: string | null;
}
export interface AgentInteractionRead {
  sessionId: string;
  requestId: string;
}
export interface AgentInteractionRespond {
  sessionId: string;
  requestId: string;
  answer: InteractionAnswer;
}
export interface InteractionRecord {
  execution: ExecutionIdentity;
  requestId: string;
  createdAt: number;
  request: InteractionRequest;
  outcome: InteractionOutcome | null;
}
/**
 * Captured authority, never silently upgraded by resolving a current binding.
 */
export interface PermissionBasis {
  boundaryRevision: number;
  binding: BindingStamp;
}
export interface PermissionRequest {
  reason: string;
  command?: PermissionCommand | null;
  permissions: Permissions;
}
export interface PermissionCommand {
  command: string;
  cwd: string;
}
export interface InteractionQuestion {
  question: string;
  /**
   * @minItems 2
   * @maxItems 3
   */
  options: [QuestionOption, QuestionOption] | [QuestionOption, QuestionOption, QuestionOption];
}
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface FormRequester {
  name: string;
  source?: string | null;
}
export interface FormOption {
  value: string;
  label: string;
}
export interface GrantTarget {
  providerId: string;
  contractId: string;
  serverId: string;
  toolName: string;
  capability: GrantCapability;
  scope: GrantScope;
  [k: string]: unknown | undefined;
}
export interface ComputerAppDisplay {
  name: string;
  appPath: string;
  risk?: ComputerAppRisk | null;
  warning?: string | null;
}
export interface SystemPermissionApplicationLocation {
  fileUrl: string;
  stateDomain: string;
}
export interface QuestionAsk {
  /**
   * @minItems 1
   * @maxItems 3
   */
  questions:
    | [InteractionQuestion]
    | [InteractionQuestion, InteractionQuestion]
    | [InteractionQuestion, InteractionQuestion, InteractionQuestion];
}
export interface FormAsk {
  message: string;
  fields: FormField[];
}
/**
 * Immutable installation ceiling selected by trusted native composition.
 */
export interface WorkspaceProcessConfiguration {
  /**
   * Allow the selected native Session's verified owned worktree, within its
   * own access policy. Other Host-private paths remain denied.
   */
  isolatedWorkspaces?: boolean;
  filesystem: Policy;
  network: Network;
  /**
   * Trusted CLI supporting the original platform sandbox bootstrap.
   */
  helper?: string | null;
  /**
   * Explicit directory for application setup processes. Launch still needs
   * its own grant and uses only the installation filesystem/network ceiling.
   */
  setupDirectory?: string | null;
  /**
   * Trusted Agent Session owner in this Root/deployment. This selects a data
   * namespace only; Terminal endpoints still require their own explicit grants.
   */
  sessionOwner?: InstanceId | null;
}
/**
 * Longest path wins; at the same path exact wins over subtree, then deny wins
 * over write over read. Deny globs are absolute and cannot be reopened by paths.
 * Matching directories deny their descendants.
 * Host file operations match at access time. Linux and Windows subprocesses
 * snapshot existing glob matches during preparation; macOS enforces them live.
 * Empty restricted policy denies all access, rather than falling back to defaults.
 */
export interface Policy {
  default: Access;
  rules: Rule[];
  denyGlobs: string[];
}
export interface WorkspacePath {
  bytesBase64: string;
}
export interface AgentContextRead {
  sessionId: string;
  /**
   * Null selects the latest actual readable source, not a caller-provided execution grant.
   */
  runId: RunId | null;
  /**
   * Null captures the committed head; a supplied fence must not exceed it.
   */
  through: number | null;
}
export interface AgentContextReport {
  through: number;
  /**
   * Latest Main request made by this Session, excluding copied source requests.
   */
  request: AgentContextRequest | null;
}
export interface AgentContextRequest {
  /**
   * Original canonical Run metadata; observation only.
   */
  execution: ExecutionIdentity;
  stepId: StepId;
  attemptId: ModelAttemptId;
  sequence: number;
  /**
   * Original request timestamp in milliseconds since the Unix epoch.
   */
  recordedAt: number;
  /**
   * Original input history fence, before this request was recorded.
   */
  sourceThrough: number;
  modelId: string;
  contextWindow: number | null;
  inputLimit: number | null;
  state: AgentContextRequestState;
  /**
   * Original Host prepared-input measurements, not provider wire sizes or exact tokenization.
   */
  breakdown: PreparedContextBreakdown | null;
  /**
   * Provider-reported input tokens from this exact completed step, if available.
   */
  reportedInputTokens: number | null;
}
/**
 * Host-prepared adapter input, not provider tokenization or HTTP wire bytes.
 */
export interface PreparedContextBreakdown {
  system: ContextBucket;
  user: ContextBucket;
  assistant: ContextBucket;
  /**
   * Messages with the tool role; assistant-embedded results stay in assistant.
   */
  tool: ContextBucket;
  toolSchemas: ContextBucket;
  counts: ContextCounts;
}
export interface ContextBucket {
  /**
   * UTF-8 text and compact JSON payload bytes counted by the Host heuristic.
   * Excludes file encodings, message metadata, request-level provider options
   * and synthetic framing overhead. Tool definitions are counted in full.
   */
  contentBytes: number;
  /**
   * Heuristic: separately rounded text/JSON bytes / 3, plus message/tool
   * framing and 1024 per media part. Never provider-measured tokens.
   */
  estimatedTokens: number;
}
export interface ContextCounts {
  messages: number;
  media: number;
  toolCalls: number;
  /**
   * Result parts across both tool and assistant roles.
   */
  toolResults: number;
  tools: number;
}
export interface AgentFileListRead {
  sessionId: string;
  path: WorkspacePath | null;
  after: AgentFileCursor | null;
}
export interface AgentFileCursor {
  directoryIdentity: string;
  after: WorkspacePath;
}
/**
 * Workspace-relative file suggestions from the selected completion context.
 */
export interface AgentFileCandidatesRead {
  target: AgentCompletionTarget;
  /**
   * Omission or null selects the workspace root.
   */
  directory?: WorkspacePath | null;
  /**
   * Empty or whitespace browses the selected directory's direct files and directories.
   * Otherwise, searches file paths within that directory's descendants.
   */
  query: string;
}
/**
 * An emitted batch of path observations; null final completion ends the subscription.
 */
export interface AgentFileCandidates {
  entries: AgentFileEntry[];
}
export interface AgentFileEntry {
  path: WorkspacePath;
  kind: AgentFileKind;
}
export interface AgentFileWatch {
  sessionId: string;
  path: WorkspacePath | null;
}
export interface AgentFilePage {
  directoryIdentity: string;
  entries: AgentFileEntry[];
  next: AgentFileCursor | null;
}
export interface GitStatusEntry {
  area: GitArea;
  path: WorkspacePath;
  kind: GitChangeKind;
}
export interface GitStatus {
  head: string | null;
  entries: GitStatusEntry[];
}
export interface AgentGitDiffRead {
  sessionId: string;
  area: GitArea;
  path: WorkspacePath;
}
export interface TerminalList {
  sessionId: string;
  offset?: number;
}
export interface TerminalTarget {
  sessionId: string;
  ref: string;
}
/**
 * Exclusive cursor in this original target's native Data/Resize log. A Data
 * delivery can combine adjacent records; its sequence is the last consumed
 * native record. Any original cursor remains valid, including inside a batch.
 */
export interface TerminalOutputRequest {
  target: TerminalTarget;
  after?: number;
}
/**
 * Shared by native PTY allocation, input validation and screen rendering.
 */
export interface TerminalSize {
  cols: number;
  rows: number;
}
export interface TerminalStart {
  sessionId: string;
  /**
   * Omit for an interactive shell; an explicit command runs with bounded pipes.
   */
  command?: string | null;
  size?: TerminalSize | null;
}
export interface TerminalController {
  target: TerminalTarget;
  controllerId: string;
}
export interface TerminalControl {
  controller: TerminalController;
  sequence: number;
  actions?: RawAction[];
  size?: TerminalSize | null;
}
export interface TerminalPage {
  resources: ResourceUpdate[];
  revision: string;
  total: number;
  nextOffset?: number | null;
}
export interface ResourceUpdate {
  sessionId: string;
  ownership: Ownership;
  correlation: unknown;
  visibility: ShellVisibility;
  result: ShellSnapshot;
}
export interface ShellSnapshot {
  kind: SnapshotKind;
  ref: string;
  mode: ShellMode;
  status: ShellStatus;
  cwd: string;
  cmd: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  timeoutMs?: number;
  exitCode?: number;
  failureMessage?: string;
  revision: number;
  output?: ShellOutput;
}
export interface TerminalCursor {
  x: number;
  y: number;
  visible: boolean;
}
export interface TerminalLeaseUpdate {
  controllerId: string;
  nextSequence?: number | null;
  held: boolean;
  resource: ResourceUpdate;
}
export interface TerminalControlReceipt {
  controllerId: string;
  sequence: number;
  acceptedBytes: number;
  resized: boolean;
  resizeChanged: boolean;
}
export interface TerminalReleased {
  controllerId: string;
  released: boolean;
}
export interface TerminalStopped {
  applied: boolean;
  resource: ResourceUpdate;
}
export interface QuestionResponse {
  question: string;
  answer: string | null;
}
export interface AgentSessionPage {
  revision: string;
  needsYouCount: number;
  /**
   * @maxItems 32
   */
  sessions: AgentSession[];
  before: string | null;
  after: string | null;
}
export interface AgentStopped {
  /**
   * The original operation accepted a Stop intent for the existing Run, not
   * proof of a new state write or physical cleanup. Missing/already-terminal
   * preparation may return false; a terminal race after acceptance stays true.
   */
  requested: boolean;
}
export interface AgentDelivery {
  sequence: number;
  runId: RunId;
  turnId: string;
  fact: AgentDeliveryFact;
}
export interface AgentObservation {
  session: AgentSession;
  /**
   * Latest successful source turn at this observation's fence, or none while busy.
   */
  lastCompletedTurnId: string | null;
  compacting: AgentCompactionProgress | null;
  rememberedBackend?: AgentBackendPreference | null;
  metrics?: AgentSessionMetrics | null;
  through: number;
  run?: AgentRun | null;
  parts: AgentPart[];
  /**
   * Replay starts for active tool display, read at the same fence as the run.
   */
  toolSeeds: AgentToolSeed[];
}
export interface AgentCompactionProgress {
  id: string;
  /**
   * Original compaction start in milliseconds since the Unix epoch.
   */
  startedAt: number;
}
/**
 * Display-only readings from the latest completed main-model request.
 */
export interface AgentSessionMetrics {
  modelId: string;
  connectionId?: string | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  approximate: boolean;
  /**
   * The context count is the last completed request's baseline; newer additions are unknown.
   */
  contextLastKnown: boolean;
  /**
   * Provider output tokens divided by the model request's wall time.
   * Includes reasoning and time to first token; excludes tool/user waits.
   */
  outputTokensPerSecond?: number | null;
}
export interface AgentRun {
  backend: AgentRunBackend;
  runId: RunId;
  turnId: string;
  state: AgentRunState;
}
export interface AgentPart {
  startSequence: number;
  messageId: string;
  stepId: StepId;
  attemptId: ModelAttemptId;
  partId: string;
  textKind: AgentContentKind;
}
export interface AgentToolSeed {
  toolUseId: string;
  startSequence: number;
}
export interface AgentDiagnostics {
  sessionId: string;
  position: AgentDiagnosticPosition;
}
export interface AgentDiagnosticPage {
  through: number;
  entries: AgentDiagnostic[];
  nextBefore?: number | null;
}
export interface AgentDiagnostic {
  sequence: number;
  eventId: string;
  recordedAt: number;
  detail: DiagnosticDetail;
}
export interface AgentDiagnosticChange {
  /**
   * Latest diagnostic event sequence, independently of transcript progress.
   */
  revision: number;
}
export interface AgentSessionRead {
  sessionId: string;
}
export interface AgentHistoryRead {
  sessionId: string;
  through?: number | null;
  position: HistoryPosition;
  includeThinking?: boolean;
  view?: HistoryView & string;
}
/**
 * Byte offset in one message field's UTF-8 text, not a bearer capability.
 */
export interface Cursor {
  field?: HistoryField & string;
  position: HistoryRowAddress;
  offset: number;
}
export interface AgentHistoryLandmarksRead {
  sessionId: string;
  through: number;
}
/**
 * Sampled canonical display positions, not a complete Turn outline or an
 * execution grant.
 */
export interface AgentHistoryLandmarks {
  through: number;
  /**
   * @maxItems 64
   */
  landmarks: AgentHistoryLandmark[];
}
export interface AgentHistoryLandmark {
  importedTurn: number | null;
  order: HistoryOrder;
  lastOrder: HistoryOrder;
  turnId?: string | null;
  position: HistoryRowAddress;
  lastPosition: HistoryRowAddress;
  label: string;
  /**
   * The Host's attribution of the Turn's opening message, when it generated it.
   */
  origin?: MessageOrigin | null;
}
/**
 * Lexicographic tree order: original marker sequences followed by the leaf
 * sequence/ordinal. This is presentation order, never a fabricated Root sequence.
 */
export interface HistoryOrder {
  path: number[];
  itemIndex: number;
}
export interface AgentHistoryPromptRead {
  sessionId: string;
  through: number;
  position: HistoryRowAddress;
}
/**
 * A bounded presentation preview; the original message remains in history.
 */
export interface AgentHistoryPrompt {
  position: HistoryRowAddress;
  text: string;
}
export interface AgentPreviewPart {
  ordinal?: number | null;
  messageId: string;
  providerPartId?: string | null;
  startedAt: number;
  field: AgentPreviewField;
  /**
   * UTF-8 byte offset into the body, independent of JavaScript string length.
   */
  offset: number;
  totalBytes: number;
  text: string;
}
export interface AgentQueue {
  revision: number;
  entries: AgentQueueEntry[];
}
export interface AgentQueueEntry {
  origin?: MessageOrigin | null;
  messageId: string;
  kind: AgentQueueKind;
  preview: string;
}
export interface AgentComputerApps {
  entries: AgentComputerAppActivityState[];
}
export interface AgentComputerAppActivityState {
  activity: ComputerAppActivity;
  stopped: boolean;
}
export interface ComputerAppActivity {
  execution: ExecutionIdentity;
  operationId: string;
  target: GrantTarget;
  display: ComputerAppDisplay;
}
export interface AgentQueueMessage {
  sessionId: string;
  messageId: string;
  expectedRevision: number;
}
export interface AgentQueueMutation {
  sessionId: string;
  expectedRevision: number;
  edit: AgentQueueAction;
}
export interface AgentHistoryChunk {
  importedTurn: number | null;
  runId?: RunId | null;
  modelPart?: ModelPartIdentity | null;
  /**
   * The original user input has quotes, directory references or inline references.
   * Present only on the first fragment; display text cannot reconstruct these references.
   */
  hasReferences?: boolean;
  /**
   * Bounded quote display, present only on the first message fragment.
   */
  quotes?: HistoryQuote[];
  /**
   * Part of the successfully completed native Turn's final output at `through`.
   * Includes body text and source citations; never a Thinking field.
   */
  finalOutput?: boolean;
  /**
   * The provider identified this text as final before the Turn completed.
   */
  finalAnswer?: boolean;
  model?: HistoryModel | null;
  origin?: MessageOrigin | null;
  compaction?: HistoryCompaction | null;
  /**
   * Display metadata only, on the first user-message fragment; no storage capability.
   */
  attachments?: AgentHistoryAttachment[];
  timing?: HistoryTurnTiming | null;
  field: HistoryField;
  messageId?: string | null;
  turnId?: string | null;
  timestamp?: number | null;
  role: Role;
  /**
   * Stable display order; position remains the canonical source read address.
   */
  order: HistoryOrder;
  position: HistoryRowAddress;
  offset: number;
  totalBytes: number;
  text: string;
  tool: HistoryTool | null;
}
export interface ModelPartIdentity {
  stepId: StepId;
  attemptId: ModelAttemptId;
  ordinal: number;
}
/**
 * Display preview only; the original input retains complete text and provenance.
 */
export interface HistoryQuote {
  text: string;
  label?: string | null;
  truncated: boolean;
}
/**
 * Duration of a successfully adopted context checkpoint, in recorded milliseconds.
 */
export interface HistoryCompaction {
  durationMs: number;
}
export interface AgentHistoryAttachment {
  name: string;
  mimeType: string;
  bytes: number;
  kind: AttachmentKind;
}
/**
 * Recorded logical Turn boundaries at the same history fence. An unfinished
 * historical boundary alone does not establish that execution is still live.
 */
export interface HistoryTurnTiming {
  startedAt: number;
  finished: HistoryTurnFinished | null;
  executorUsage?: ExecutorTurnUsage | null;
  promptCache?: PromptCacheUsage | null;
}
export interface HistoryTurnFinished {
  at: number;
  outcome: HistoryTurnOutcome;
}
/**
 * Reported cache reads and their share of total prompt input.
 */
export interface PromptCacheUsage {
  inputTokens: number;
  readTokens: number;
}
/**
 * Canonical references at the requested fence, never execution authority.
 * Both references are present only for a unique same-Turn call/result pair
 * with matching origin and parentage. An unpaired row retains its own reference.
 */
export interface HistoryTool {
  toolUseId: string;
  call: HistoryToolCall | null;
  result: HistoryToolResult | null;
}
export interface HistoryToolCall {
  /**
   * Recorded ancestors in this Turn, nearest first; display references only.
   */
  ancestorToolUseIds: string[];
  origin: HistoryToolCallOrigin;
  /**
   * Opaque display contract captured at dispatch; no execution authority.
   */
  presentation?: string | null;
  position: HistoryRowAddress;
  name: string;
  title: DisplayText | null;
  /**
   * This native Turn is still open at the history fence; not execution authority.
   */
  pending: boolean;
  /**
   * A unique original Host dispatch is recorded at this fence; not liveness.
   */
  dispatched: boolean;
  externalTarget?: ExternalToolTarget | null;
}
export interface HistoryToolResult {
  settlement: ToolSettlement | null;
  position: HistoryRowAddress;
  /**
   * A failed or unknown effect, or a returned result that reports failure.
   */
  isError: boolean;
  /**
   * Canonical content is an image; this does not grant artifact reads.
   */
  image: boolean;
  /**
   * Images the model received beside non-image content, readable by index.
   */
  images: number;
  details?: ToolResultDetails | null;
}
export interface AgentHistorySearch {
  sessionId: string;
  /**
   * Original raw-event fence, shared with history reads.
   */
  through: number;
  /**
   * Exclusive transcript-row position; null starts a scan.
   */
  after?: HistoryRowAddress | null;
  /**
   * Literal query; no normalization.
   */
  query: string;
  /**
   * False uses Unicode simple case folding, without locale or multi-character folding.
   */
  caseSensitive: boolean;
  /**
   * Require no adjacent Unicode word character (Alphabetic, marks, decimal
   * digits, connector punctuation or join controls); not dictionary segmentation.
   */
  wholeWord: boolean;
  includeInternal: boolean;
}
export interface AgentHistoryMatch {
  order: HistoryOrder;
  /**
   * Exact canonical field to read through the source query; history body may omit it.
   */
  field: SourceField;
  /**
   * Exact transcript row. Open with HistoryPosition::Row at the same raw-event
   * fence: Thinking for a thinking match, Body for every other source field.
   */
  position: HistoryRowAddress;
  preview: string;
}
export interface AgentHistorySourceRead {
  sessionId: string;
  through: number;
  source: AgentHistorySourceReference;
  field: SourceField;
  /**
   * Optional JSON keys/array indices within arguments, result or receipt.
   */
  path?: HistorySourceSegment[] | null;
  position: SourcePosition;
}
/**
 * One literal UTF-8 excerpt of an immutable field. JSON excerpts need not be
 * standalone JSON. Image descriptors carry no artifact read authorization.
 */
export interface HistorySource {
  model?: HistoryModel | null;
  origin?: MessageOrigin | null;
  position: HistoryRowAddress;
  /**
   * Host-recorded milliseconds of this immutable row; not a client clock.
   */
  timestamp?: number | null;
  role: HistorySourceRole;
  /**
   * Readable canonical fields of this same immutable row, in display order.
   *
   * @minItems 1
   */
  fields: [SourceField, ...SourceField[]];
  field: SourceField;
  /**
   * Omission reads the encoded field. A selected JSON string is literal text.
   */
  path?: HistorySourceSegment[] | null;
  format: SourceFormat;
  offset: number;
  totalBytes: number;
  text: string;
  tool: HistoryTool | null;
}
export interface AgentToolImageRead {
  sessionId: string;
  through: number;
  position: HistoryRowAddress;
  /**
   * Selects one of `HistoryToolResult.images`; absent when the content is the image.
   */
  image?: number | null;
  offset: number;
}
export interface AgentAttachmentImageRead {
  sessionId: string;
  source: AgentAttachmentImageSource;
  offset: number;
}
/**
 * A stable raw-event fence prevents a window from chasing appended messages.
 */
export interface Read {
  sessionId: string;
  through?: number | null;
  position: HistoryPosition;
  includeThinking?: boolean;
}
export interface HostActivation {
  contract: Contract;
  service: string[];
}
export interface Scan {
  prefix?: string;
  after?: string | null;
}
export interface Mutation {
  key: string;
  expectedRevision?: number | null;
  data: Data;
}
/**
 * Actual callback observation. Neither the source nor receipt is a grant.
 */
export interface HostObservation {
  source: Identity2;
  operation?: RecoveryRef | null;
}
export interface OperationObservation {
  reference: RecoveryRef;
  outcome: OperationOutcome;
  cleanup: OperationCleanup;
}
export interface OperationReply {
  reference: RecoveryRef;
  receipt: Receipt;
}
export interface ResourceMetadata {
  type: ResourceType;
  bytes: number;
  metadata: unknown;
}
/**
 * Deletions retain a revision, preventing stale writers from recreating a key
 * as if it had never existed. Revision is not a business schema version.
 */
export interface StateRecord {
  revision: number;
  data: Data;
}
export interface StatePage {
  entries: Entry[];
  nextAfter?: string | null;
}
export interface Entry {
  key: string;
  record: StateRecord;
}
