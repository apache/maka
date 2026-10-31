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

import { mount, platform, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { Composer } from '../../../../../plugins/agent/composer/ui/Composer';
import type { ComposerSession } from '../../../../../packages/plugin-sdk/src/composer-view.js';
import { host as nativeHost } from 'maka/host';
import { SessionPermissionsSelect } from '../../../workbench/app/SessionPermissionsSelect';
import { InteractionComposer } from '../../../workbench/app/InteractionComposer';
import { CompactionDivider } from '../../../workbench/app/CompactionDivider';
import { WorkspaceBrowser } from '../../../workbench/app/WorkspaceBrowser';
import type { Browsing, BrowserSession } from '../../../workbench/app/browsing';
import { HostProvider, type Host } from '../../../workbench/app/host';
import type {
  AgentSession,
  AgentQueue,
  AgentComputerApps,
  AgentPlanView,
  CollaborationMode,
  InteractionRecord,
  PlanArtifact,
} from '../../../../../packages/plugin-sdk/src/index.js';

function Sandbox() {
  const session = signal({
    id: 'original-session',
    revision: 7,
    permissions: {
      access: 'read_only',
      requestPermissions: true,
    },
  } as AgentSession);
  const saved = signal('No permission change');
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Text>{saved()}</Text>
      <SessionPermissionsSelect
        owner={{
          sessionId: 'original-session',
          snapshot: session,
          pending: () => false,
          error: () => '',
          async select({ session: original, settings }) {
            saved.set(
              `${original.id}:${original.revision}:${settings.access}:${settings.requestPermissions}`,
            );
            session.set({ ...original, permissions: settings });
          },
        }}
      />
    </View>
  );
}

function Consent() {
  const sent = signal('No answer');
  const record: InteractionRecord = {
    turnId: 'original-turn',
    runId: 'original-run',
    createdAt: 1,
    sessionId: 'original-session',
    requestId: 'original-consent',
    outcome: null,
    request: {
      kind: 'client_capability',
      toolUseId: 'original-tool',
      target: {
        providerId: 'maka_workspace_computer',
        contractId: 'maka_workspace_computer_v1',
        serverId: 'maka_workspace_computer',
        toolName: 'cua_repl',
        capability: 'computer_use',
        scope: { kind: 'capability' },
      },
      basis: {
        boundaryRevision: 3,
        binding: {
          id: 'a7cb195a-de75-49b5-8691-905392cd5d9c',
          permissionEpoch: 2,
        },
      },
    },
  };
  const host = {
    query: async (_endpoint, method) =>
      method === 'interaction'
        ? record
        : {
            entries: [{ requestId: record.requestId }],
          },
    pendingControls: async () => [],
  } as Host;
  return (
    <HostProvider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{sent()}</Text>
        <InteractionComposer
          sessionId={record.sessionId}
          requestId={record.requestId}
          confirming={() => false}
          focusComposer={() => {}}
          control={async (_method, input) => {
            if (input.answer.kind !== 'client_capability') throw new Error('Unexpected answer');
            sent.set(`${input.sessionId}:${input.requestId}:${input.answer.decision}`);
            return {
              kind: 'recorded',
              record: {
                ...record,
                outcome: {
                  kind: 'client_capability_decision',
                  decision: input.answer.decision,
                  committedAt: 2,
                },
              },
            };
          }}
        />
      </View>
    </HostProvider>
  );
}

function CompletionComposer(props: { details?: boolean; plan?: boolean }) {
  const draft = signal('');
  const action = signal('No command');
  const lookup = signal('No lookup');
  const queue = signal<AgentQueue>({
    revision: 1,
    entries: props.details
      ? [{ messageId: 'queued-original', kind: 'followup', preview: 'QUEUED_ORIGINAL' }]
      : [],
  });
  const makeApp = (id: string) => ({
    stopped: false,
    activity: {
      invocation: {
        session_id: 'original-session',
        turn_id: 'original-turn',
        run_id: 'original-run',
        invocation_id: 'original-invocation',
      },
      operationId: id,
      target: {
        providerId: 'computer',
        contractId: 'computer',
        serverId: 'computer',
        toolName: 'cua_repl',
        capability: 'computer_use' as const,
        scope: { kind: 'computer_app' as const, applicationId: id },
      },
      display: { name: `Fixture App ${id}`, appPath: `/applications/${id}`, risk: null },
    },
  });
  const apps = signal<AgentComputerApps>({ entries: props.details ? [makeApp('one')] : [] });
  const planArtifact: PlanArtifact = {
    title: 'PLAN_TITLE',
    overview: 'PLAN_OVERVIEW',
    steps: [
      {
        id: 'one',
        title: 'PLAN_STEP_ONE',
        description: 'PLAN_STEP_ONE_DETAIL',
        files: ['src/one.ts'],
      },
      { id: 'two', title: 'PLAN_STEP_TWO', description: 'PLAN_STEP_TWO_DETAIL' },
    ],
    risks: ['PLAN_RISK'],
  };
  const planView = signal<AgentPlanView>({
    enabled: !!props.plan,
    current: {
      revision: 3,
      proposal: props.plan
        ? {
            id: 'proposal-one',
            planId: 'plan-one',
            revision: 1,
            turnId: 'original-turn',
            artifact: planArtifact,
            status: 'pending_approval',
            submittedAt: 1,
          }
        : null,
      execution: null,
    },
  });
  const mode = signal<CollaborationMode>('agent');
  const unexpected = (): never => {
    throw new Error('Unexpected service outside composer completion');
  };
  const selection = { connectionId: 'original-route', revision: 1, modelId: 'fixture-model' };
  const owner: ComposerSession<JSX.Element> = {
    sessionId: 'original-session',
    draft,
    changeDraft: (text) => draft.set(text),
    editable: () => true,
    empty: () => false,
    workspace: () => '/workspace',
    blockedReason: () => '',
    error: () => '',
    notice: () => '',
    metrics: () => '',
    recoverable: () => false,
    recovering: () => false,
    unconfirmed: () => [],
    invocation: () => null,
    stopping: () => false,
    resumable: () => null,
    resuming: () => false,
    resume: unexpected,
    backend: () => ({ ...selection, thinkingLevel: null }),
    modelDetails: () => ({
      kind: 'ready',
      choice: {
        selection,
        connectionName: 'Original route',
        label: 'Fixture model',
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
    }),
    refreshModel: unexpected,
    previewImage: unexpected,
    submit: unexpected,
    sendRendered: unexpected,
    recover: unexpected,
    abandon: unexpected,
    stop: unexpected,
    permissions: {
      sessionId: 'original-session',
      snapshot: () => null,
      pending: () => false,
      error: () => '',
      select: unexpected,
    },
    queue: {
      sessionId: 'original-session',
      snapshot: queue,
      running: () => false,
      async read() {
        return {
          kind: 'ready',
          revision: queue().revision,
          message: 'QUEUED_ORIGINAL',
          hasAttachments: false,
        };
      },
      change: unexpected,
    },
    projectMcp: {
      proposal: () => null,
      pending: () => false,
      error: () => '',
      notice: () => '',
      trust: unexpected,
      dismiss: unexpected,
    },
    computerAccess: {
      snapshot: apps,
      async stop(operationId) {
        action.set(`stopped:${operationId}`);
        apps.set({
          entries: apps().entries.map((entry) =>
            entry.activity.operationId === operationId ? { ...entry, stopped: true } : entry,
          ),
        });
      },
    },
    plan: {
      view: planView,
      mode,
      pending: () => false,
      error: () => '',
      async selectMode(next) {
        action.set(`mode:${next}`);
        mode.set(next);
      },
      async change(input) {
        if (input.kind === 'cancel') {
          action.set(`plan:cancel:${input.executionId}`);
          const current = planView().current;
          planView.set({
            enabled: true,
            current: { ...current, execution: { ...current.execution!, phase: 'cancelled' } },
          });
          return;
        }
        if (input.kind !== 'approve') throw new Error('Unexpected plan action');
        action.set(`plan:approve:${input.proposalId}:${input.proposalRevision}`);
        planView.set({
          enabled: true,
          current: {
            revision: 4,
            proposal: { ...planView().current.proposal!, status: 'approved' },
            execution: {
              id: 'execution-one',
              proposalId: input.proposalId,
              artifact: planArtifact,
              steps: [
                { id: 'one', status: 'completed' },
                { id: 'two', status: 'in_progress' },
              ],
              phase: 'active',
              updatedAt: 2,
            },
          },
        });
      },
    },
    checklist: {
      read: unexpected,
      async watch() {
        let first = true;
        let finish: ((value: null) => void) | undefined;
        return {
          next: () =>
            first
              ? ((first = false),
                Promise.resolve({
                  enabled: !!props.details,
                  revision: 1,
                  total: props.details ? 2 : 0,
                  completed: 0,
                  current: props.details
                    ? { content: 'TODO_CURRENT', status: 'in_progress' }
                    : null,
                  offset: 0,
                  items: props.details
                    ? [
                        { content: 'TODO_CURRENT', status: 'in_progress' },
                        { content: 'TODO_NEXT', status: 'pending' },
                      ]
                    : [],
                  nextOffset: null,
                }))
              : new Promise<null>((resolve) => {
                  finish = resolve;
                }),
          async close() {
            finish?.(null);
          },
        };
      },
    },
    attachments: {
      sessionId: 'original-session',
      files: () => [],
      rows: () => [],
      ids: () => [],
      picker: () => false,
      restoring: () => false,
      error: () => '',
      notice: () => '',
      recovering: () => null,
      renderPicker: () => null,
      imageUri: unexpected,
      pasteClipboard: unexpected,
      dropFiles: unexpected,
      open: unexpected,
      remove: unexpected,
      recover: unexpected,
      abandon: unexpected,
      inspect: unexpected,
      retry: unexpected,
      reportError: unexpected,
      notify: unexpected,
      clearNotice() {},
    },
    completion: {
      async files(query, directory) {
        lookup.set(`files:${query}:${directory?.bytesBase64 ?? 'root'}`);
        let first = true;
        return {
          async next() {
            if (!first) return null;
            first = false;
            return {
              entries: [{ path: { bytesBase64: btoa('docs/Release Notes.md') }, kind: 'file' }],
            };
          },
          async close() {},
        };
      },
      async skills({ query, model }) {
        lookup.set(`skills:${query}:${model.modelId}`);
        return {
          skills: [
            {
              reference: 'review',
              name: 'Review changes',
              description: 'Review the selected changes',
              invocation: '/skill:review',
            },
          ],
        };
      },
      pathLabel: unexpected,
    },
  };
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <If when={props.details}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            accessibilityLabel="Add computer access"
            style={{ height: 32 }}
            onPress={() => apps.set({ entries: [...apps().entries, makeApp('two')] })}
          >
            <Text>Add computer access</Text>
          </Button>
          <Button
            accessibilityLabel="Clear computer access"
            style={{ height: 32 }}
            onPress={() => apps.set({ entries: [] })}
          >
            <Text>Clear computer access</Text>
          </Button>
          <Button
            accessibilityLabel="Restore computer access"
            style={{ height: 32 }}
            onPress={() => apps.set({ entries: [makeApp('one')] })}
          >
            <Text>Restore computer access</Text>
          </Button>
          <Button
            accessibilityLabel="Drain queued messages"
            style={{ height: 32 }}
            onPress={() => queue.set({ revision: queue().revision + 1, entries: [] })}
          >
            <Text>Drain queued messages</Text>
          </Button>
        </View>
      </If>
      <Text>{action()}</Text>
      <Text>{lookup()}</Text>
      <Composer
        session={() => owner}
        active={() => true}
        attach={() => {}}
        commands={() => [
          {
            id: 'inspect',
            title: 'Inspect draft',
            trigger: 'inspect',
            run() {
              action.set('command:inspect');
            },
          },
        ]}
        models={<View />}
        request={<View />}
        stopAction={() => unexpected}
        chooseWorkspace={unexpected}
        settings={unexpected}
      />
    </View>
  );
}

function Compaction() {
  const startedAt = Date.now() - 125_000;
  const state = signal<'background' | 'waiting' | 'completed'>('background');
  return (
    <View style={{ flex: 1 }}>
      <Button
        accessibilityLabel="Wait for background compaction"
        style={{ height: 32, flexShrink: 0 }}
        onPress={() => state.set('waiting')}
      >
        <Text>Wait for background compaction</Text>
      </Button>
      <Button
        accessibilityLabel="Complete compaction"
        style={{ height: 32, flexShrink: 0 }}
        onPress={() => state.set('completed')}
      >
        <Text>Complete compaction</Text>
      </Button>
      <Each of={state() === 'background' ? [] : [state()]} key={(value) => value}>
        {(value) =>
          value() === 'waiting' ? (
            <CompactionDivider state="running" startedAt={() => startedAt} />
          ) : (
            <CompactionDivider state="completed" durationMs={() => 126_700} />
          )
        }
      </Each>
    </View>
  );
}

function WorkspacePages(props: { busy: boolean }) {
  const session = (workspace: string, index: number): BrowserSession => ({
    id: `${workspace}-${index}`,
    title: `${workspace} conversation ${index}`,
    revision: 1,
    labels: [],
    archived: false,
    pinned: false,
    hasUnread: false,
    tailMessageId: null,
    branch: null,
    activity: 'idle',
    updatedAt: index,
    permissions: { access: 'workspace_write', requestPermissions: true },
    boundaryRevision: 1,
    binding: { id: '47a24946-26e1-4451-9584-19e5120dfab8', permissionEpoch: 1 },
    dataSource: {
      stateDomain: '0'.repeat(64),
      deployment: '47a24946-26e1-4451-9584-19e5120dfab8',
      namespace: [],
    },
    workspace: {
      path: `/workspace/${workspace}`,
      directoryIdentity: workspace,
      identity: workspace,
    },
  });
  const scope = { kind: 'all' } as const;
  const sessions = signal(Array.from({ length: 32 }, (_, index) => session('A', index)));
  const loading = signal(false);
  const calls = signal(0);
  const release = signal<(() => void) | null>(null);
  let page = 1;
  const browsing: Browsing = {
    scope: () => scope,
    filter: () => 'all',
    sessions,
    loading,
    projects: () =>
      props.busy
        ? Array.from({ length: 12 }, (_, index) => ({
            reference: { id: `empty-${index}`, revision: 'original' },
            name: `Empty ${index}`,
            archived: false,
            available: false,
            selection: null,
            path: null,
          }))
        : [],
    error: () => '',
    projectError: () => '',
    setScope() {},
    setFilter() {},
    async refresh() {},
    async loadMore() {
      if (loading()) return 'waiting';
      if (page === 3) return 'complete';
      loading.set(true);
      calls.set(calls() + 1);
      await new Promise<void>((resolve) => release.set(resolve));
      release.set(null);
      page += 1;
      sessions.set([
        ...sessions(),
        ...(page === 2
          ? Array.from({ length: 32 }, (_, index) => session('A', index + 32))
          : [session('B', 0)]),
      ]);
      loading.set(false);
      return 'advanced';
    },
  };
  if (props.busy) void browsing.loadMore();
  return (
    <View style={{ flex: 1 }}>
      <Text>
        {platform.isTerminal ? 'TERMINAL_BRANCH' : 'DESKTOP_BRANCH'} requests:{calls()}
      </Text>
      <Button
        accessibilityLabel="Publish requested page"
        disabled={release() === null}
        style={{ height: 32, flexShrink: 0 }}
        onPress={() => release()?.()}
      >
        <Text>Publish requested page</Text>
      </Button>
      <WorkspaceBrowser
        browsing={browsing}
        docked={() => false}
        selected={() => null}
        switching={() => false}
        focusRequest={() => false}
        focusHandled={() => {}}
        attach={() => {}}
        close={() => {}}
        selectSession={async () => {}}
        create={async () => {}}
        newConversation={() => {}}
        settings={() => {}}
        search={() => {}}
        changeSession={async () => {}}
      />
    </View>
  );
}

const scenario = (nativeHost as unknown as { scenario: string }).scenario;
mount(() =>
  scenario.startsWith('workspace-pages') ? (
    <WorkspacePages busy={scenario === 'workspace-pages-busy'} />
  ) : scenario === 'compaction' ? (
    <Compaction />
  ) : scenario === 'sandbox' ? (
    <Sandbox />
  ) : scenario === 'composer-plan' ? (
    <CompletionComposer plan />
  ) : scenario === 'composer-details' ? (
    <CompletionComposer details />
  ) : scenario === 'composer' ? (
    <CompletionComposer />
  ) : (
    <Consent />
  ),
);
