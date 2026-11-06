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
  const selected = signal({ start: 0, end: 0 });
  const submitted = signal('');
  const height = signal(0);
  const ready = signal(false);
  const appShortcut = signal(false);
  keymap.bind('mod+n', () => appShortcut.set(true), { when: 'always' });
  let editor: ComposerEditor | undefined;
  return (
    <View style={{ width: 600, gap: 8 }}>
      <View
        style={{ maxHeight: 144, minHeight: 24 }}
        onLayout={({ bounds }) => height.set(bounds.size.height)}
      >
        <SkillInput
          ref={(node) => {
            editor = node;
            node.bindKey('tab', () => {
              if (node.composing()) return;
              node.replaceRange({
                start: selected().start,
                end: selected().end,
                text: '/skill:fix ',
                expectedText: draft(),
                expectedSelection: selected(),
              });
            });
            ready.set(true);
          }}
          testID="draft-field"
          accessibilityLabel="Draft"
          value={draft()}
          readonly={false}
          autoFocus
          placeholder="Message"
          onChange={({ value }) => draft.set(value)}
          onSelectionChange={(range) => selected.set(range)}
          onSubmit={({ text }) => submitted.set(text)}
          style={{ flexShrink: 1 }}
        />
      </View>
      <Text>{`Source ${JSON.stringify(draft())}`}</Text>
      <Text>{`Selection ${selected().start}:${selected().end}`}</Text>
      <Text>{`Submitted ${JSON.stringify(submitted())}`}</Text>
      <Text>{`Height ${height()}`}</Text>
      <Text>{ready() ? 'Editor ready' : 'Starting editor'}</Text>
      <Text>{appShortcut() ? 'App shortcut received' : 'App shortcut idle'}</Text>
      <Button
        accessibilityLabel="Reset"
        onPress={() => {
          draft.set('');
          editor?.focus();
        }}
      >
        <Text>Reset</Text>
      </Button>
      <View style={{ width: 500 }}>
        <SkillMessage row={() => ({ text: initial }) as Row} sourceId="fixture/message" />
      </View>
    </View>
  );
});
