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

import { createAttachmentDraft } from '../../../workbench/app/attachmentDraft';
import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { host } from 'maka/host';
import type {
  ClientOperation,
  ClientDraftAttachment,
} from '../../../../../packages/plugin-sdk/src/index.js';

declare const attachmentDraftFixture: {
  original: ClientOperation;
  reserved: ClientOperation;
  attachment: ClientDraftAttachment;
};
const { original, reserved, attachment } = attachmentDraftFixture;
mount(() => {
  const client = host.session(host.initialSession);
  let revision = 0;
  let release;
  let initial = true;
  const saved = signal(false);
  const delivered = signal(false);
  const state = createAttachmentDraft({
    sessionId: host.initialSession,
    client: {
      watchUploads: () => ({
        next: () =>
          initial
            ? ((initial = false), Promise.resolve([reserved]))
            : new Promise((resolve) => {
                release = resolve;
              }),
        close: () => {
          release?.(null);
        },
      }),
    },
    changed() {},
    focus() {},
  });
  state.status({ operationId: original.id, name: attachment.name, kind: 'uploading' });
  const save = async () => {
    const snapshot = state.snapshot();
    const stored = await client.saveDraft(revision, { text: '', ...snapshot });
    revision = stored.revision;
    state.saved(snapshot);
    saved.set(true);
  };
  void state.start();
  return (
    <View style={{ width: '100%', gap: 8 }}>
      <Button
        accessibilityLabel="Deliver confirmed original read"
        onPress={() => {
          release([original]);
        }}
      >
        <Text>Deliver confirmed original read</Text>
      </Button>
      <Text>{state.blocked()}</Text>
      <Button accessibilityLabel="Save attachment draft" onPress={save}>
        <Text>Save attachment draft</Text>
      </Button>
      <Button
        accessibilityLabel="Remove selected attachment"
        onPress={() => {
          state.remove({ owner: host.initialSession, id: attachment.id });
          saved.set(false);
        }}
      >
        <Text>Remove selected attachment</Text>
      </Button>
      <Button
        accessibilityLabel="Deliver delayed original read"
        onPress={() => {
          release([original]);
          Promise.resolve().then(() => delivered.set(true));
        }}
      >
        <Text>Deliver delayed original read</Text>
      </Button>
      <Text>{`files:${state.files().length}`}</Text>
      <Text>{saved() ? 'Draft saved' : 'Unsaved edit'}</Text>
      <Text>{delivered() ? 'Delayed read delivered' : 'Delayed read held'}</Text>
    </View>
  );
});
