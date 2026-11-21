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

import { cleanup, keymap, List, openUrl, signal, Text, View, type ListRef } from 'nsh';
import { Button, Menu, MenuItem } from 'nsh/base';
import { compactTranscriptSize, CompactInputBar } from './QuickBar';
import type { createQuickQuestion } from './quickQuestion';
import { MessageRow } from './MessageRow';
import { BotWorking } from './BotReply';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  C,
  controlStyle,
  floatingStyle,
  menuRowStyle,
  menuRowHoverStyle,
  IconButton,
  quietHoverStyle,
  quietFocusStyle,
} from './ui';

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
    list?.scrollToEnd({ animated: false });
    void question.ask(text, question.thread());
  };
  let list: ListRef | undefined;
  const transcriptSize = compactTranscriptSize();
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
          key: question.thread()!.id + '/' + i + '-' + role,
          timestamp: role === 'assistant' ? turn.answeredAt : turn.askedAt,
          role,
          text,
          field: 'body',
          replyInfo: role === 'assistant' ? turn.replyInfo : undefined,
        })),
    );
  const listHeight = () => {
    const current = rows();
    return transcriptSize.height(current.length, (index) => current[index]!.key);
  };
  return (
    <View style={{ flexShrink: 1, minHeight: 0 }}>
      <CompactInputBar
        label={tr('Quick question')}
        placeholder={tr('Ask a follow-up')}
        value={draft()}
        change={(value) => draft.set(value)}
        submit={submit}
        actions={
          <>
            <If when={question.running()}>
              <IconButton label={tr('Stop')} icon="stop" onPress={question.stop} />
            </If>
            <Menu
              open={menu()}
              onOpenChange={({ open }) => menu.set(open)}
              placement="bottom"
              align="end"
              popupStyle={{ ...floatingStyle(), width: 224 }}
              trigger={
                <Button
                  accessibilityLabel={tr('Launcher actions')}
                  style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
                  hoverStyle={quietHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="more" color={C.secondary} />
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
              <MenuItem
                disabled={busy()}
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                onSelect={() => {
                  menu.set(false);
                  props.back();
                }}
              >
                <Text style={{ color: C.text }}>{tr('Back')}</Text>
              </MenuItem>
            </Menu>
          </>
        }
      />
      <View style={{ flexShrink: 1, minHeight: 0, borderTopWidth: 1, borderTopColor: C.line }}>
        <List
          ref={list}
          each={rows()}
          keyExtractor={(row) => row.key}
          alignment="bottom"
          estimatedItemSize={96}
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 32 }}
          style={{ height: listHeight(), flexShrink: 1, minHeight: 0 }}
          contentStyle={{ paddingVertical: 16, paddingHorizontal: 16 }}
        >
          {(row) => (
            <View onLayout={({ bounds }) => transcriptSize.measure(row().key, bounds.size.height)}>
              <MessageRow
                item={row}
                compactChat
                localQuickReply
                sessionId={question.thread()!.id}
                through={() => 0}
                previewImage={() => {}}
                toolMaxHeight={() => 400}
                userScroll={() => {}}
                openLink={async (target) => {
                  if (/^https?:\/\//i.test(target)) await openUrl(target);
                }}
              />
            </View>
          )}
        </List>
        <If when={question.running() && !question.thread()?.turns.at(-1)?.answer}>
          <View style={{ paddingHorizontal: 16 }}>
            <BotWorking detail={() => ''} />
          </View>
        </If>
        <If when={!!question.error()}>
          <Text style={{ paddingHorizontal: 16, paddingVertical: 8, color: C.warning }}>
            {question.error()}
          </Text>
        </If>
      </View>
    </View>
  );
}
