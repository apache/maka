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

import { mount, signal, View, Text } from 'nsh';
import { Button } from 'nsh/base';
import { attachDictation, DictationBar } from '../../app/InlineDictation';

import { composerIconSlot } from '../../app/ui';
import { Icon } from '../../app/Icon';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

mount(() => {
  installWorkbenchLocaleCatalog();
  const draft = signal('周五开会');
  const sent = signal('');
  let release: (() => void) | undefined;
  let failed = false;
  const state = attachDictation(
    'fixture',
    {
      draft,
      send: (text) => sent.set(text),
      selection: () => ({ start: 2, end: 2 }),
      active: () => true,
      editor: () =>
        ({
          focus() {},
          composing: () => false,
          async replaceRange(change) {
            draft.set(draft().slice(0, change.start) + change.text + draft().slice(change.end));
            return true;
          },
        }) as import('../../app/ComposerEditor').ComposerEditor,
      error: (reason) => {
        throw new Error(String(reason));
      },
    },
    () => ({
      async start() {
        return true;
      },
      async level() {
        return 0.75;
      },
      cancel() {},
      async finish() {
        if (!failed) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          failed = true;
          throw new Error('Offline');
        }
        return '下午';
      },
    }),
  );
  return (
    <View>
      <Button accessibilityLabel="Release transcription" onPress={() => release?.()}>
        <Text>Release</Text>
      </Button>
      <Text>{draft()}</Text>
      <Text>{sent() ? `Sent: ${sent()}` : 'Unsent'}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <If when={state.phase() === 'idle'} else={<DictationBar state={state} />}>
          <Button style={composerIconSlot} accessibilityLabel="Add to message">
            <Icon name="plus" color="#000" />
          </Button>
          <Button accessibilityLabel="Microphone" onPress={() => void state.start()}>
            <Text>Mic</Text>
          </Button>
        </If>
      </View>
    </View>
  );
});
