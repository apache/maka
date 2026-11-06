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
import { SkillInput } from '../../app/SkillInput';
import { SkillMessage } from '../../app/SkillMessage';
import type { ComposerEditor } from '../../app/ComposerEditor';
import type { Row } from '../../app/history';

mount(() => {
  const initial = '前😀 /skill:review 后';
  const draft = signal(initial);
  const selection = signal({ start: 0, end: 0 });
  const submitted = signal('');
  const ready = signal(false);
  const shortcut = signal(false);
  const released = signal(false);
  let editor: ComposerEditor | undefined;
  keymap.bind('left', () => released.set(true), { when: 'always' });
  keymap.bind('mod+n', () => shortcut.set(true), { when: 'always' });
  return (
    <View style={{ width: 600, gap: 8 }}>
      <SkillInput
        accessibilityLabel="Draft"
        value={draft()}
        readonly={false}
        autoFocus
        placeholder=""
        ref={(node) => {
          editor = node;
          node.bindKey('mod+i', () =>
            node.replaceRange({
              ...selection(),
              text: '/skill:fix ',
              expectedText: draft(),
              expectedSelection: selection(),
            }),
          );
          ready.set(true);
        }}
        onChange={({ value }) => draft.set(value)}
        onSelectionChange={(value) => selection.set(value)}
        onSubmit={({ text }) => submitted.set(text)}
      />
      <Text>{`Draft ${JSON.stringify(draft())}`}</Text>
      <Text>{`Submitted ${JSON.stringify(submitted())}`}</Text>
      <Text>{ready() ? 'Ready' : 'Starting'}</Text>
      <Text>{ready() && editor?.composing() ? 'Composing' : 'Idle'}</Text>
      <Text>{shortcut() ? 'Shortcut received' : 'Shortcut idle'}</Text>
      <Text>{released() ? 'IME key released' : 'IME key held'}</Text>
      <Button
        accessibilityLabel="Reset"
        onPress={() => {
          draft.set('');
          editor?.focus();
        }}
      >
        <Text>Reset</Text>
      </Button>
      <SkillMessage row={() => ({ text: initial }) as Row} sourceId="fixture/message" />
    </View>
  );
});
