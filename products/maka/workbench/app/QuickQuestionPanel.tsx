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

import { cleanup, keymap, openUrl, Scroll, signal, Text, View, type ScrollRef } from 'nsh';
import { Button, Input, Menu, MenuItem } from 'nsh/base';
import { MakaMark, quickBarStyle, quickInputStyle } from './QuickBar';
import type { createQuickQuestion } from './quickQuestion';
import { MessageRow } from './MessageRow';
import { tr } from './locale';
import { C, floatingStyle, menuRowStyle, menuRowHoverStyle, IconButton } from './ui';

export function QuickQuestionPanel(props: {
  question: ReturnType<typeof createQuickQuestion>;
  promoting(): boolean;
  promote(): void;
  back(): void;
}) {
  const { question } = props;
  const draft = signal('');
  const menu = signal(false);
  const busy = () => question.running() || props.promoting();
  const back = () => {
    if (menu()) menu.set(false);
    else if (question.running()) question.stop();
    else if (!props.promoting()) props.back();
  };
  cleanup(keymap.bind('escape', back, { when: 'always' }));
  cleanup(keymap.bind('mod+k', () => menu.set(!menu()), { when: 'always' }));
  const submit = () => {
    const text = draft().trim();
    if (!text || busy()) return;
    draft.set('');
    followAnswer = true;
    void question.ask(text, question.thread());
  };
  let scroll: ScrollRef | undefined;
  let followAnswer = true;
  const rows = () =>
    (question.thread()?.turns ?? []).flatMap((turn, i) =>
      (
        [
          ['user', turn.question],
          ['assistant', turn.answer],
        ] as const
      )
        .filter(([, text]) => text.length > 0)
        .map(([role, text]) => ({
          key: i + '-' + role,
          role,
          text,
          field: 'body',
          replyInfo: role === 'assistant' ? turn.replyInfo : undefined,
        })),
    );
  return (
    <View style={{ backgroundColor: C.panel, borderRadius: 12, overflow: 'hidden' }}>
      <View style={{ ...quickBarStyle, alignItems: 'center', gap: 8 }}>
        <MakaMark />
        <Input
          autoFocus
          accessibilityLabel={tr('Quick question')}
          placeholder={tr('Ask a follow-up')}
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          onSubmit={submit}
          style={{ ...quickInputStyle(), flex: 1 }}
        />
        <If when={question.running()}>
          <IconButton label={tr('Stop')} icon="stop" onPress={question.stop} />
        </If>
      </View>
      <Scroll
        ref={(node) => {
          scroll = node;
        }}
        style={{ height: 300 }}
        onScroll={({ offset, contentSize, size }) => {
          followAnswer = offset.y >= contentSize.height - size.height - 48;
        }}
      >
        <View
          onLayout={() => {
            if (followAnswer) scroll?.scrollToEnd({ animated: false });
          }}
          style={{ paddingHorizontal: 16, paddingBottom: 12 }}
        >
          <Each of={rows()} key={(row) => row.key}>
            {(row) => (
              <MessageRow
                item={row}
                sessionId={question.thread()!.id}
                through={() => 0}
                previewImage={() => {}}
                toolMaxHeight={() => 300}
                userScroll={() => {}}
                openLink={async (target) => {
                  if (/^https?:\/\//i.test(target)) await openUrl(target);
                }}
              />
            )}
          </Each>
          <If when={question.running() && !question.thread()?.turns.at(-1)?.answer}>
            <Text style={{ color: C.muted }}>{tr('Generating answer…')}</Text>
          </If>
          <If when={!!question.error()}>
            <Text style={{ color: C.warning }}>{question.error()}</Text>
          </If>
        </View>
      </Scroll>
      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: 12,
          height: 32,
          alignItems: 'center',
          borderTopWidth: 1,
          borderColor: C.line,
        }}
      >
        <Button onPress={back}>
          <Text style={{ color: C.secondary }}>{tr('Back')}</Text>
        </Button>
        <View style={{ flex: 1 }} />
        <Menu
          open={menu()}
          onOpenChange={({ open }) => menu.set(open)}
          placement="top"
          align="end"
          popupStyle={{ ...floatingStyle(), width: 224 }}
          trigger={
            <Button accessibilityLabel={tr('Launcher actions')}>
              <Text style={{ color: C.secondary }}>
                {tr('Launcher actions')} {keymap.label('mod+k')}
              </Text>
            </Button>
          }
        >
          <MenuItem
            disabled={busy()}
            style={menuRowStyle()}
            hoverStyle={menuRowHoverStyle()}
            onSelect={() => {
              menu.set(false);
              props.promote();
            }}
          >
            <Text style={{ color: C.text }}>{tr('Continue as a conversation')}</Text>
          </MenuItem>
        </Menu>
      </View>
    </View>
  );
}
