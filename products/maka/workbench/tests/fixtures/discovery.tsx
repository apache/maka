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
import { BotReply } from '../../app/BotReply';
import type { Host } from '../../app/host';

mount(() => {
  let detail: any = null,
    revision = 0;
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
  const page = () => ({
    kind: 'page',
    revision,
    tasks: detail ? [{ ...detail.task, revision: detail.revision, approved: detail.approved }] : [],
    nextCursor: null,
  });
  const host = {
    async query(_endpoint: string, method: string, input: any) {
      if (method === 'observe') return { session };
      if (method === 'resolveModel')
        return {
          kind: 'ready',
          choice: { label: 'DeepSeek', connectionName: 'sample-command-code' },
        };
      if (input.kind === 'get') return { kind: 'task', detail: JSON.parse(JSON.stringify(detail)) };
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
    if (input.kind === 'create') {
      revision++;
      detail = {
        revision,
        approved: true,
        pendingFire: null,
        task: {
          ...input.input.task,
          id: 'discovery',
          intent: { kind: 'text', body: input.input.task.intentBody },
          status: 'active',
          runs: [],
          nextFireAt: input.input.task.schedule.startAt,
        },
      };
    } else {
      if (input.revision !== detail.revision) return { kind: 'conflict' };
      revision++;
      detail = { ...detail, revision };
      if (input.kind === 'update')
        detail.task = {
          ...detail.task,
          ...input.input.task,
          intent: { kind: 'text', body: input.input.task.intentBody },
        };
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
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <DiscoveryPanel
        host={host}
        sessionId="bot"
        control={control}
        selection={async () => ({ model, thinkingLevel: null })}
        openWorker={opened.set}
        chooseModel={() => opened.set('models')}
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
      <Text>{`Opened ${opened()}`}</Text>
      <Text>{`Action ${calls()}`}</Text>
    </View>
  );
});
