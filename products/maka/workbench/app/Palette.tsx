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

import { textTooltip } from './ui';
import { tr } from './locale';
import { cleanup, computed, inputAction, signal, Text, View, List } from 'nsh';
import { Input } from 'nsh/base';
import type { YNode } from 'nsh';
import { keymap } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { windowSize } from 'nsh';
import { Icon } from './Icon';
import type { CommandEntry } from './composerCommands';
import {
  C,
  captionTextStyle,
  inputBorderRadius,
  compact,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  secondaryTextStyle,
} from './ui';
import { dialogTop } from './chrome';

export function Palette(props: {
  instance: number;
  commands: CommandEntry[];
  close(instance: number): boolean;
}) {
  const query = signal('');
  const selected = signal(0);
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
  let list: YNode | undefined;
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
    <Dialog
      animation="none"
      onOpenChange={() => {
        props.close(props.instance);
      }}
      style={{
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
        backgroundColor: '#00000099',
        paddingHorizontal: 16,
        paddingTop: compact() ? dialogTop(16) : windowSize().height / 8,
        paddingBottom: 16,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 640,
          maxHeight: '100%',
          minHeight: 0,
          flexShrink: 1,
          backgroundColor: C.surface,
          padding: 16,
          gap: 16,
          borderWidth: 1,
          borderRadius: 16,
          borderColor: C.line,
        }}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text style={{ color: C.text, fontSize: 18, lineHeight: 24, fontWeight: '600' }}>
            {tr('Commands')}
          </Text>
          <Button
            accessibilityLabel={tr('Close commands')}
            tooltip={textTooltip(() => tr('Close · Esc'))}
            onPress={inputAction(props.close, props.instance)}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="close" color={C.muted} />
          </Button>
        </View>
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
          onChange={(text) => {
            selected.set(0);
            query.set(text);
            list?.scrollToIndex({ index: 0, animated: false });
          }}
          placeholder={tr('Search commands…')}
          style={{
            placeholderColor: C.muted,
            color: C.text,
            height: compact() ? 32 : 40,
            backgroundColor: C.background,
            borderRadius: inputBorderRadius,
            paddingHorizontal: 12,
            fontSize: 14,
          }}
        />
        <List
          each={ids()}
          ref={(node) => {
            list = node;
          }}
          estimatedItemSize={48}
          style={{ height: Math.max(1, ids().length) * 48, flexShrink: 1, minHeight: 0 }}
          empty={<Text style={{ color: C.muted }}>{tr('No matches.')}</Text>}
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
                    style={{
                      height: 48,
                      paddingHorizontal: 12,
                      paddingVertical: 4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      borderWidth: 1,
                      borderColor: 'transparent',
                      borderRadius: 8,
                      backgroundColor: matches()[index()]?.id === entry().id ? C.raised : C.surface,
                    }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={{
                          ...secondaryTextStyle,
                          color: C.text,
                          fontSize: 14,
                          fontWeight: '500',
                        }}
                      >
                        {entry().title}
                      </Text>
                      <If when={entry().detail}>
                        <Text
                          numberOfLines={1}
                          ellipsizeMode="tail"
                          style={{ ...captionTextStyle, color: C.muted }}
                        >
                          {entry().detail}
                        </Text>
                      </If>
                    </View>
                    <If when={entry().hint}>
                      <Text
                        pointerEvents="none"
                        style={{
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
                        }}
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
      </View>
    </Dialog>
  );
}
