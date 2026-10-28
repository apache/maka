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

import type {
  ModelSelection,
  AgentSend,
  AgentResume,
  WorkHubResolve,
  WorkHubCoordinator,
  WorkHubTask,
  WorkHubControl,
  WorkHubControlRead,
  WorkHubConfiguration,
  AgentFileListRead,
  AgentFileWatch,
  AgentFilePage,
  AgentFileChange,
  WorkspacePath,
  AgentWorkRead,
  AgentExecutionResult,
  AgentHistoryPage,
  AgentSessionPage,
  AgentList,
  HistoryPosition,
  SetDefaultConnectionTargetInput,
  SettingsModelsPage,
  ConnectionCatalogEntryUpdate,
  ConnectionCredentialTarget,
  SettingsSaveCredential,
  SettingsCredentialSaveResult,
  SettingsConnectionsPage,
  SettingsProvidersRead,
  CredentialMutationResult,
  CatalogMutationResult,
  HostRequest,
  RequestContext,
  ServiceMethods,
  RecoveryRef,
} from '@maka-agent/plugin-sdk';

function forgedReceiptReference(reference: RecoveryRef) {
  // @ts-expect-error A reference cannot select a Root or convey a recovery grant.
  const forged = { ...reference, root: '/other', grant: 'approved' } satisfies RecoveryRef;
  void forged;
}
void forgedReceiptReference;

const fabricated = {
  operation: 'read',
  slot: 'text',
  start: 0,
  end: 1,
  // @ts-expect-error Resource slots cannot carry fabricated bearer handles.
  token: 'grant',
} satisfies HostRequest;
const incompleteCall = {
  operation: 'call',
  import: 'echo',
  provider: 0,
  method: 'echo',
  input: null,
} as const;
// @ts-expect-error Every forward maps actual resource slots explicitly.
const missingSlots: HostRequest = incompleteCall;
async function unknownResult(context: RequestContext) {
  const result = await context.invoke({
    operation: 'call',
    import: 'echo',
    provider: 0,
    method: 'echo',
    input: null,
    attachments: {},
  });
  // @ts-expect-error An unchecked service result is not consumer-selected T.
  const text: string = result;
}
void [fabricated, incompleteCall, missingSlots, unknownResult];

const mutation = {
  operation: 'mutate',
  import: 'echo',
  provider: 0,
  method: 'echo',
  input: null,
  operationId: '00000000-0000-4000-8000-000000000001',
  attachments: {},
} satisfies HostRequest;
const incompleteMutation = {
  operation: 'mutate',
  import: 'echo',
  provider: 0,
  method: 'echo',
  input: null,
  attachments: {},
} as const;
// @ts-expect-error An explicit durable operation identity is required.
const missingOperation: HostRequest = incompleteMutation;
const fabricatedMutation = {
  ...mutation,
  // @ts-expect-error The original bundle identity is private Host custody.
  capture: '00000000-0000-4000-8000-000000000001',
  attachments: { text: 'text' },
} satisfies HostRequest;
void [mutation, missingOperation, fabricatedMutation];

async function durableReceipt(context: RequestContext) {
  const reply = await context.invoke(mutation);
  const operation: string = reply.reference.operation;
  // @ts-expect-error Acceptance never proves that the journal has a result.
  const prematureOutcome = reply.receipt.outcome;
  if (reply.receipt.kind === 'recorded' && reply.receipt.outcome.kind === 'returned') {
    // @ts-expect-error Business output must still be checked against its contract.
    const text: string = reply.receipt.outcome.value;
    void text;
  }
  const recovered = await context.invoke({ operation: 'recover', reference: reply.reference });
  const sameSource = recovered.reference.source;
  if (recovered.receipt.kind === 'unavailable') {
    const reason: string = recovered.receipt.diagnostic;
    void reason;
  }
  void [operation, prematureOutcome, sameSource];
}
const incompleteRecovery = { operation: 'recover' } as const;
// @ts-expect-error Recovery requires the original reference, not a current provider alias.
const missingReference: HostRequest = incompleteRecovery;
void [durableReceipt, missingReference];

async function publishSubscriptionItem(context: RequestContext) {
  const published: null = await context.invoke({ operation: 'emit', value: { delta: 'hello' } });
  const forged = {
    operation: 'emit',
    value: 'hello',
    // @ts-expect-error Publishing is request-local, not selected by another request ID.
    subscriptionId: 'other',
  } satisfies HostRequest;
  void [published, forged];
}
void publishSubscriptionItem;

const selectedModel: ModelSelection = {
  connectionId: 'observed-connection',
  revision: 3,
  modelId: 'chosen-model',
};
const uploadedAttachmentIds: string[] = Array.from(
  { length: 9 },
  (_, index) => `attachment-${index}`,
);
const explicitSend: AgentSend = {
  attachments: uploadedAttachmentIds,
  sessionId: 'conversation',
  message: 'Hello',
  model: selectedModel,
};
const resumeOriginal: AgentResume = {
  sessionId: 'conversation',
  sourceInvocationId: 'original-invocation',
  sourceHighWater: 12,
  model: selectedModel,
};
function resumeReceipt(value: AgentExecutionResult) {
  return value.kind === 'found' ? value.execution.invocationId : null;
}
void [resumeOriginal, resumeReceipt];
const clearDefault: SetDefaultConnectionTargetInput = { expectedCatalogRevision: 5, target: null };
// @ts-expect-error Absence is not an explicit clear.
const missingDefault: SetDefaultConnectionTargetInput = { expectedCatalogRevision: 5 };
const exhaustedModels: SettingsModelsPage = {
  kind: 'ready',
  revision: 5,
  choices: [],
  defaultModel: { kind: 'none' },
  next: null,
};
// @ts-expect-error Serialized nullable cursor requires field presence.
const missingCursor: SettingsModelsPage = {
  kind: 'ready',
  revision: 5,
  choices: [],
  defaultModel: { kind: 'none' },
};
// @ts-expect-error Every ready page must explicitly observe the saved default.
const missingDefaultProjection: SettingsModelsPage = {
  kind: 'ready',
  revision: 5,
  choices: [],
  next: null,
};
// @ts-expect-error A send cannot inherit an implicit activation model.
const implicitSend: AgentSend = { sessionId: 'conversation', message: 'Hello' };
void [
  explicitSend,
  clearDefault,
  missingDefault,
  exhaustedModels,
  missingCursor,
  missingDefaultProjection,
  implicitSend,
];

// Basic editing must not require resending hidden model inventories.
const nameOnly: ConnectionCatalogEntryUpdate = { name: 'Personal' };
const explicitEmpty: ConnectionCatalogEntryUpdate = { enabled: false, enabledModelIds: [] };
const clearPatches: ConnectionCatalogEntryUpdate = {
  modelOverrides: null,
  requestBodyOverlay: null,
};
// @ts-expect-error A present basic field cannot be null.
const nullName: ConnectionCatalogEntryUpdate = { name: null };
// @ts-expect-error An override field may be omitted but not supplied as null.
const nullVision: ConnectionCatalogEntryUpdate = { modelOverrides: { model: { vision: null } } };
const providersRead: SettingsProvidersRead = { offset: 0 };
// @ts-expect-error Provider paging uses an explicit offset.
const missingOffset: SettingsProvidersRead = {};
function settingsObservations(target: ConnectionCredentialTarget) {
  const rejectedCatalog: CatalogMutationResult = {
    kind: 'rejected',
    reason: 'invalid_configuration',
  };
  const rejectedCredential: CredentialMutationResult = {
    kind: 'rejected',
    reason: 'invalid_input',
  };
  const rejectedSave: SettingsCredentialSaveResult = { kind: 'rejected', reason: 'invalid_secret' };
  // @ts-expect-error Rejections carry a closed reason, never arbitrary diagnostics.
  const rawError: CatalogMutationResult = { kind: 'rejected', reason: 'user payload' };
  // @ts-expect-error Confirmed rejection requires an explicit reason.
  const missingReason: CredentialMutationResult = { kind: 'rejected' };
  const leakedInput: SettingsCredentialSaveResult = {
    kind: 'rejected',
    reason: 'invalid_secret',
    // @ts-expect-error An original secret never enters the public result.
    secret: 'private',
  };
  const absent: SettingsSaveCredential = { expected: target, expectedCredential: null };
  // @ts-expect-error Omission does not prove that no credential was observed.
  const unobserved: SettingsSaveCredential = { expected: target };
  const secretInJson: SettingsSaveCredential = {
    ...absent,
    // @ts-expect-error Secrets are request-local resource captures, never input JSON.
    secret: 'private',
  };
  const page: SettingsConnectionsPage = {
    kind: 'ready',
    revision: 1,
    connections: [],
    defaultTarget: null,
    next: null,
  };
  // @ts-expect-error Serialized nullable fields require explicit presence.
  const incomplete: SettingsConnectionsPage = { kind: 'ready', revision: 1, connections: [] };
  const basis = { connectionId: target.connectionId, revision: target.revision };
  const removed: CredentialMutationResult = {
    kind: 'connection_stale',
    expected: basis,
    actual: null,
  };
  // @ts-expect-error A stale result explicitly describes absence.
  const missingActual: CredentialMutationResult = { kind: 'connection_stale', expected: basis };
  const noConnectionCommit: CatalogMutationResult = { kind: 'committed', catalogRevision: 2 };
  // @ts-expect-error A stale catalog result explicitly describes absence.
  const missingCatalogActual: CatalogMutationResult = { kind: 'connection_stale', expected: basis };
  void [
    rejectedCatalog,
    rejectedCredential,
    rejectedSave,
    rawError,
    missingReason,
    leakedInput,
    absent,
    unobserved,
    secretInJson,
    page,
    incomplete,
    removed,
    missingActual,
    noConnectionCommit,
    missingCatalogActual,
  ];
}
void [
  nameOnly,
  explicitEmpty,
  clearPatches,
  nullName,
  nullVision,
  providersRead,
  missingOffset,
  settingsObservations,
];

const historyWindow = {
  kind: 'ready',
  through: 16,
  chunks: [],
  before: null,
  after: { position: { sourceSequence: 16, itemIndex: 0 }, offset: 0 },
} satisfies AgentHistoryPage;
// @ts-expect-error Missing boundaries are not end-of-history receipts.
const missingHistoryBoundary: AgentHistoryPage = {
  kind: 'ready',
  through: 16,
  chunks: [],
  after: null,
};
const removedHistoryPosition = {
  // @ts-expect-error The removed one-way cursor position is not an alias.
  kind: 'cursor',
  cursor: { position: { sourceSequence: 16, itemIndex: 0 }, offset: 0 },
} satisfies HistoryPosition;
const exactHistoryRow = {
  kind: 'row',
  position: { sourceSequence: 16, itemIndex: 2 },
  field: 'thinking',
} satisfies HistoryPosition;
void [historyWindow, missingHistoryBoundary, removedHistoryPosition, exactHistoryRow];

const sessionWindow = {
  revision: 'catalog',
  needsYouCount: 0,
  sessions: [],
  before: null,
  after: null,
} satisfies AgentSessionPage;
// @ts-expect-error A missing boundary is not an end-of-catalog receipt.
const missingSessionBoundary: AgentSessionPage = {
  revision: 'catalog',
  needsYouCount: 0,
  sessions: [],
  after: null,
};
// @ts-expect-error A bounded page length is not the complete pending-session count.
const missingSessionCount: AgentSessionPage = {
  revision: 'catalog',
  sessions: [],
  before: null,
  after: null,
};
const refreshSessionPage = {
  filter: 'all',
  position: { kind: 'at', cursor: 'session' },
} satisfies AgentList;
const nextSessionPage = {
  filter: 'needs_you',
  position: { kind: 'after', revision: 'catalog', cursor: 'session' },
} satisfies AgentList;
const unfencedSessionPage: AgentList = {
  filter: 'all',
  // @ts-expect-error Every continuation belongs to one catalog revision.
  position: { kind: 'before', cursor: 'session' },
};
void [
  sessionWindow,
  missingSessionBoundary,
  missingSessionCount,
  refreshSessionPage,
  nextSessionPage,
  unfencedSessionPage,
];

const resolveCoordinator: WorkHubResolve = {
  workspace: {
    rootId: 'root-1',
    segments: [],
    directoryIdentity: `sha256:${'0'.repeat(64)}`,
  },
};
function coordinatorSession(value: WorkHubCoordinator): string | null {
  return value.kind === 'ready' ? value.session.id : null;
}
void resolveCoordinator;
void coordinatorSession;

const messageWork: AgentWorkRead = {
  sessionId: 'worker-session',
  target: { kind: 'message', messageId: 'original-message' },
};
function taskExecution(task: WorkHubTask): string | null {
  const status = task.status;
  if (status.kind === 'started' && status.progress?.kind === 'delivered')
    return status.progress.execution.invocationId;
  if (status.kind === 'queued' && status.progress?.kind === 'delivered')
    return status.progress.shared ? null : status.progress.execution.invocationId;
  return null;
}
function coordinatorWorkers(configuration: WorkHubConfiguration): string[] {
  return configuration.workers;
}
const answerPage: AgentWorkRead = {
  sessionId: 'worker-session',
  target: { kind: 'invocation', invocationId: 'original-invocation' },
  cursor: { invocationId: 'answer-invocation', offset: 768 },
};
const originalControl: WorkHubControlRead = { controlId: `wc_${'0'.repeat(64)}` };
function controlStopped(control: WorkHubControl): boolean | null {
  const status = control.status;
  return status.kind === 'returned' && status.outcome.kind === 'stop'
    ? status.outcome.result.requested
    : null;
}
void [messageWork, answerPage, originalControl, controlStopped, taskExecution, coordinatorWorkers];

// Workspace file browsing uses Session authority and exact relative path bytes.
const workspaceRootFiles = {
  sessionId: 'session',
  path: null,
  after: null,
} satisfies AgentFileListRead;
const directoryWatch = { sessionId: 'session', path: null } satisfies AgentFileWatch;
// @ts-expect-error Root selection is explicit; omission is not another path spelling.
const missingFilePath = { sessionId: 'session' } satisfies AgentFileWatch;
// @ts-expect-error A workspace path is encoded bytes, never an absolute Host pathname.
const ambientFilePath: WorkspacePath = '/private/other';
function continueWorkspaceFiles(page: AgentFilePage): AgentFileListRead {
  for (const entry of page.entries) {
    const exactPath: WorkspacePath = entry.path;
    void exactPath;
  }
  return { sessionId: 'session', path: null, after: page.next };
}
function observeWorkspaceFiles(change: AgentFileChange) {
  if (change.kind === 'ready') {
    const originalDirectory: string = change.directoryIdentity;
    void originalDirectory;
  } else if (change.kind === 'unavailable') {
    const reason: 'directory_changed' = change.reason;
    void reason;
  }
  // @ts-expect-error File invalidation has no durable event replay cursor.
  const replay = change.after;
  void replay;
}
void [
  workspaceRootFiles,
  directoryWatch,
  missingFilePath,
  ambientFilePath,
  continueWorkspaceFiles,
  observeWorkspaceFiles,
];

// The method map uses the actual contract route and mode, not caller-selected T.
// @ts-expect-error A missing method is not an arbitrary plugin result type.
type MissingAgentMethod = ServiceMethods['agent']['missingMethod'];
const historyMode: ServiceMethods['agent']['history']['mode'] = 'query';
// @ts-expect-error Query methods cannot become subscriptions in the generated map.
const historySubscription: ServiceMethods['agent']['history']['mode'] = 'subscription';
// @ts-expect-error Session continuations require their explicit position.
const unfencedListInput: ServiceMethods['agent']['list']['input'] = { filter: 'all' };
void [historyMode, historySubscription, unfencedListInput];
