/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { computed, keymap, mount, signal, Text } from 'nsh';
import { DiscoveryDossiers } from '../../app/DiscoveryDossiers';
import { DiscoveryPanel } from '../../app/DiscoveryPanel';
import { HostProvider, type Host } from '../../app/host';
import type { DossierDetail } from '../../app/discoveryDossiersCore';

mount(() => {
  const dossier = (topicId: string, title: string): DossierDetail => ({
    topicId,
    title,
    signal: 'yellow',
    priorityWeight: 1,
    revision: 1,
    summaryMd: title + ' summary',
    artifacts: [],
    linkedTaskIds: [],
    muted: false,
    lastCheckedAt: 1000,
    lastMaterialChangeAt: 1000,
    lastNotifiedRevision: 0,
    createdAt: 1000,
    updatedAt: 1000,
    watches: [],
    pendingActions: [],
  });
  const first = dossier('one', 'Contract');
  first.artifacts = [{ path: 'draft.md', purpose: 'Review copy' }];
  first.linkedTaskIds = ['follow-up'];
  first.watches = [
    {
      watchId: 'signing',
      topicId: 'one',
      kind: 'deadline',
      target: 'Signing window',
      predicate: {},
      onTrigger: 'notify_direct',
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  first.pendingActions = [
    {
      actionId: 'review',
      topicId: 'one',
      connectorTool: 'ReviewExport',
      params: {},
      inputHashes: {},
      idempotencyKey: 'review-1',
      status: 'stale',
      expiresAt: 5000,
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  const files = signal([first, dossier('two', 'Release')]);
  const enabled = signal(true);
  const snapshot = computed(() => ({
    dossiers: files().map((d) => ({ ...d, artifactCount: d.artifacts.length })),
    notificationsEnabled: enabled(),
  }));
  const route = signal<{ topicId: string | null } | null>(null);
  const opened = signal('');
  const messages: { text: string; role: 'user' | 'assistant' }[] = [];
  let threadOpens = 0;
  let wake: (() => void) | undefined;
  const update = (topicId: string, edit: Partial<DossierDetail>) =>
    files.set(files().map((d) => (d.topicId === topicId ? { ...d, ...edit } : d)));
  const host = {
    async query(
      _: string,
      method: string,
      input: { topicId?: string; sessionId?: string; path?: string },
    ) {
      if (method === 'readDossierArtifact' && input.topicId === 'one' && input.path === 'draft.md')
        return 'Ready to review\n+ revised clause\n' + 'line\n'.repeat(1100) + 'End of draft';
      if (method === 'dossier') return files().find((d) => d.topicId === input.topicId) ?? null;
      if (method === 'history' && input.sessionId === 'thread-two')
        return {
          kind: 'ready',
          through: messages.length,
          chunks: messages.map(({ text, role }, i) => ({
            position: { kind: 'live', sequence: i + 1, fact: 'message', itemIndex: 0 },
            order: { path: [i + 1], itemIndex: 0 },
            messageId: String(i + 1),
            role,
            field: 'body',
            offset: 0,
            totalBytes: text.length,
            text,
          })),
        };
      throw Error(method);
    },
    async subscribe(
      _: string,
      method: string,
      { sessionId, after }: { sessionId: string; after: number },
    ) {
      if (method !== 'watch' || sessionId !== 'thread-two') throw Error(method);
      return {
        next: () =>
          new Promise((resolve) => {
            wake = () => {
              after = messages.length;
              resolve({
                kind: 'events',
                events: [{ sequence: messages.length, fact: { kind: 'ended' } }],
              });
            };
            if (messages.length > after) wake();
          }),
        close: async () => {
          wake?.();
          wake = undefined;
        },
      };
    },
    async mutateAgent(method: string, input: any) {
      switch (method) {
        case 'setDiscoveryNotifications':
          enabled.set(input.enabled);
          return null;
        case 'setDossierMuted':
          update(input.topicId, { muted: input.muted });
          return null;
        case 'openDossierThread':
          if (input.topicId !== 'two' || ++threadOpens !== 1)
            throw Error('Unexpected thread creation');
          update('two', { threadSessionId: 'thread-two' });
          return { sessionId: 'thread-two' };
        case 'send':
          if (input.sessionId !== 'thread-two') throw Error('Wrong session');
          messages.push({ text: input.message, role: 'user' });
          wake?.();
          return {
            kind: 'started',
            sessionId: input.sessionId,
            messageId: String(messages.length),
            runId: 'run',
          };
        case 'dropDiscoveryLead':
          files.set([dossier('lead', input.text), ...files()]);
          return { topicId: 'lead' };
        default:
          throw Error(method);
      }
    },
  } as unknown as Host;
  keymap.bind('mod+d', () => route.set({ topicId: 'two' }), { when: 'always' });
  keymap.bind(
    'mod+r',
    () => {
      messages.push({ role: 'assistant', text: 'Reviewed' });
      wake?.();
    },
    { when: 'always' },
  );
  keymap.bind(
    'mod+u',
    () => {
      files.set(
        files()
          .map((d) => ({ ...d, summaryMd: 'Revised ' + d.title }))
          .reverse(),
      );
    },
    { when: 'always' },
  );
  return (
    <HostProvider value={host}>
      <DiscoveryPanel open={() => route.set({ topicId: null })} />
      <Text>{opened()}</Text>
      <If when={route()}>
        <DiscoveryDossiers
          route={route}
          snapshot={snapshot}
          watchError={() => ''}
          botSession={() => 'bot'}
          openBot={async () => 'bot'}
          control={async () => null}
          chooseModel={() => {}}
          openLink={async () => {}}
          openSession={(id) => {
            opened.set(id);
            route.set(null);
          }}
          close={() => route.set(null)}
        />
      </If>
    </HostProvider>
  );
});
