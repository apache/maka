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

import { tr, type MessageKey } from './locale';
import { record, type ToolSection } from './toolCards';
import type { ActivityFieldContext, ActivityPresentation } from './toolActivityPresentation';

function section(label: MessageKey, value: unknown, style?: ToolSection['style']): ToolSection[] {
  return typeof value === 'string' && value.trim()
    ? [{ label: tr(label), text: value, style }]
    : [];
}

function status(label: MessageKey, tone?: ToolSection['tone']): ToolSection[] {
  return [{ label: tr('Status'), text: tr(label), tone }];
}

function fromRecord(
  project: (value: Record<string, unknown>, context: ActivityFieldContext) => ToolSection[] | null,
) {
  return (value: unknown, context: ActivityFieldContext) => {
    const data = record(value);
    return data && project(data, context);
  };
}

const model = (value: unknown) => {
  const selection = record(value);
  return section('Model', selection?.modelId ?? record(selection?.selection)?.executor);
};

function conversation(value: unknown, context: ActivityFieldContext): ToolSection[] {
  if (typeof value !== 'string') return [];
  return section('Conversation', context?.sessionTitle?.(value));
}

const target = fromRecord((input, context) => conversation(input.sessionId, context));

const activityLabels: Record<string, MessageKey> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for input',
};

const waitLabels: Record<string, MessageKey> = {
  cell: 'Script output',
  external: 'External agent',
  provider_backoff: 'Model provider',
  model: 'Model response',
  approval: 'Approval',
  retry: 'Retry',
  operation: 'Tool result',
  child: 'Delegated work',
  blocker: 'Execution blocker',
};

const rejectionLabels: Record<string, MessageKey> = {
  permission_change_requires_user: 'Only the user can change permissions',
  title_invalid: 'Conversation title is invalid',
  labels_invalid: 'Conversation labels are invalid',
  tools_unavailable: 'Requested tools are unavailable',
  busy: 'Conversation is busy',
  workspace_unavailable: 'Workspace is unavailable',
  session_unavailable: 'Conversation is unavailable',
  history_unavailable: 'Conversation history is unavailable',
  model_unavailable: 'Selected model is unavailable',
  skills_unavailable: 'Requested skills are unavailable',
  turn_stopped: 'The turn was stopped before delivery',
  original_operation_unsettled: 'The original send is still being resolved',
  closed: 'Conversation is closed',
  archived: 'Conversation is archived',
  source_missing: 'Original run was not found',
  source_changed: 'Original run has changed',
  source_not_terminal: 'Original run is still active',
  already_continued: 'Original run has already been continued',
  workspace_changed: 'Workspace has changed',
  safety_check_failed: 'Continuation is blocked',
  not_your_child: 'This conversation is not managed by the caller',
  human_action_required: 'User action required',
  authorization_changed: 'Permissions have changed',
  permission_requests_disabled: 'Permission requests are disabled',
  unavailable: 'Request is unavailable',
  invalid_answer: 'Answer is invalid',
  unsupported: 'Answer is unsupported',
  not_your_message: 'This message belongs to another sender',
  missing: 'Message is unavailable',
  in_flight: 'Message is already being delivered',
  invalid_edit: 'Queue change is invalid',
  execution_changed: 'Active run has changed',
  not_running: 'Conversation is not running',
};

function rejection(value: Record<string, unknown>): ToolSection[] | null {
  if (value.kind === 'revision_conflict') return status('Conversation changed', 'warning');
  if (value.kind !== 'rejected') return null;
  const reason = typeof value.reason === 'string' ? rejectionLabels[value.reason] : undefined;
  return status(reason ?? 'Rejected', 'error');
}

const sessionDetails = (value: unknown, outcome?: MessageKey): ToolSection[] | null => {
  const session = record(value);
  if (!session || typeof session.title !== 'string') return null;
  const activity =
    typeof session.activity === 'string' ? activityLabels[session.activity] : undefined;
  const access = record(session.permissions)?.access;
  const permission =
    access === 'read_only'
      ? 'Read only'
      : access === 'workspace_write'
        ? 'Workspace write'
        : access === 'danger_full_access'
          ? 'Full access'
          : null;
  return [
    ...section('Conversation', session.title),
    ...(outcome
      ? status(outcome)
      : session.archived === true
        ? status('Archived')
        : activity
          ? status(activity)
          : []),
    ...section('Workspace', record(session.workspace)?.path, 'code'),
    ...model(session.backend),
    ...(permission ? section('Permissions', tr(permission)) : []),
  ];
};

const newConversation = fromRecord((input, { returned }) =>
  returned
    ? []
    : [
        ...section('Conversation', input.title),
        ...section('Workspace', record(input.workspace)?.path, 'code'),
        ...model(input.backend),
      ],
);

function changedConversation(kind: string, outcome?: MessageKey) {
  return fromRecord((result) => {
    if (result.kind === kind) return sessionDetails(result.session, outcome);
    if (result.kind === 'removed') return status('Conversation deleted');
    return rejection(result);
  });
}

const sendResult = fromRecord((result) => {
  const notification =
    result.completion === 'registered' ? section('Notification', tr('Notify when work ends')) : [];
  switch (result.kind) {
    case 'started':
      return [...status('Run started'), ...notification];
    case 'queued':
      return [...status('Message queued'), ...notification];
    case 'not_your_worker':
      return status('This conversation is not managed by the caller', 'error');
    default:
      return rejection(result);
  }
});

function executionState(value: unknown): ToolSection[] | null {
  const state = record(record(value)?.state);
  switch (state?.kind) {
    case 'admitted':
      return status('Run accepted');
    case 'running':
      return status('Running when checked');
    case 'waiting': {
      const waits = Array.isArray(state.waits)
        ? [
            ...new Set(
              state.waits.flatMap((entry) => {
                const kind = record(entry)?.kind;
                const label = typeof kind === 'string' ? waitLabels[kind] : undefined;
                return label ? [tr(label)] : [];
              }),
            ),
          ]
        : [];
      return [
        ...status('Waiting when checked'),
        ...section('Waiting for', waits.join(' · ')),
        ...(state.authorityUnavailable === true
          ? [
              {
                label: tr('Permissions'),
                text: tr('Permissions are unavailable'),
                tone: 'warning' as const,
              },
            ]
          : []),
      ];
    }
    case 'completed':
      return status('Completed');
    case 'failed':
      return [
        ...status('Failed', 'error'),
        ...section('Details', record(state.reason)?.diagnostic),
      ];
    case 'cancelled':
      return status('Run cancelled');
    default:
      return null;
  }
}

const workResult = fromRecord((result) => {
  switch (result.kind) {
    case 'missing':
      return status('Work was not found', 'warning');
    case 'pending':
      return status('Message awaiting delivery');
    case 'cancelled':
      return status('Message cancelled');
    case 'changed':
      return status('Work changed since the previous check', 'warning');
    case 'delivered': {
      const state = executionState(result.execution);
      if (!state) return null;
      const answer = record(result.answer);
      return [
        ...state,
        ...section('Final response', answer?.text),
        ...(answer?.next ? section('Details', tr('More response text is available')) : []),
        ...(typeof result.pendingInteractions === 'number' && result.pendingInteractions > 0
          ? section(
              'Waiting for',
              tr('Requests needing attention ({count})', { count: result.pendingInteractions }),
            )
          : []),
      ];
    }
    default:
      return null;
  }
});

const interactionLabels: Record<string, MessageKey> = {
  session_approval: 'Approval',
  service_approval: 'Approval',
  question: 'Question',
  permissions: 'Permissions',
  form: 'Form',
  client_capability: 'Capability approval',
  computer_app: 'Computer access',
  system_permission: 'System permission',
};

const approvalLabels: Record<string, MessageKey> = {
  allow: 'Allow',
  deny: 'Deny',
  once: 'Allow once',
  run: 'Allow for this run',
  session: 'Allow for this session',
  always: 'Always allow',
};

function approvalDecision(value: unknown): string | undefined {
  const decision = record(value);
  const scope = decision?.decision === 'allow' ? (decision.scope ?? 'allow') : decision?.decision;
  const kind = decision ? scope : value;
  const label = typeof kind === 'string' ? approvalLabels[kind] : undefined;
  return label ? tr(label) : undefined;
}

function interaction(value: unknown): ToolSection[] | null {
  const data = record(value);
  const request = record(data?.request);
  if (!data || !request || typeof request.kind !== 'string') return null;
  const label = interactionLabels[request.kind];
  const outcome = record(data.outcome);
  const decision = record(outcome?.decision)?.decision ?? outcome?.decision;
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const answers = Array.isArray(outcome?.answers) ? outcome.answers : [];
  const permissionRequest = record(request.request);
  const application = record(request.display)?.name ?? request.application;
  const state = !outcome
    ? 'Waiting for input'
    : outcome.kind === 'closure'
      ? 'Request closed'
      : decision === 'deny'
        ? 'Denied'
        : approvalDecision(outcome.decision) || outcome.kind === 'system_permission_granted'
          ? 'Allowed'
          : 'Response recorded';
  return [
    ...status(state, decision === 'deny' ? 'warning' : undefined),
    ...section('Request', label ? tr(label) : undefined),
    ...section('Application', application),
    ...section('Details', permissionRequest?.reason ?? request.message ?? request.toolName),
    ...section('Requested command', record(permissionRequest?.command)?.command, 'code'),
    ...(state === 'Allowed' ? section('Decision', approvalDecision(outcome?.decision)) : []),
    ...questions.flatMap((question, index) => [
      ...section('Question', record(question)?.question),
      ...section('Answer', answers[index]),
    ]),
  ];
}

function labels(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join(' · ')
    : '';
}

const actions: Record<string, MessageKey> = {
  archive: 'Archive',
  restore: 'Restore',
  remove: 'Delete',
  retract: 'Retract message',
  promote: 'Deliver sooner',
  update: 'Edit message',
  reorder: 'Reorder messages',
};

const historyResult = fromRecord((result) => {
  if (result.kind !== 'ready' || !Array.isArray(result.chunks)) return null;
  const messages = result.chunks.flatMap((chunk) => {
    const row = record(chunk);
    if (!row || row.field !== 'body') return [];
    const label =
      row.role === 'assistant'
        ? 'Agent'
        : row.role === 'user'
          ? 'User'
          : row.role === 'failure'
            ? 'Failed'
            : null;
    return label ? section(label, row.text) : [];
  });
  return messages.length
    ? messages
    : status(
        result.chunks.length ? 'This page contains activity records' : 'No conversation records',
      );
});

const queueKinds: Record<string, MessageKey> = {
  in_flight: 'Delivering message',
  steering: 'Pending update',
  followup: 'Queued follow-up',
};

export const sessionToolPresentations: Record<string, ActivityPresentation> = {
  'maka.agent.Agent@1/models': {
    title: () => tr('Find available models'),
    icon: 'search',
    arguments: fromRecord((input) => {
      const request = record(input.request) ?? input;
      return section('Search', request.query ?? record(request.cursor)?.query);
    }),
    result: fromRecord((result) => {
      if (result.kind === 'changed') return status('Model list changed', 'warning');
      if (result.kind !== 'ready' || !Array.isArray(result.choices)) return null;
      return result.choices.length
        ? section(
            'Models',
            result.choices
              .flatMap((item) => {
                const choice = record(item);
                return typeof choice?.label === 'string'
                  ? [
                      [choice.label, choice.sourceName]
                        .filter((text) => typeof text === 'string' && text)
                        .join(' · '),
                    ]
                  : [];
              })
              .join('\n'),
          )
        : status('No matching models');
    }),
  },
  'maka.agent.Agent@1/list': {
    title: () => tr('Find conversations'),
    icon: 'search',
    arguments: fromRecord((input) => [
      ...section('Search', input.titleQuery),
      ...(record(input.scope)?.kind === 'children'
        ? section('Scope', tr('Delegated conversations'))
        : []),
      ...(input.filter === 'archived' ? section('Scope', tr('Archived')) : []),
    ]),
    result: fromRecord((result) =>
      Array.isArray(result.sessions)
        ? result.sessions.length
          ? section(
              'Conversations',
              result.sessions
                .map((item) => record(item)?.title)
                .filter((title): title is string => typeof title === 'string')
                .join('\n'),
            )
          : status('No matching conversations')
        : null,
    ),
  },
  'maka.agent.Agent@1/observe': {
    title: () => tr('Inspect conversation'),
    icon: 'split',
    arguments: target,
    result: fromRecord((result) => sessionDetails(result.session)),
  },
  'maka.agent.Agent@1/history': {
    title: () => tr('Read conversation history'),
    icon: 'book',
    arguments: target,
    result: historyResult,
  },
  'maka.agent.Agent@1/create': {
    title: () => tr('Create conversation'),
    icon: 'plus',
    arguments: newConversation,
    result: changedConversation('created', 'Conversation created'),
  },
  'maka.agent.Agent@1/fork': {
    title: () => tr('Fork conversation'),
    icon: 'fork',
    arguments: newConversation,
    result: changedConversation('forked', 'Conversation forked'),
  },
  'maka.agent.Agent@1/metadata': {
    title: () => tr('Update conversation'),
    icon: 'edit',
    arguments: fromRecord((input) => [
      ...section('Title', input.title),
      ...section('Labels', labels(input.labels)),
      ...(typeof input.pinned === 'boolean'
        ? section('Pin', tr(input.pinned ? 'Pinned' : 'Unpinned'))
        : []),
    ]),
    result: changedConversation('committed', 'Conversation updated'),
  },
  'maka.agent.Agent@1/changeSession': {
    title: () => tr('Manage conversation'),
    icon: 'archive',
    arguments: fromRecord((input, context) => [
      ...section(
        'Action',
        typeof input.action === 'string' && actions[input.action]
          ? tr(actions[input.action]!)
          : undefined,
      ),
      ...conversation(input.sessionId, context),
    ]),
    result: changedConversation('changed'),
  },
  'maka.agent.Agent@1/send': {
    title: () => tr('Send message to agent'),
    icon: 'send',
    arguments: fromRecord((input, context) => [
      ...section('Message', input.message),
      ...(input.delivery === 'queue' ? section('Delivery', tr('After the current turn')) : []),
      ...model(input.backend),
      ...conversation(input.sessionId, context),
    ]),
    result: sendResult,
  },
  'maka.agent.Agent@1/stop': {
    title: () => tr('Stop conversation run'),
    icon: 'stop',
    arguments: target,
    result: fromRecord((result) =>
      typeof result.requested === 'boolean'
        ? status(result.requested ? 'Stop requested' : 'No active run to stop')
        : null,
    ),
  },
  'maka.agent.Agent@1/continueRun': {
    title: () => tr('Continue conversation run'),
    icon: 'play',
    arguments: fromRecord((input, context) => [
      ...model(input.model),
      ...conversation(input.sessionId, context),
    ]),
    result: fromRecord((result) =>
      result.kind === 'started' ? status('Continuation started') : rejection(result),
    ),
  },
  'maka.agent.Agent@1/pendingInteractions': {
    title: () => tr('Check for pending requests'),
    icon: 'inbox',
    arguments: target,
    result: fromRecord((result) => {
      if (!Array.isArray(result.entries)) return null;
      if (!result.entries.length) return status('No pending requests');
      return section(
        'Requests',
        result.entries
          .flatMap((entry) => {
            const kind = record(entry)?.kind;
            const label = typeof kind === 'string' ? interactionLabels[kind] : undefined;
            return label ? [tr(label)] : [];
          })
          .join('\n'),
      );
    }),
  },
  'maka.agent.Agent@1/interaction': {
    title: () => tr('Read a pending request'),
    icon: 'inbox',
    arguments: target,
    result: interaction,
  },
  'maka.agent.Agent@1/respond': {
    title: () => tr('Respond to a request'),
    icon: 'check',
    arguments: fromRecord((input, context) => {
      const answer = record(input.answer);
      return [
        ...section('Decision', approvalDecision(answer?.decision)),
        ...(Array.isArray(answer?.answers)
          ? answer.answers.flatMap((text) => section('Answer', text))
          : []),
        ...conversation(input.sessionId, context),
      ];
    }),
    result: fromRecord((result) =>
      result.kind === 'recorded' ? interaction(result.record) : rejection(result),
    ),
  },
  'maka.agent.Agent@1/queue': {
    title: () => tr('Read queued messages'),
    icon: 'queue',
    arguments: target,
    result: fromRecord((result) => {
      if (!Array.isArray(result.entries)) return null;
      if (!result.entries.length) return status('No queued messages');
      return result.entries.flatMap((entry) => {
        const item = record(entry);
        const kind = typeof item?.kind === 'string' ? queueKinds[item.kind] : undefined;
        return section(kind ?? 'Message', item?.preview);
      });
    }),
  },
  'maka.agent.Agent@1/editQueue': {
    title: () => tr('Update queued messages'),
    icon: 'queue',
    arguments: fromRecord((input, context) => {
      const edit = record(input.edit);
      const action = typeof edit?.kind === 'string' ? actions[edit.kind] : undefined;
      return [
        ...section('Action', action ? tr(action) : undefined),
        ...section('Message', edit?.message),
        ...conversation(input.sessionId, context),
      ];
    }),
    result: fromRecord((result) =>
      result.kind === 'committed' ? status('Queue updated') : rejection(result),
    ),
  },
  'maka.agent.Agent@1/work': {
    title: () => tr('Check conversation progress'),
    icon: 'activity',
    arguments: target,
    result: workResult,
  },
  'maka.agent.Agent@1/execution': {
    title: () => tr('Inspect conversation run'),
    icon: 'activity',
    arguments: target,
    result: fromRecord((result) =>
      result.kind === 'found'
        ? executionState(result.execution)
        : result.kind === 'missing'
          ? status('Run was not found', 'warning')
          : null,
    ),
  },
};
