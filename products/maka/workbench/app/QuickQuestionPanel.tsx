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

import { Clipboard, cleanup, keymap, Scroll, signal, Text, View, type ScrollRef } from 'nsh';
import { Button, Input, TextView } from 'nsh/base';
import { MakaMark, quickBarStyle, quickInputStyle } from './QuickBar';
import type { createQuickQuestion } from './quickQuestion';
import { tr } from './locale';
import { C, bodyTextStyle } from './ui';

export function QuickQuestionPanel(props: {
  question: ReturnType<typeof createQuickQuestion>;
  back(): void;
}) {
  const draft = signal('');
  const { question } = props;
  const back = () => {
    if (question.running()) question.stop();
    else props.back();
  };
  cleanup(keymap.bind('escape', back, { when: 'always' }));
  const submit = () => {
    const text = draft().trim();
    if (!text || question.running()) return;
    draft.set('');
    followAnswer = true;
    void question.ask(text, question.turns().length > 0);
  };
  let scroll: ScrollRef | undefined;
  let followAnswer = true;
  const error = signal('');
  return (
    <View style={{ backgroundColor: C.panel, borderRadius: 12, overflow: 'hidden' }}>
      <View style={{ ...quickBarStyle, alignItems: 'center' }}>
        <MakaMark />
        <Input
          autoFocus
          accessibilityLabel={tr('Quick question')}
          placeholder={question.turns().length ? tr('Ask a follow-up') : tr('Ask a question')}
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          onSubmit={submit}
          style={{ ...quickInputStyle(), flex: 1 }}
        />
      </View>
      <Scroll
        ref={(node) => {
          scroll = node;
        }}
        style={{ height: question.turns().length ? 300 : 0 }}
        onScroll={({ offset, contentSize, size }) => {
          followAnswer = offset.y >= contentSize.height - size.height - 48;
        }}
      >
        <View
          onLayout={() => {
            if (followAnswer) scroll?.scrollToEnd({ animated: false });
          }}
          style={{ padding: 16, gap: 12 }}
        >
          <Each of={question.turns()} key={(_, i) => String(i)}>
            {(turn) => (
              <View style={{ gap: 12 }}>
                <Text
                  style={{
                    ...bodyTextStyle,
                    alignSelf: 'flex-end',
                    maxWidth: '85%',
                    padding: 8,
                    borderRadius: 8,
                    backgroundColor: C.raised,
                    color: C.text,
                  }}
                >
                  {turn().question}
                </Text>
                <If
                  when={!!turn().answer}
                  else={
                    <Text style={{ color: C.muted }}>
                      {question.running() ? tr('Generating answer…') : ''}
                    </Text>
                  }
                >
                  <TextView
                    markdown={turn().answer}
                    selectable
                    options={{ preserveLineBreaks: true }}
                  />
                </If>
              </View>
            )}
          </Each>
          <If when={!!(question.error() || error())}>
            <Text style={{ color: C.warning }}>{question.error() || error()}</Text>
          </If>
        </View>
      </Scroll>
      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: 12,
          height: 32,
          gap: 12,
          alignItems: 'center',
          borderTopWidth: 1,
          borderTopColor: C.line,
        }}
      >
        <Button onPress={props.back}>
          <Text style={{ color: C.secondary }}>{tr('Back')}</Text>
        </Button>
        <View style={{ flex: 1 }} />
        <If
          when={question.running()}
          else={
            <If when={!!question.turns().at(-1)?.answer}>
              <Button
                onPress={() => {
                  void Clipboard.writeText(question.turns().at(-1)!.answer).catch((reason) =>
                    error.set(String(reason)),
                  );
                }}
              >
                <Text style={{ color: C.secondary }}>{tr('Copy')}</Text>
              </Button>
            </If>
          }
        >
          <Button onPress={question.stop}>
            <Text style={{ color: C.secondary }}>{tr('Stop generating')}</Text>
          </Button>
        </If>
      </View>
    </View>
  );
}
