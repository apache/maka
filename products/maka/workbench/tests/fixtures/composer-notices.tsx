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
} from '../../../../../packages/plugin-sdk/src/composer-view.js';
import { Composer } from '../../../../../plugins/agent/composer/ui/Composer';
import { CompactComposer } from '../../../../../plugins/agent/conversations/ui/CompactComposer';
import { createAttachmentDraft } from '../../app/attachmentDraft';
import { InlineCallout } from '../../app/Feedback';
import type { ScopedHost } from '../../app/host';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

function Fixture() {
  installWorkbenchLocaleCatalog();
  currentLocale.set('en');

  const surface = signal<'main' | 'compact'>('main');
  const draft = signal('hello world');
  const recovering = signal(false);
  const overrideBlock = signal<ComposerSendBlock | null>({
    kind: 'workspace',
    message: 'The workspace for this task is unavailable.',
  });
  const submissions = signal(0);

  let pushIntake: ((value: unknown) => void) | null = null;
  let endIntake: (() => void) | null = null;

  const client = {
    findUpload: async () => null,
    watchUploads: () => {
      let sentInitial = false;
      return {
        next: () => {
          if (!sentInitial) {
            sentInitial = true;
            return Promise.resolve([]);
          }
          return new Promise(() => {});
        },
        close: () => {},
      };
    },
  } as unknown as ScopedHost;

  const attachments = createAttachmentDraft({
    sessionId: 'session-1',
    client,
    changed: () => {},
    focus: () => {},
  });

  const sendBlock = (): ComposerSendBlock | null => overrideBlock() ?? attachments.blocked();

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
    recovering,
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
      files: attachments.files,
      rows: attachments.rows,
      ids: attachments.ids,
      picker: attachments.picker,
      restoring: attachments.restoring,
      error: attachments.error,
      notice: attachments.notice,
      recovering: attachments.recovering,
      imageUri: () => '',
      renderPicker: () => <View />,
      intake: () => {},
      open: attachments.open,
      remove: attachments.remove,
      reportError: attachments.reportError,
      notify: attachments.notify,
      clearNotice: attachments.clearNotice,
    },
  };

  const clearAttachments = () => {
    endIntake?.();
    pushIntake = null;
    endIntake = null;
    for (const row of attachments.rows()) {
      attachments.remove({ owner: 'session-1', id: row.id });
    }
  };

  cleanup(
    keymap.bind(
      {
        f1: () => {
          clearAttachments();
          recovering.set(false);
          overrideBlock.set({
            kind: 'workspace',
            message: 'The workspace for this task is unavailable.',
          });
        },
        f2: () => {
          clearAttachments();
          recovering.set(false);
          overrideBlock.set(null);
          const queue: Array<unknown | null> = [];
          let wake: ((value: unknown | null) => void) | null = null;
          let closed = false;
          pushIntake = (value) => {
            if (closed) return;
            if (wake) {
              const resolve = wake;
              wake = null;
              resolve(value);
            } else {
              queue.push(value);
            }
          };
          endIntake = () => {
            if (closed) return;
            closed = true;
            if (wake) {
              const resolve = wake;
              wake = null;
              resolve(null);
            } else {
              queue.push(null);
            }
          };
          attachments.observeIntake({
            next: () => {
              if (queue.length > 0) return Promise.resolve(queue.shift()!);
              if (closed) return Promise.resolve(null);
              return new Promise((resolve) => {
                wake = resolve;
              });
            },
            close: () => {
              closed = true;
            },
          });
        },
        f6: () => {
          pushIntake?.({ operationId: 'u1', name: 'report.png', kind: 'uploading' });
        },
        f7: () => {
          pushIntake?.({
            operationId: 'u1',
            name: 'report.png',
            kind: 'failed',
            error: 'Disk read failed',
          });
          endIntake?.();
        },
        f3: () => {
          clearAttachments();
          recovering.set(false);
          overrideBlock.set({
            kind: 'draft',
            message:
              'This conversation is archived. Restore it in Sessions to send; your draft is kept.',
          });
        },
        f8: () => {
          clearAttachments();
          recovering.set(true);
          overrideBlock.set({
            kind: 'draft',
            message: 'Checking send status…',
          });
        },
        f4: () => {
          surface.set('compact');
        },
        f5: () => {
          clearAttachments();
          recovering.set(false);
          overrideBlock.set(null);
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
