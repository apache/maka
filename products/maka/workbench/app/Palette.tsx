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

import { tr } from './locale';
import { cleanup, computed, signal, Text, View, List } from 'nsh';
import { Input } from 'nsh/base';
import type { ListRef, ViewStyle } from 'nsh';
import { keymap } from 'nsh';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import type { CommandEntry } from './composerCommands';
import {
  C,
  captionTextStyle,
  compact,
  controlDisabledStyle,
  controlHoverStyle,
  menuSeparatorStyle,
  secondaryTextStyle,
} from './ui';
import { ModalDialog } from './ModalDialog';

export function Palette(props: {
  instance: number;
  commands: CommandEntry[];
  close(instance: number): boolean;
}) {
  const query = signal('');
  const selected = signal(0);
  const rowStyle = () =>
    ({
      height: 48,
      paddingHorizontal: 8,
      paddingVertical: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderRadius: 8,
    }) satisfies ViewStyle;
  let removeSearchKeys = () => {};
  cleanup(() => removeSearchKeys());
  const matches = computed(() => {
    const needle = query().toLowerCase().trim();
    return props.commands.filter((entry) =>
      `${entry.title} ${entry.detail ?? ''}`.toLowerCase().includes(needle),
    );
  });
  const index = () => Math.min(selected(), Math.max(0, matches().length - 1));
  const byId = computed(() => new Map(matches().map((entry) => [entry.id, entry])));
  const ids = computed(() => matches().map((entry) => entry.id));
  let list: ListRef | undefined;
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(matches().length - 1, index() + delta));
    selected.set(next);
    list?.scrollToIndex({ index: next, animated: false, viewPosition: delta > 0 ? 1 : 0 });
  };
  const activate = () => {
    const entry = matches()[index()];
    if (!entry) return;
    entry.run();
  };
  return (
    <ModalDialog
      size="form"
      launcher
      onCancel={() => props.close(props.instance)}
      style={{ maxWidth: 640, flexShrink: 1, padding: 4, gap: 0 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
        <Icon name="search" color={C.muted} />
        <Input
          ref={(node) => {
            removeSearchKeys();
            const unbind = [
              keymap.bind('up', () => move(-1), { when: 'always', repeat: true, within: node }),
              keymap.bind('down', () => move(1), { when: 'always', repeat: true, within: node }),
              keymap.bind('enter', activate, { when: 'always', within: node }),
              // One Escape closes the palette, as its close button says; a
              // text field alone would only lose the focus.
              keymap.bind('escape', () => props.close(props.instance), {
                when: 'always',
                within: node,
              }),
            ];
            removeSearchKeys = () => unbind.forEach((remove) => remove());
          }}
          testID="palette-search"
          accessibilityLabel={tr('Search commands')}
          autoFocus
          value={query()}
          onChange={({ value: text }) => {
            selected.set(0);
            query.set(text);
            list?.scrollToIndex({ index: 0, animated: false });
          }}
          placeholder={tr('Search commands…')}
          style={{
            flex: 1,
            placeholderColor: C.muted,
            color: C.text,
            height: compact() ? 32 : 40,
            fontSize: 14,
          }}
        />
      </View>
      <View style={menuSeparatorStyle()} />
      <List
        each={ids()}
        ref={(node) => {
          list = node;
        }}
        estimatedItemSize={48}
        style={{ height: Math.max(1, ids().length) * 48, flexShrink: 1, minHeight: 0 }}
        empty={<Text style={{ color: C.muted, padding: 8 }}>{tr('No matches.')}</Text>}
      >
        {(id) => (
          <Each of={[id()]} key={(key: string) => key}>
            {(key) => {
              const initial = byId().get(key());
              if (!initial) return <View />;
              const entry = () => byId().get(key()) ?? initial;
              return (
                <Button
                  accessibilityLabel={entry().title}
                  selected={matches()[index()]?.id === entry().id}
                  onPress={entry().run}
                  style={rowStyle()}
                  selectedStyle={controlHoverStyle()}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlHoverStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <View style={[{ flex: 1, minWidth: 0 }, { pointerEvents: 'none' }]}>
                    <Text
                      style={[
                        {
                          ...secondaryTextStyle,
                          color: C.text,
                          fontSize: 14,
                          fontWeight: '500',
                        },
                        { numberOfLines: 1, textOverflow: 'ellipsis' },
                      ]}
                    >
                      {entry().title}
                    </Text>
                    <If when={entry().detail}>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.muted },
                          { numberOfLines: 1, textOverflow: 'ellipsis' },
                        ]}
                      >
                        {entry().detail}
                      </Text>
                    </If>
                  </View>
                  <If when={entry().hint}>
                    <Text
                      style={[
                        {
                          ...captionTextStyle,
                          color: C.muted,
                          fontSize: 11,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderWidth: 1,
                          borderColor: C.line,
                          borderRadius: 4,
                          backgroundColor: C.background,
                          flexShrink: 0,
                        },
                        { pointerEvents: 'none' },
                      ]}
                    >
                      {entry().hint}
                    </Text>
                  </If>
                </Button>
              );
            }}
          </Each>
        )}
      </List>
    </ModalDialog>
  );
}
