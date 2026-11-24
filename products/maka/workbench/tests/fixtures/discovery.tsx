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

import { keymap, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { DiscoveryPanel } from '../../app/DiscoveryPanel';
import { MessageRow } from '../../app/MessageRow';
import { BotReply } from '../../app/BotReply';
import { HostProvider, type Host } from '../../app/host';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

const systemTimezone = '+08:00';
Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
  construct(formatter, [locale, options]) {
    return new formatter(locale, { timeZone: systemTimezone, ...options });
  },
});

mount(() => {
  installWorkbenchLocaleCatalog();
  let detail: any = null,
    revision = 0;
  let failDetailOnce = false;
  let disabledModel = false;
  const opened = signal('none');
  const calls = signal('none');
  let publish = () => {};
  const session = {
    id: 'bot',
    workspace: { path: '/isolated/sample', trusted: true },
    permissions: { access: 'read_only', requestPermissions: false },
    boundaryRevision: 1,
    binding: { revision: 1 },
  };
  const model = { connectionId: 'sample-command-code', modelId: 'deepseek' };

  const replacement = { connectionId: 'replacement', modelId: 'available' };
  const page = () => ({
    kind: 'page',
    revision,
    tasks: detail ? [{ ...detail.task, revision: detail.revision, approved: detail.approved }] : [],
    nextCursor: null,
  });
  const catalog = (profile: string) => {
    const groups: Record<string, string> = { Read: 'read_files', DiscoveryMemory: 'history' };
    if (disabledModel) groups.NewReader = 'read_files';
    if (profile === 'session')
      Object.assign(groups, {
        Shell: 'commands',
        Write: 'modify_files',
        WebFetch: 'web',
        mcp__sample__lookup: 'other',
        PluginConfigure: 'plugin_management',
      });
    return { groups, names: ['DiscoveryComplete', ...Object.keys(groups)].sort() };
  };
  const host = {
    async query(_endpoint: string, method: string, input: any) {
      if (method === 'observe') return { session };
      const choice = (selection: typeof model) => ({
        selection,
        label: selection === model ? 'DeepSeek' : 'Replacement model',
        connectionName: selection.connectionId,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      });
      if (method === 'models')
        return {
          kind: 'ready',
          revision: 1,
          choices: (disabledModel ? [replacement] : [model, replacement]).map(choice),
          defaultModel: { kind: 'none' },
          next: null,
        };
      if (method === 'resolveModel') {
        const available = (disabledModel ? [replacement] : [model, replacement]).find(
          (item) => item.connectionId === input.connectionId && item.modelId === input.modelId,
        );
        return available ? { kind: 'ready', choice: choice(available) } : { kind: 'unavailable' };
      }
      if (input.kind === 'preview_discovery')
        return {
          kind: 'discovery_tools',
          ...catalog(input.effect.workerTools),
          approvedNames:
            input.taskId &&
            detail?.approved &&
            input.effect.workerTools === detail.task.effect.workerTools
              ? detail.approvedTools
              : null,
        };
      if (input.kind === 'get') {
        if (failDetailOnce) {
          failDetailOnce = false;
          throw new Error('Fixture detail request failed');
        }
        return { kind: 'task', detail: JSON.parse(JSON.stringify(detail)) };
      }
      return page();
    },
    async subscribe() {
      let first = true,
        closed = false;
      let pending: ((value: any) => void) | null = null;
      publish = () => {
        const notify = pending;
        pending = null;
        notify?.(page());
      };
      return {
        async next() {
          if (closed) return null;
          if (first) {
            first = false;
            return page();
          }
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        async close() {
          closed = true;
          pending?.(null);
          pending = null;
        },
      };
    },
  } as unknown as Host;
  const control = async (_method: string, input: any) => {
    calls.set(input.kind);
    if (input.kind === 'create' || input.kind === 'approve') {
      const effect = input.input.task.effect;
      const names = catalog(effect.workerTools).names.filter(
        (name) =>
          name === 'DiscoveryComplete' ||
          !effect.selectedTools ||
          Object.hasOwn(effect.selectedTools, name),
      );
      if (JSON.stringify(input.input.approvedTools) !== JSON.stringify(names))
        return { kind: 'rejected', reason: 'Expected the displayed tool list' };
      if (input.input.task.effect.target.boundaryRevision !== session.boundaryRevision)
        return { kind: 'rejected', reason: 'scheduler_authorization_changed' };
    }
    if (input.kind === 'create') {
      if (input.input.timezone !== systemTimezone)
        return { kind: 'rejected', reason: 'Expected the system time zone' };
      if (
        input.input.task.schedule.cadence !== 'after_completion' ||
        input.input.task.schedule.everySeconds !== 1800
      )
        return { kind: 'rejected', reason: 'Expected 30 minutes after completion' };
      revision++;
      detail = {
        revision,
        approved: true,
        approvedTools: input.input.approvedTools,
        pendingFire: null,
        timezone: input.input.timezone,
        task: {
          ...input.input.task,
          id: 'discovery',
          intent: { kind: 'text', body: input.input.task.intentBody },
          status: 'active',
          runs: [{ at: Date.UTC(2026, 10, 16, 7, 49, 27), outcome: 'ok', message: 'No report' }],
          nextFireAt: Date.UTC(2026, 10, 16, 7, 59, 58),
        },
      };
    } else {
      if (
        input.kind === 'resume' &&
        disabledModel &&
        detail.task.effect.model.connectionId === model.connectionId
      )
        return { kind: 'rejected', reason: 'agent_model_unavailable' };
      if (input.revision !== detail.revision) return { kind: 'conflict' };
      revision++;
      detail = { ...detail, revision };
      if (input.kind === 'delete') {
        detail = null;
        publish();
        return { kind: 'committed', taskId: 'discovery' };
      }
      if (input.kind === 'approve') {
        detail.task = {
          ...detail.task,
          ...input.input.task,
          intent: { kind: 'text', body: input.input.task.intentBody },
          status: 'active',
          lastError: null,
        };
        detail.approved = true;
        detail.approvedTools = input.input.approvedTools;
        calls.set(
          'approved ' +
            detail.task.effect.model.connectionId +
            ' ' +
            detail.approvedTools.join(' · '),
        );
      }
      if (input.kind === 'update') {
        detail.approvedTools = input.input.approvedTools;
        detail.task = {
          ...detail.task,
          ...input.input.task,
          intent: { kind: 'text', body: input.input.task.intentBody },
        };
        calls.set(
          [
            'update',
            detail.task.schedule.cadence,
            detail.task.schedule.everySeconds,
            detail.task.effect.model.connectionId,
            detail.task.intent.body,
            detail.approvedTools.join(' · '),
          ].join(' '),
        );
      }
      if (input.kind === 'pause') detail.task.status = 'paused';
      if (input.kind === 'resume') detail.task.status = 'active';
      if (input.kind === 'trigger_now') {
        detail.pendingFire = 'fire';
        detail.investigation = {
          sessionId: 'original-worker',
          turnId: 'worker-turn',
          phase: 'investigating',
        };
      }
    }
    publish();
    return { kind: 'committed', taskId: 'discovery' };
  };
  keymap.bind(
    'mod+shift+m',
    () => {
      disabledModel = !disabledModel;
    },
    { when: 'always' },
  );
  keymap.bind(
    'mod+shift+b',
    () => {
      detail.task.backgroundFollowup = true;
      // A preset-only follow-up still has a pinned list of approved names.
      delete detail.task.effect.selectedTools;
      detail.revision = ++revision;
      publish();
    },
    { when: 'always' },
  );
  // A concurrent client changes the plan while this dialog is editing it.
  keymap.bind(
    'mod+u',
    () => {
      revision++;
      detail = { ...detail, revision, task: { ...detail.task, title: 'Changed elsewhere' } };
      publish();
    },
    { when: 'always' },
  );
  keymap.bind(
    'mod+shift+f',
    () => {
      failDetailOnce = true;
      publish();
    },
    { when: 'always' },
  );
  keymap.bind(
    'mod+shift+e',
    () => {
      revision++;
      detail = {
        ...detail,
        revision,
        pendingFire: null,
        investigation: null,
        task: { ...detail.task, status: 'completed' },
      };
      publish();
    },
    { when: 'always' },
  );
  keymap.bind(
    'mod+shift+r',
    () => {
      revision++;
      session.boundaryRevision++;
      detail = {
        ...detail,
        revision,
        approved: false,
        task: { ...detail.task, status: 'paused', lastError: 'scheduler_authorization_changed' },
      };
      publish();
    },
    { when: 'always' },
  );
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <DiscoveryPanel
        host={host}
        sessionId="bot"
        control={control}
        selection={async () => (disabledModel ? null : { model, thinkingLevel: null })}
        openWorker={opened.set}
        chooseModel={() => {
          opened.set('models');
        }}
      />
      <BotReply
        messages={() => [
          {
            sequence: 7,
            messageId: 'report',
            index: 0,
            at: 1000,
            turnId: 'original-bot-turn',
            text: 'A useful finding from the original investigation.',
            discovery: {
              recordId: 'record',
              workerSessionId: 'original-worker',
              workerTurnId: 'worker-turn',
            },
          },
        ]}
        userScroll={() => {}}
        openLink={async () => {}}
        openInvestigation={opened.set}
      />
      <HostProvider value={host}>
        <MessageRow
          item={() => ({
            key: 'quoted-user',
            messageId: 'quoted-user',
            field: 'body',
            role: 'user',
            text: '',
            quotes: [
              {
                text: 'Please stop this recommendation.',
                label: 'Earlier discovery',
                truncated: false,
              },
            ],
            attachments: [],
            hasReferences: true,
          })}
          sessionId="bot"
          through={() => 10}
          previewImage={() => {}}
          openLink={async () => {}}
          userScroll={() => {}}
          toolMaxHeight={() => 500}
        />
      </HostProvider>
      <Text>{`Opened ${opened()}`}</Text>
      <Text>{`Action ${calls()}`}</Text>
    </View>
  );
});
