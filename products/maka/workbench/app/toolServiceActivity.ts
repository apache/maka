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
import type { ActivityPresentation } from './toolActivityPresentation';

function section(label: MessageKey, value: unknown, style?: ToolSection['style']): ToolSection[] {
  return typeof value === 'string' && value.trim()
    ? [{ label: tr(label), text: value, style }]
    : [];
}

const processStates = {
  starting: 'Preparing at capture',
  running: 'Running at capture',
  completed: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Stopped',
  orphaned: 'Outcome unknown',
} as const;

function healthResult(value: unknown): ToolSection[] | null {
  const result = record(value);
  const process = record(result?.process);
  const endpoint = record(result?.endpoint);
  if (
    !process ||
    !endpoint ||
    typeof process.status !== 'string' ||
    !Object.hasOwn(processStates, process.status)
  )
    return null;
  const status = process.status as keyof typeof processStates;
  const exit = typeof process.exitCode === 'number' ? process.exitCode : null;
  const failed = status === 'failed' || status === 'timed_out' || (exit !== null && exit !== 0);
  const sections: ToolSection[] = [
    {
      label: tr('Background process'),
      text: [tr(processStates[status]), exit === null ? '' : tr('Exit {code}', { code: exit })]
        .filter(Boolean)
        .join(' · '),
      tone: failed ? 'error' : status === 'orphaned' ? 'warning' : undefined,
    },
  ];
  sections.push(...section('Error', process.failureMessage));
  const url = typeof endpoint.target === 'string' ? endpoint.target : '';
  if (endpoint.state === 'checked') {
    const status =
      endpoint.health === 'healthy'
        ? tr('Endpoint reachable')
        : endpoint.health === 'unhealthy'
          ? tr('Endpoint unhealthy')
          : tr('Endpoint health unknown');
    const code = typeof endpoint.httpStatus === 'number' ? `HTTP ${endpoint.httpStatus}` : '';
    sections.push({
      label: tr('Endpoint'),
      text: [status, code, url].filter(Boolean).join(' · '),
      tone: endpoint.health === 'healthy' ? undefined : 'warning',
    });
  } else if (endpoint.state === 'unknown') {
    sections.push({
      label: tr('Endpoint'),
      text: [tr('Endpoint health unknown'), url, endpoint.error]
        .filter((item) => typeof item === 'string' && item)
        .join('\n'),
      tone: 'warning',
    });
  }
  const logs = record(process.logs);
  sections.push(...section('Process output', logs?.stdout ?? logs?.scrollback, 'code'));
  sections.push(...section('Process errors', logs?.stderr, 'code'));
  return sections;
}

function skillMatches(value: unknown): ToolSection[] | null {
  const result = record(value);
  if (!Array.isArray(result?.matches)) return null;
  const matches = result.matches.flatMap((item: unknown) => {
    const skill = record(item);
    if (typeof skill?.name !== 'string') return [];
    return [
      typeof skill.description === 'string' && skill.description
        ? `${skill.name}
${skill.description}`
        : skill.name,
    ];
  });
  if (matches.length === 0) return [{ label: tr('Skills'), text: tr('No matching skills') }];
  return [
    { label: tr('Matching skills'), text: matches.join('\n\n') },
    ...(result.truncated === true && typeof result.matchedCount === 'number'
      ? [
          {
            label: tr('Results'),
            text: tr('{shown} of {total} matching skills', {
              shown: matches.length,
              total: result.matchedCount,
            }),
          },
        ]
      : []),
  ];
}

function skillResult(value: unknown) {
  const result = record(value);
  if (result?.kind === 'loaded') {
    const metadata = record(result.metadata);
    return [
      ...section('Skill', metadata?.name),
      ...section('Instructions', result.instructions),
      ...(result.next
        ? [{ label: tr('Instructions'), text: tr('More instructions are available.') }]
        : []),
    ];
  }
  if (result?.kind === 'resource') {
    return [
      ...section('File', result.path, 'code'),
      ...section('Resource contents', result.content, 'code'),
      ...(result.next
        ? [{ label: tr('Resource contents'), text: tr('More lines are available.') }]
        : []),
    ];
  }
  if (result?.kind === 'changed')
    return [
      { label: tr('Skills'), text: tr('The skill catalog changed.'), tone: 'warning' as const },
    ];
  if (result?.kind === 'unavailable' || result?.kind === 'resource_unavailable')
    return [
      { label: tr('Skill'), text: tr('Skill content unavailable'), tone: 'warning' as const },
    ];
  return null;
}

const questionClosures = {
  steered: 'A new message closed the question.',
  run_stopped: 'The response was stopped.',
  run_terminal: 'The response ended.',
  producer_cancelled: 'The question was cancelled.',
  timed_out: 'The question timed out.',
  host_restarted: 'The Host restarted.',
  provider_disconnected: 'The provider disconnected.',
} as const;

function questionResult(value: unknown): ToolSection[] | null {
  const result = record(value);
  if (result?.kind === 'answered' && Array.isArray(result.answers)) {
    return result.answers.flatMap((item: unknown) => {
      const answer = record(item);
      if (typeof answer?.question !== 'string') return [];
      return [
        {
          label: answer.question,
          text: typeof answer.answer === 'string' ? answer.answer : tr('Skipped'),
        },
      ];
    });
  }
  if (result?.kind === 'closed') {
    const reason = result.reason;
    return [
      {
        label: tr('Question closed'),
        text: tr(
          typeof reason === 'string' && Object.hasOwn(questionClosures, reason)
            ? questionClosures[reason as keyof typeof questionClosures]
            : 'The question was closed.',
        ),
        tone: 'warning',
      },
    ];
  }
  return result?.kind === 'rejected'
    ? [
        {
          label: tr('Question rejected'),
          text: tr(result.reason === 'invalid_input' ? 'Invalid question' : 'Question unavailable'),
          tone: 'error',
        },
      ]
    : null;
}

function computerOutput(value: unknown, reset: boolean): ToolSection[] | null {
  if (Array.isArray(value)) {
    const text = value.flatMap((part: unknown) => {
      const item = record(part);
      return item?.kind === 'text' && typeof item.text === 'string' ? [item.text] : [];
    });
    const state = /^(?:REPL state|REPL 状态|REPL 狀態): "(fresh|ready|reset_required)"$/.exec(
      text.at(-1) ?? '',
    )?.[1];
    if (state) text.pop();
    return [
      ...section('Computer output', text.join('\n\n')),
      ...(state === 'reset_required'
        ? [
            {
              label: tr('Status'),
              text: tr('Computer controls need to be reset.'),
              tone: 'warning' as const,
            },
          ]
        : reset && state === 'fresh'
          ? [
              {
                label: tr('Status'),
                text: tr('Computer controls reset.'),
              },
            ]
          : []),
    ];
  }
  const result = record(value);
  if (result?.kind === 'completed') return [];
  return section('Computer output', value);
}

export const serviceToolPresentations: Record<string, ActivityPresentation> = {
  'maka.workspace.Files@1/readImage': {
    title: () => tr('Read image'),
    icon: 'image',
    arguments: (value) => section('File', record(value)?.path, 'code'),
  },
  'maka.workspace.Processes@1/health': {
    title: () => tr('Check background process'),
    icon: 'terminal',
    arguments: (value) => section('Requested URL', record(value)?.url),
    result: healthResult,
  },
  'maka.skills.Library@1/search': {
    title: () => tr('Search skills'),
    icon: 'search',
    arguments: (value) => section('Search query', record(value)?.query),
    result: skillMatches,
  },
  'maka.skills.Library@1/load': {
    title: () => tr('Read skill'),
    icon: 'file',
    arguments: (value, { returned }) => {
      if (returned) return [];
      const input = record(value);
      return [
        ...section('Skill', input?.name),
        ...section('File', record(input?.resource)?.path, 'code'),
      ];
    },
    result: skillResult,
  },
  'maka.interactions.Questions@1/ask': {
    title: () => tr('Ask you a question'),
    icon: 'inbox',
    arguments: (value, { returned }) => {
      if (returned) return [];
      const questions = record(value)?.questions;
      if (!Array.isArray(questions)) return null;
      return questions.flatMap((item: unknown) => {
        const question = record(item);
        return section('Question', question?.question);
      });
    },
    result: questionResult,
  },
  'maka.workspace.Computer@1/evaluate': {
    title: () => tr('Use computer'),
    icon: 'app',
    arguments: (value) => section('Script source', record(value)?.code, 'code'),
    result: (value) => computerOutput(value, false),
  },
  'maka.workspace.Computer@1/reset': {
    title: () => tr('Reset computer session'),
    icon: 'app',
    result: (value) => computerOutput(value, true),
  },
};
