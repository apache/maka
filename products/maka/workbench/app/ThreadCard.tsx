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

import { cleanup, effect, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { PendingThread } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { Icon } from './Icon';
import { tr } from './locale';
import { quickBarStyle, quickInputStyle, QUICK_BAR_SLOT } from './QuickBar';
import { QuoteBlock } from './QuoteBlock';
import { quotePassages, sideName } from './sideThreads';
import { splitQuotes } from './quotedPassages';
import { errorText, renderText } from './text';
import { bodyTextStyle, C, captionTextStyle, IconButton } from './ui';
import { BotWorking } from './BotReply';

const MAX_INPUT_HEIGHT = 96;
// The room a sent message keeps under it for its actions.
const MESSAGE_ACTIONS_HEIGHT = 36;

/** The frame of a side question's card. */
export const threadCardStyle = () =>
  ({
    flexShrink: 1,
    minHeight: 0,
    // Beside the conversation, in the tone of what stands beside it (the
    // sidebar's); what is said inside steps back up to the panel's.
    backgroundColor: C.chrome,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    overflow: 'hidden',
  }) as const;

/** The row a side question card's input stands in, under what was asked in it. */
export const threadInputRowStyle = () =>
  ({ ...quickBarStyle, minHeight: 0, paddingVertical: 4 }) as const;

/** A side question card's first row: what it is, and the ways out of it. */
export function ThreadHeader(props: { title(): string; expand?(): void; close(): void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 40,
        paddingLeft: 12,
        paddingRight: 4,
      }}
    >
      <Icon name="ask" color={C.muted} size={14} />
      <Text
        style={[
          { ...captionTextStyle, flex: 1, minWidth: 0, color: C.secondary, fontWeight: '600' },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {sideName(props.title()) || tr('Side question')}
      </Text>
      <If when={props.expand !== undefined}>
        <IconButton label={tr('Open as a conversation')} icon="expand" onPress={props.expand!} />
      </If>
      <IconButton label={tr('Close side question')} icon="close" onPress={props.close} />
    </View>
  );
}

// A question that could not be sent at once says why, instead of looking busy.
const notSentAfter = 3000;

/**
 * A question that reads as sent while it waits to be: its passages as quotes,
 * its text, and work under way, where the sent message will stand.
 */
export function AskedQuestion(props: {
  text(): string;
  /** Why the question has not been sent yet, or '' while it is being sent. */
  waiting?(): string;
}) {
  const parts = () => splitQuotes(props.text());
  const shown = Date.now();
  const late = signal(false);
  effect(() => {
    const timer = setTimeout(() => late.set(true), Math.max(0, shown + notSentAfter - Date.now()));
    cleanup(() => clearTimeout(timer));
  });
  const reason = () => (late() ? (props.waiting?.() ?? '') : '');
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '78%',
          marginBottom: MESSAGE_ACTIONS_HEIGHT + 16,
          paddingHorizontal: 16,
          paddingVertical: 16,
          borderRadius: 20,
          backgroundColor: C.panel,
          gap: 8,
        }}
      >
        <Each of={parts().quotes} key={(_, index) => index}>
          {(quote) => <QuoteBlock text={quote()} lines={4} />}
        </Each>
        <If when={parts().body.trim() !== ''}>
          <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
            {parts().body}
          </Text>
        </If>
      </View>
      <If when={reason()} else={<BotWorking detail={() => ''} />}>
        <View
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 8 }}
        >
          <Icon name="statusPending" color={C.muted} />
          <Text
            style={[{ ...captionTextStyle, color: C.secondary, flex: 1 }, { userSelect: 'text' }]}
          >
            {tr('Not sent yet: {reason}', { reason: reason() })}
          </Text>
        </View>
      </If>
    </View>
  );
}

/**
 * A side question's card while its conversation is being created: it takes the
 * question at once, and hands it over when the conversation exists.
 */
export function PendingThreadCard(props: {
  thread: PendingThread;
  /** The conversation exists and the question was asked: show it with that as its first message. */
  open(sessionId: string, question: string): void;
  close(): void;
}) {
  const text = signal(props.thread.draft);
  const asked = signal(false);
  const failure = signal('');
  const inputHeight = signal<number>(bodyTextStyle.lineHeight);
  props.thread.ready.catch((reason) =>
    failure.set(renderText(errorText(reason, 'Could not fork the conversation.'))),
  );
  const quotes = props.thread.quotes;
  const empty = () => text().trim() === '' && quotes.length === 0;
  const ask = () => {
    if (asked() || failure() !== '' || empty()) return;
    asked.set(true);
    // The model reads the passages as quotes above the question.
    const question = quotePassages(quotes) + text();
    props.thread.ready.then(
      (sessionId) => props.open(sessionId, question),
      () => asked.set(false),
    );
  };
  return (
    <View style={threadCardStyle()}>
      <ThreadHeader title={() => props.thread.title ?? ''} close={props.close} />
      {/* Asked before the conversation exists: it reads as sent, and is sent when it does. */}
      <If when={asked()}>
        <AskedQuestion text={() => quotePassages(quotes) + text()} />
      </If>
      {/* What is asked about stands above the input, apart from the question. */}
      <If when={!asked() && quotes.length > 0}>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, gap: 8 }}>
          <Each of={quotes} key={(_, index) => index}>
            {(quote) => <QuoteBlock text={quote()} />}
          </Each>
        </View>
      </If>
      <View style={{ borderTopWidth: 1, borderTopColor: C.line }}>
        <View style={threadInputRowStyle()}>
          <View style={{ flex: 1, minWidth: 0, paddingVertical: 8 }}>
            <Input
              autoFocus
              multiline
              submitBehavior="submit"
              accessibilityLabel={tr('Ask in the side question')}
              placeholder={tr('Ask about this')}
              value={asked() ? '' : text()}
              readonly={asked()}
              onChange={({ value }) => text.set(value)}
              onSubmit={ask}
              onContentSizeChange={({ size }) =>
                inputHeight.set(Math.min(size.height, MAX_INPUT_HEIGHT))
              }
              style={{ ...quickInputStyle(), ...bodyTextStyle, height: inputHeight() }}
            />
          </View>
          <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
            <IconButton
              label={tr('Send message')}
              icon="send"
              disabled={asked() || failure() !== '' || empty()}
              onPress={ask}
            />
          </View>
        </View>
        <If when={failure() !== ''}>
          <Text
            style={[
              { ...captionTextStyle, paddingHorizontal: 16, paddingBottom: 8 },
              { color: C.danger, userSelect: 'text' },
            ]}
          >
            {failure()}
          </Text>
        </If>
      </View>
    </View>
  );
}
