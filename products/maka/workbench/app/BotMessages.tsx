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

import { cleanup, inputAction, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  ComposerBotOutbox,
  ComposerBotSource,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { tr } from './locale';
import { createText, UiError, errorText } from './text';
import { C, bodyTextStyle, captionTextStyle } from './ui';
import { Icon } from './Icon';

type BotMessage = ComposerBotOutbox['messages'][number];
/** Collapsed view keeps the conversation in focus and shows only the newest messages. */
const LATEST = 3;

/**
 * Messages the Bot deliberately sent with `SendUser`, shown above the composer of
 * the Bot Session only. Ordinary model output stays in the transcript.
 */
export function BotMessages(props: { sessionId: string; source: ComposerBotSource }) {
  const messages = signal<BotMessage[]>([]);
  const all = signal(false);
  const error = createText();
  let alive = true;
  let stream: { close(): Promise<void> } | null = null;
  cleanup(() => {
    alive = false;
    const previous = stream;
    stream = null;
    if (previous) void previous.close().catch(() => {});
  });
  void (async () => {
    try {
      const opened = await props.source.watch();
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const page: ComposerBotOutbox | null = await opened.next();
        if (!alive) return;
        if (page === null) throw new UiError('Bot updates ended. Reopen the conversation.');
        messages.set(page.enabled && page.sessionId === props.sessionId ? page.messages : []);
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    }
  })();
  const shown = () => (all() ? messages() : messages().slice(-LATEST));
  const toggle = () => all.set(!all());
  return (
    <If when={messages().length > 0 || !!error()}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="activity" color={C.accent} />
          <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
            {tr('Messages from your Bot')}
          </Text>
          <If when={messages().length > LATEST}>
            <Button onPress={inputAction(toggle, null)}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {all() ? tr('Show latest') : tr('Show all {count}', { count: messages().length })}
              </Text>
            </Button>
          </If>
        </View>
        <Each of={shown()} key={(message) => String(message.sequence)}>
          {(message) => (
            <Text style={[{ ...bodyTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
              {message().text}
            </Text>
          )}
        </Each>
        <If when={!!error()}>
          <Text style={[{ color: C.danger }, { numberOfLines: 1 }]}>{error()}</Text>
        </If>
      </View>
    </If>
  );
}
