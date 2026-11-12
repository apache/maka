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

import { mount, signal, Text, View } from 'nsh';
import {
  ComposerCompletion,
  type ComposerCompletionRow,
  type ComposerCompletionView,
  createComposerCompletion,
} from '../../../../../plugins/agent/composer/ui/ComposerCompletion';
import type { ComposerViewInput } from '../../../../../packages/plugin-sdk/src/composer-view';
import { SkillInput } from '../../app/SkillInput';

const skills = Array.from({ length: 16 }, (_, index) => `skill-${String(index).padStart(2, '0')}`);
const makeRows = (read: number): ComposerCompletionRow[] =>
  skills.map((name) => ({
    id: `skill:${name}`,
    title: name,
    detail: `Description of ${name}`,
    icon: 'code',
    action: { read, id: `skill:${name}` },
  }));

function RecycledRows() {
  const generation = signal(1);
  const rows = signal(makeRows(1));
  const query = signal('');
  const accepted = signal('idle');
  const state: ComposerCompletionView = {
    rows,
    opened: () => ({ serial: generation(), source: 'skills', explicit: false }),
    anchor: () => ({ origin: { x: 20, y: 180 }, size: { width: 1, height: 20 } }),
    title: () => 'Skills',
    loading: () => false,
    error: () => '',
    empty: () => 'No matching skills.',
    query,
    queryPlaceholder: () => 'Search skills…',
    queryComposing: () => false,
    queryInput: () => {},
    querySelection: () => {},
    queryComposition: () => {},
    acceptSelected: () => {},
    index: () => 0,
    list: () => {},
    close: () => {},
    dismiss: () => {},
    accept: (action) => accepted.set(`${action.read}:${action.id}`),
  };
  return (
    <View style={{ flex: 1 }}>
      <View
        testID="refresh"
        style={{ height: 24 }}
        onPress={() => {
          generation.set(2);
          rows.set(makeRows(2));
        }}
      >
        <Text>Refresh lookup</Text>
      </View>
      <Text>{accepted()}</Text>
      <ComposerCompletion state={state} />
    </View>
  );
}

function PendingComposer() {
  const draft = signal('');
  const submitted = signal('');
  const backend = {
    kind: 'model',
    connectionId: 'fixture',
    modelId: 'fixture',
    thinkingLevel: null,
  } as const;
  const unused = () => {
    throw new Error('Unexpected pending composer action');
  };
  const pending: NonNullable<ReturnType<NonNullable<ComposerViewInput['pending']>>> = {
    id: 'pending',
    workspace: () => '/fixture',
    backend: () => backend,
    modelDetails: () => ({
      kind: 'ready',
      choice: { selection: backend, sourceName: 'Fixture', label: 'Fixture', thinkingLevels: [] },
    }),
    permissions: {
      id: 'pending',
      access: () => null,
      requestPermissions: () => null,
      pending: () => false,
      selectAccess: unused,
      selectRequests: unused,
    },
    draft,
    changeDraft: (text: string) => draft.set(text),
    confirmation: () => 'fixture',
    sending: () => false,
    ready: () => true,
    files: () => [],
    picking: () => false,
    selectFiles: unused,
    dropFiles: unused,
    pasteClipboard: unused,
    reportError: unused,
    removeFile: unused,
    openPicker: unused,
    submit: (text: string) => submitted.set(text),
    completion: {
      files: null,
      pathLabel: unused,
      skills: async ({ query }) => ({
        skills: skills
          .filter((name) => name.includes(query))
          .map((name) => ({
            reference: name,
            name,
            description: `Description of ${name}`,
            invocation: `/skill:${name}`,
          })),
      }),
    },
  };
  const completion = createComposerCompletion({
    session: () => null,
    pending: () => pending,
    commands: () => [],
    active: () => true,
  });
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Text>{`Draft ${JSON.stringify(draft())}`}</Text>
      <Text>{`Submitted ${JSON.stringify(submitted())}`}</Text>
      <SkillInput
        accessibilityLabel="New chat"
        value={draft()}
        readonly={false}
        autoFocus
        placeholder=""
        ref={(node) => completion.attach(null, node)}
        onChange={({ value }) => completion.change(pending, value)}
        onSelectionChange={(range) => completion.selection(pending, range)}
        onCaretMove={(event) => completion.caret(pending, event)}
        onSubmit={({ text }) => completion.submitPending(pending, text)}
      />
      <ComposerCompletion state={completion} />
    </View>
  );
}

mount(() => {
  const pending = signal(false);
  return (
    <View style={{ flex: 1 }}>
      <View testID="pending" onPress={() => pending.set(true)}>
        <Text>Open new chat</Text>
      </View>
      <If when={pending()} else={<RecycledRows />}>
        <PendingComposer />
      </If>
    </View>
  );
});
