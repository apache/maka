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

import { Each, mount, signal, Text, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { Composer } from '../../../../../plugins/agent/composer/ui/Composer';
import type { ComposerSession } from '../../../../../packages/plugin-sdk/src/composer-view.js';
import { host as nativeHost } from 'maka/host';
import { SessionPermissionsSelect } from '../../../workbench/app/SessionPermissionsSelect';
import { InteractionComposer } from '../../../workbench/app/InteractionComposer';
import { CompactionDivider } from '../../../workbench/app/CompactionDivider';
import { HostProvider, type Host } from '../../../workbench/app/host';
import type {
  AgentSession,
  InteractionRecord,
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

function CompletionComposer() {
  const draft = signal('');
  const action = signal('No command');
  const lookup = signal('No lookup');
  const unexpected = (): never => {
    throw new Error('Unexpected service outside composer completion');
  };
  const selection = { connectionId: 'original-route', revision: 1, modelId: 'fixture-model' };
  const owner: ComposerSession<JSX.Element> = {
    sessionId: 'original-session',
    draft,
    changeDraft: draft.set,
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
      snapshot: () => null,
      running: () => false,
      read: unexpected,
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
                  enabled: false,
                  total: 0,
                  completed: 0,
                  offset: 0,
                  items: [],
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
        onPress={() => state.set('waiting')}
      >
        Wait for background compaction
      </Button>
      <Button accessibilityLabel="Complete compaction" onPress={() => state.set('completed')}>
        Complete compaction
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

const scenario = (nativeHost as unknown as { scenario: string }).scenario;
mount(() =>
  scenario === 'compaction' ? (
    <Compaction />
  ) : scenario === 'sandbox' ? (
    <Sandbox />
  ) : scenario === 'composer' ? (
    <CompletionComposer />
  ) : (
    <Consent />
  ),
);
