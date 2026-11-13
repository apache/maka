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

import { currentLocale, tr } from './locale';
import { formatDuration } from './duration';
import type { ActivityPresentation } from './toolActivityPresentation';
import { record, toolResult, type ToolSection } from './toolCards';

function section(label: string, text: unknown): ToolSection[] {
  return typeof text === 'string' && text.trim() ? [{ label, text }] : [];
}

function textItems(value: unknown, key: string): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = record(item)?.[key];
        return typeof text === 'string' && text.trim() ? [text] : [];
      })
    : [];
}

function historyArguments(value: unknown): ToolSection[] | null {
  const terms = record(value)?.terms;
  return Array.isArray(terms)
    ? section(tr('Search query'), terms.filter((term) => typeof term === 'string').join(', '))
    : null;
}

function recalled(value: unknown, context: boolean): ToolSection[] | null {
  const result = record(value);
  if (!Array.isArray(result?.passages)) return null;
  const rows: ToolSection[] = [];
  if (!result.passages.length)
    rows.push({ label: tr('Search conversation history'), text: tr('No matching passages') });
  for (const item of result.passages) {
    const passage = record(item);
    if (!Array.isArray(passage?.messages)) continue;
    const messages = passage.messages.map(record);
    const matched = messages.find((message) => message?.is_anchor === true);
    const title =
      typeof passage.session_title === 'string' && passage.session_title.trim()
        ? passage.session_title
        : tr('Conversation passage');
    if (!context) {
      rows.push({ label: title, text: typeof matched?.text === 'string' ? matched.text : '' });
      continue;
    }
    for (const message of messages) {
      const label =
        message?.is_anchor === true
          ? title
          : message?.role === 'user'
            ? tr('Recall user message')
            : message?.role === 'assistant'
              ? tr('Agent message')
              : tr('Tool');
      rows.push(...section(label, message?.text));
    }
  }
  if (result.searched_every_session === false) {
    const reason = Array.isArray(result.gaps)
      ? result.gaps.filter((gap) => typeof gap === 'string').join('\n')
      : '';
    rows.push({
      label: tr('Search conversation history'),
      text: [tr('Some conversations could not be searched'), reason].filter(Boolean).join('\n'),
      tone: 'warning',
    });
  }
  return rows;
}

function goalState(state: unknown): string | null {
  switch (state) {
    case 'armed':
      return tr('Goal ready');
    case 'active':
      return tr('Goal active');
    case 'paused':
      return tr('Goal paused');
    case 'achieved':
      return tr('Goal achieved');
    case 'cancelled':
      return tr('Goal cancelled');
    case 'budget_limited':
      return tr('Goal budget reached');
    case 'blocked':
      return tr('Goal blocked');
    default:
      return null;
  }
}

const numberText = (value: number) => value.toLocaleString(currentLocale());

function goalResult(value: unknown): ToolSection[] | null {
  const result = record(value);
  if (result?.current === null)
    return [{ label: tr('Goal'), text: tr('No goal in this conversation') }];
  const goal = record(result?.current);
  if (!goal) return null;
  const consumed = record(goal.consumed);
  return [
    ...section(tr('Objective'), goal.objective),
    ...section(tr('Goal state'), goalState(goal.status)),
    ...section(tr('Goal checkpoint'), record(goal.report)?.note ?? goal.note),
    ...(typeof consumed?.known === 'number'
      ? [
          {
            label: tr('Known tokens'),
            text:
              (typeof consumed.missing === 'number' && consumed.missing > 0 ? '≥' : '') +
              numberText(consumed.known),
          },
        ]
      : []),
    ...(typeof goal.tokenBudget === 'number'
      ? [
          { label: tr('Goal token budget'), text: numberText(goal.tokenBudget) },
          {
            label: tr('Remaining tokens'),
            text:
              typeof goal.remainingTokens === 'number'
                ? numberText(goal.remainingTokens)
                : tr('Usage incomplete'),
          },
        ]
      : []),
  ];
}

function checklist(items: unknown): ToolSection[] | null {
  if (!Array.isArray(items)) return null;
  if (!items.length) return [{ label: tr('Read checklist'), text: tr('No checklist items') }];
  const groups: Record<'pending' | 'in_progress' | 'completed', string[]> = {
    pending: [],
    in_progress: [],
    completed: [],
  };
  for (const item of items) {
    const task = record(item);
    if (!task || typeof task.content !== 'string') return null;
    if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'completed')
      return null;
    groups[task.status].push(task.content);
  }
  const rows: ToolSection[] = [];
  for (const [label, group] of [
    [tr('Checklist items in progress'), groups.in_progress],
    [tr('Checklist items to do'), groups.pending],
    [tr('Completed'), groups.completed],
  ] as const) {
    if (group.length) rows.push({ label, text: group.map((text) => `• ${text}`).join('\n') });
  }
  return rows;
}

function scheduledTime(value: unknown, timezone?: string): string | null {
  if (typeof value !== 'number') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return date.toLocaleString(currentLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // A rejected tool call can still contain an invalid time zone.
    return null;
  }
}

function scheduleArguments(value: unknown): ToolSection[] | null {
  const request = record(record(value)?.request);
  switch (request?.mode) {
    case 'list':
    case 'pause':
    case 'resume':
    case 'delete':
      return [];
    case 'create': {
      const timezone = typeof request.timezone === 'string' ? request.timezone : undefined;
      const schedule = record(request.schedule);
      const time = scheduledTime(
        schedule?.runAt ?? schedule?.startAt ?? schedule?.anchorAt,
        timezone,
      );
      const recurrence =
        schedule?.recurrence === 'daily'
          ? tr('Daily schedule')
          : schedule?.recurrence === 'weekly'
            ? tr('Weekly schedule')
            : schedule?.recurrence === 'monthly'
              ? tr('Monthly schedule')
              : null;
      return [
        ...section(tr('Task instructions'), request.intentBody),
        ...section(tr('Scheduled start'), time),
        ...section(tr('Schedule time zone'), timezone),
        ...(typeof schedule?.everySeconds === 'number'
          ? [
              {
                label: tr('Schedule frequency'),
                text: tr('Runs every {interval}', {
                  interval: formatDuration(schedule.everySeconds * 1000),
                }),
              },
            ]
          : section(tr('Schedule frequency'), recurrence)),
        ...section(tr('Cron expression'), schedule?.expression),
        { label: tr('Manage scheduled tasks'), text: tr('Approval required to run') },
      ];
    }
    default:
      return null;
  }
}

function scheduledResult(value: unknown): ToolSection[] | null {
  const result = record(value);
  if (!result) return null;
  if (typeof result.taskId === 'string' && typeof result.approved === 'boolean')
    return [{ label: tr('Manage scheduled tasks'), text: tr('Schedule change saved') }];
  if (!Array.isArray(result.tasks)) return null;
  const tasks: ToolSection[] = [];
  for (const item of result.tasks) {
    const task = record(item);
    if (!task || typeof task.title !== 'string') return null;
    const status =
      task.status === 'completed'
        ? tr('Completed')
        : task.status === 'expired'
          ? tr('Schedule expired')
          : task.approved === false
            ? tr('Waiting for approval')
            : task.status === 'active'
              ? tr('Schedule active')
              : tr('Schedule paused');
    const next = scheduledTime(task.nextFireAt);
    const note = typeof task.lastError === 'string' ? task.lastError : null;
    tasks.push({
      label: task.title,
      text: [status, next && tr('Schedule next run {time}', { time: next }), note]
        .filter(Boolean)
        .join('\n'),
      ...(note ? { tone: 'warning' } : {}),
    });
  }
  if (typeof result.nextCursor === 'string')
    tasks.push({
      label: tr('List scheduled tasks'),
      text: tr('More scheduled tasks are available'),
    });
  return tasks.length
    ? tasks
    : [{ label: tr('List scheduled tasks'), text: tr('No scheduled tasks') }];
}

function scriptSource(value: unknown): ToolSection[] | null {
  const code = typeof value === 'string' ? value : record(value)?.code;
  return typeof code === 'string'
    ? [{ label: tr('Script source'), text: code, style: 'code' }]
    : null;
}

function scriptResult(value: unknown): ToolSection[] | null {
  const observation = record(record(value)?.observation);
  if (!observation) return null;
  const interrupted = record(observation.report);
  const result = record(observation.result);
  const error = record(result?.error)?.message;
  const state =
    observation.state === 'running'
      ? tr('Script still running at capture')
      : observation.state === 'interrupted'
        ? tr('Script interrupted')
        : observation.state === 'completed' && result?.ok === false
          ? tr('Script reported an error')
          : null;
  const diagnostic = typeof error === 'string' ? error : interrupted?.diagnostic;
  const priorOutput = record(interrupted?.priorOutput)?.content;
  const emitted = textItems(observation.content ?? priorOutput, 'text').join('\n');
  const output = emitted || (typeof result?.value === 'string' ? result.value : '');
  const rows: ToolSection[] = [];
  if (state) {
    rows.push({
      label: tr('Script source'),
      text: [state, diagnostic].filter((part) => typeof part === 'string' && part).join('\n'),
      ...(observation.state === 'running' ? {} : { tone: 'warning' }),
    });
  }
  if (output) rows.push({ label: tr('Output'), text: output, style: 'code' });
  if (!rows.length && observation.state === 'completed')
    rows.push({ label: tr('Output'), text: tr('Script finished without text output') });
  return rows.length ? rows : null;
}

function botResult(value: unknown): ToolSection[] | null {
  const result = record(value);
  if (typeof result?.count !== 'number') return null;
  return [
    {
      label: tr('Send a message to the user'),
      text:
        result.duplicate === true
          ? tr('Message already sent')
          : result.count === 1
            ? tr('Sent 1 message')
            : tr('Sent {count} messages', { count: numberText(result.count) }),
    },
  ];
}

export const nativeToolPresentations: Record<string, ActivityPresentation> = {
  'maka.agent.Builtin@1/Recall': {
    title: () => tr('Search conversation history'),
    icon: 'search',
    arguments: historyArguments,
    result: (value) => recalled(value, false),
  },
  'maka.agent.Builtin@1/RecallMore': {
    title: () => tr('Read surrounding messages'),
    icon: 'file',
    result: (value) => recalled(value, true),
  },
  'maka.agent.Builtin@1/RecallMaterial': {
    title: () => tr('Read historical attachment'),
    icon: 'paperclip',
    result: (value) => toolResult('read', { kind: 'completed', value }),
  },
  'maka.agent.Builtin@1/CreateGoal': {
    title: () => tr('Create goal'),
    icon: 'goal',
    arguments: (value, { returned }) => {
      if (returned) return [];
      const input = record(value);
      if (!input) return null;
      return [
        ...section(tr('Objective'), input.objective),
        ...section(
          tr('Goal token budget'),
          typeof input.token_budget === 'number' ? numberText(input.token_budget) : null,
        ),
      ];
    },
    result: goalResult,
  },
  'maka.agent.Builtin@1/GetGoal': {
    title: () => tr('Read goal'),
    icon: 'goal',
    result: goalResult,
  },
  'maka.agent.Builtin@1/GoalStatus': {
    title: () => tr('Update goal status'),
    icon: 'goal',
    arguments: (value, { returned }) =>
      returned ? [] : section(tr('Goal checkpoint'), record(value)?.note),
    result: goalResult,
  },
  'maka.agent.Builtin@1/todo_read': {
    title: () => tr('Read checklist'),
    icon: 'clipboard',
    result: (value) => checklist(record(value)?.items),
  },
  'maka.agent.Builtin@1/todo_write': {
    title: () => tr('Update checklist'),
    icon: 'clipboard',
    arguments: (value, { returned }) => (returned ? [] : checklist(record(value)?.todos)),
    result: (value) => checklist(record(value)?.items),
  },
  'maka.agent.Builtin@1/ScheduledTask': {
    title: () => tr('Manage scheduled tasks'),
    icon: 'activity',
    arguments: scheduleArguments,
    result: scheduledResult,
  },
  'maka.agent.Builtin@1/SendUser': {
    title: () => tr('Send a message to the user'),
    icon: 'inbox',
    arguments: (value) =>
      section(
        tr('Send a message to the user'),
        textItems(record(value)?.messages, 'text').join('\n\n'),
      ),
    result: botResult,
  },
  'maka.agent.Builtin@1/sleep': {
    title: () => tr('Wait for a new event'),
    icon: 'activity',
    result: (value) =>
      record(value)?.sleeping === true
        ? [
            {
              label: tr('Wait for a new event'),
              text: tr('Waiting for a message or background result'),
            },
          ]
        : null,
  },
  'maka.agent.Builtin@1/exec': {
    title: () => tr('Run script'),
    icon: 'code',
    arguments: scriptSource,
    result: scriptResult,
  },
  'maka.agent.Builtin@1/wait': {
    title: () => tr('Wait for script'),
    icon: 'code',
    result: scriptResult,
  },
  'maka.agent.Builtin@1/tool_search': {
    title: () => tr('Find tools'),
    icon: 'search',
    arguments: (value) => section(tr('Search query'), record(value)?.query),
    result: (value) => {
      const activated = record(value)?.activated;
      if (!Array.isArray(activated)) return null;
      return [
        {
          label: tr('Find tools'),
          text:
            activated.length === 1
              ? tr('1 tool made available')
              : activated.length > 1
                ? tr('{count} tools made available', { count: numberText(activated.length) })
                : tr('No additional tools found'),
        },
      ];
    },
  },
};
