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

import { cleanup, keymap, mount, signal, Text, View, type JSX } from 'nsh';
import type {
  AgentBackendPreference,
  ComposerSendBlock,
  ComposerSession,
  ComposerUploadRow,
} from '../../../../../packages/plugin-sdk/src/composer-view.js';
import { Composer } from '../../../../../plugins/agent/composer/ui/Composer';
import { CompactComposer } from '../../../../../plugins/agent/conversations/ui/CompactComposer';
import { InlineCallout } from '../../app/Feedback';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

function Fixture() {
  installWorkbenchLocaleCatalog();
  currentLocale.set('en');

  const surface = signal<'main' | 'compact'>('main');
  const draft = signal('hello world');
  const sendBlock = signal<ComposerSendBlock | null>({
    kind: 'workspace',
    message: 'The workspace for this task is unavailable.',
  });
  const rows = signal<ComposerUploadRow[]>([]);
  const submissions = signal(0);

  const unexpected = (): never => {
    throw new Error('Unexpected action in composer-notices fixture');
  };
  const backend: AgentBackendPreference = {
    kind: 'model',
    connectionId: 'conn',
    modelId: 'model',
    thinkingLevel: null,
  };

  const session: ComposerSession<JSX.Element> = {
    sessionId: 'session-1',
    quotes: () => [],
    removeQuote: () => {},
    connected: () => true,
    draft,
    changeDraft: (text) => draft.set(text),
    editable: () => true,
    loading: () => false,
    empty: () => false,
    workspace: () => '/missing-workspace',
    sendBlock,
    error: () => '',
    dismissError: () => {},
    notice: () => '',
    metrics: () => '',
    recovering: () => false,
    sends: () => [],
    retrySend: unexpected,
    editSend: unexpected,
    checkSend: unexpected,
    dismissSend: unexpected,
    run: () => null,
    execution: () => null,
    prediction: { current: () => null, dismiss: () => {} },
    stopping: () => false,
    continuation: () => null,
    continuing: () => false,
    continueRun: unexpected,
    backend: () => backend,
    modelDetails: () => ({
      kind: 'ready',
      choice: {
        selection: backend,
        sourceName: 'Fixture',
        label: 'Fixture model',
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
    }),
    refreshModel: unexpected,
    previewImage: unexpected,
    submit: () => submissions.set(submissions() + 1),
    sendRendered: () => submissions.set(submissions() + 1),
    stop: unexpected,
    permissions: {
      sessionId: 'session-1',
      snapshot: () => null,
      pending: () => false,
      error: () => '',
      select: unexpected,
    },
    queue: {
      sessionId: 'session-1',
      snapshot: () => ({ revision: 1, entries: [] }),
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
      decline: unexpected,
      dismiss: unexpected,
    },
    computerAccess: { snapshot: () => ({ entries: [] }), stop: unexpected },
    checklist: {
      read: unexpected,
      async watch() {
        return {
          next: () => new Promise<null>(() => {}),
          async close() {},
        };
      },
    },
    completion: {
      files: null,
      sessions: async () => [],
      skills: async () => ({ items: [] }),
    },
    attachments: {
      sessionId: 'session-1',
      files: () => [],
      rows,
      ids: () => [],
      picker: () => false,
      restoring: () => false,
      error: () => '',
      notice: () => '',
      recovering: () => null,
      imageUri: () => '',
      renderPicker: () => <View />,
      intake: () => {},
      open: () => {},
      remove: () => {},
      reportError: () => {},
      notify: () => {},
      clearNotice: () => {},
    },
  };

  cleanup(
    keymap.bind(
      {
        f1: () => {
          rows.set([]);
          sendBlock.set({
            kind: 'workspace',
            message: 'The workspace for this task is unavailable.',
          });
        },
        f2: () => {
          rows.set([
            {
              id: 'u1',
              name: 'broken.png',
              kind: 'failed',
              error: 'Disk read failed',
            },
          ]);
          sendBlock.set({
            kind: 'attachments',
            message: 'Remove the failed attachment or choose it again.',
          });
        },
        f3: () => {
          rows.set([]);
          sendBlock.set({
            kind: 'draft',
            message:
              'This conversation is archived. Restore it in Sessions to send; your draft is kept.',
          });
        },
        f4: () => {
          surface.set('compact');
        },
        f5: () => {
          rows.set([]);
          sendBlock.set(null);
        },
      },
      { when: 'always' },
    ),
  );

  const request = (
    <If when={sendBlock()?.kind === 'workspace'}>
      <InlineCallout
        tone="warning"
        message="The workspace for this task is unavailable."
        action={{ label: 'Choose workspace', primary: true, onPress: () => {} }}
      />
    </If>
  );

  return (
    <View style={{ flex: 1, minHeight: 0, padding: 12 }}>
      <Text>{`submissions:${submissions()}`}</Text>
      <If
        when={surface() === 'main'}
        else={
          <View>
            <CompactComposer
              session={() => session}
              stop={() => {}}
              expand={() => {}}
              chooseModel={() => {}}
              attach={() => {}}
            />
            {request}
          </View>
        }
      >
        <Composer
          active={() => true}
          session={() => session}
          stopAction={() => () => {}}
          request={request}
          attach={() => {}}
          commands={() => []}
          models={<View />}
          settings={() => {}}
          chooseWorkspace={() => {}}
        />
      </If>
    </View>
  );
}

mount(() => <Fixture />);
