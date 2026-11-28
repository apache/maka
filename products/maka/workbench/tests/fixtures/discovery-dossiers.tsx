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
import { computed, keymap, mount, signal, Text, View } from 'nsh';
import { createBrowsing } from '../../app/browsing';
import { Workbench } from '../../app/Workbench';
import { WorkspaceBrowser } from '../../app/WorkspaceBrowser';
import { DiscoveryDossiers } from '../../app/DiscoveryDossiers';
import { DiscoveryPanel } from '../../app/DiscoveryPanel';
import { HostProvider, type Host } from '../../app/host';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import type { DossierDetail } from '../../app/discoveryDossiersCore';

mount(() => {
  installWorkbenchLocaleCatalog();
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
    unfollowed: false,
    lastCheckedAt: 1000,
    lastMaterialChangeAt: 1000,
    lastNotifiedRevision: 0,
    createdAt: 1000,
    updatedAt: 1000,
    watches: [],
    pendingActions: [],
    revisions: [],
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
    dossiers: files().map((d) => ({
      ...d,
      preview: d.summaryMd,
      artifactCount: d.artifacts.length,
    })),
    notificationsEnabled: enabled(),
  }));
  const route = signal<{ topicId: string | null; runId?: string | null } | null>(null);
  const opened = signal('planning');
  const expanded = signal(true);
  const browser = () => ({
    navigationDocked: expanded(),
    previewDocked: false,
    expanded: expanded(),
    hidden: false,
    toggle: () => expanded.set(!expanded()),
  });
  const openSession = (id: string) => {
    opened.set(id);
    route.set(null);
  };
  const workers = () => [
    {
      id: 'probe',
      title: 'Probe fixture',
      discoveryWorker: true,
      activity: 'working' as const,
      updatedAt: 1000,
      archived: false,
    },
  ];
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
      if (method === 'projects') return { kind: 'projects', projects: [], next: null, revision: 1 };
      if (method === 'readDossierArtifact' && input.topicId === 'one' && input.path === 'draft.md')
        return 'Ready to review\n+ revised clause\n' + 'line\n'.repeat(1100) + 'End of draft';
      if (method === 'dossier') return files().find((d) => d.topicId === input.topicId) ?? null;
      if (method === 'history' && (input.sessionId === 'thread-two' || input.sessionId === 'probe'))
        return {
          kind: 'ready',
          through: messages.length,
          chunks:
            input.sessionId === 'probe'
              ? [
                  {
                    position: { kind: 'live', sequence: 1, fact: 'tool', itemIndex: 0 },
                    order: { path: [1], itemIndex: 0 },
                    role: 'tool_call',
                    field: 'arguments',
                    offset: 0,
                    totalBytes: 0,
                    text: '',
                    tool: {
                      toolUseId: 'probe-tool-1',
                      call: {
                        name: 'Shell',
                        title: 'Run read-only probe',
                        presentation: 'execute',
                        pending: false,
                        dispatched: true,
                        origin: 'code_mode',
                        ancestorToolUseIds: [],
                        position: { kind: 'live', sequence: 1, fact: 'tool', itemIndex: 0 },
                      },
                      result: {
                        settlement: 'returned',
                        isError: false,
                        image: false,
                        images: 0,
                        position: { kind: 'live', sequence: 2, fact: 'tool', itemIndex: 0 },
                      },
                    },
                  },
                  {
                    position: { kind: 'live', sequence: 3, fact: 'message', itemIndex: 0 },
                    order: { path: [3], itemIndex: 0 },
                    messageId: 'probe-msg-1',
                    role: 'assistant',
                    field: 'body',
                    offset: 0,
                    totalBytes: 24,
                    text: 'Read-only probe evidence',
                  },
                ]
              : messages.map(({ text, role }, i) => ({
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
      if (method === 'catalog') {
        const catalog = new ReadableStream({
          start(controller) {
            controller.enqueue({
              sessions: [
                {
                  id: 'planning',
                  title: 'Planning',
                  kind: 'agent',
                  workspace: { path: '/work' },
                  labels: [],
                  activity: 'idle',
                },
              ],
              after: null,
              needsYouCount: 0,
              revision: '1',
            });
          },
        }).getReader();
        return {
          next: async () => (await catalog.read()).value ?? null,
          close: () => catalog.cancel(),
        };
      }
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
        case 'setDossierResolved':
          update(input.topicId, { signal: input.resolved ? 'done' : 'yellow' });
          return null;
        case 'setDossierUnfollowed':
          update(input.topicId, {
            unfollowed: input.unfollowed,
            muted: input.unfollowed,
            signal: input.unfollowed ? 'done' : 'yellow',
          });
          return null;
        case 'chooseDossierOption': {
          const target = files().find((d) => d.topicId === input.topicId);
          if (target) {
            const revs =
              target.revisions && target.revisions.length > 0
                ? target.revisions.map((r) =>
                    r.revision === input.revision ? { ...r, chosenKey: input.key } : r,
                  )
                : [
                    {
                      revision: target.revision,
                      at: target.lastMaterialChangeAt,
                      title: target.title,
                      signal: target.signal,
                      summaryMd: target.summaryMd,
                      artifacts: target.artifacts,
                      choices: [],
                      chosenKey: input.key,
                    },
                  ];
            update(input.topicId, {
              revisions: revs,
              ...(input.resolve ? { signal: 'done' as const } : {}),
            });
          }
          return null;
        }
        case 'dismissPendingAction':
          if (input.actionId !== 'review') throw Error('Wrong pending action');
          update('one', { pendingActions: [] });
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
  const browsing = createBrowsing(host);
  keymap.bind('mod+shift+r', () => route.set({ topicId: null, runId: 'probe' }), {
    when: 'always',
  });
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
      <Workbench
        expanded={expanded}
        previewShown={() => false}
        previewDialog={() => false}
        closePreview={() => {}}
        preview={() => null}
        navigation={() => (
          <WorkspaceBrowser
            browsing={browsing}
            botWorkers={workers}
            selected={opened}
            docked={expanded}
            switching={() => false}
            connectionLost={() => false}
            openDiscovery={() => route.set({ topicId: null })}
            discoveryOpen={() => route() !== null}
            selectSession={async (id) => {
              await openSession(id);
              return true;
            }}
            openBot={() => openSession('bot')}
            close={() => expanded.set(false)}
            collapse={() => expanded.set(false)}
            focusRequest={() => false}
            focusHandled={() => {}}
            attach={() => {}}
            newConversation={() => {}}
            search={() => {}}
            settings={() => {}}
            create={async () => {}}
            changeSession={async () => {}}
          />
        )}
      >
        <If
          when={route()}
          else={
            <View>
              <DiscoveryPanel open={() => route.set({ topicId: null })} />
              <Text>{opened()}</Text>
            </View>
          }
        >
          <DiscoveryDossiers
            route={route}
            browser={browser()}
            commands={() => {}}
            workers={workers}
            snapshot={snapshot}
            watchError={() => ''}
            botSession={() => 'bot'}
            openBot={async () => 'bot'}
            control={async () => null}
            chooseModel={() => {}}
            openLink={async () => {}}
            openSession={openSession}
            close={() => route.set(null)}
          />
        </If>
      </Workbench>
    </HostProvider>
  );
});
