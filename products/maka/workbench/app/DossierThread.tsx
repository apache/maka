/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { cleanup, inputAction, Scroll, signal, Text, View, type ScrollRef } from 'nsh';
import { Input } from 'nsh/base';
import { useHost } from './host';
import { mergeHistoryPage, recentMessages } from './history';
import { observeDiscovery } from './discoveryObservation';
import { SettingsButton } from './SettingsPage';
import { tr } from './locale';
import { createText, errorText, UiError } from './text';
import { C, captionTextStyle, inputTextStyle, secondaryTextStyle } from './ui';

function RecentTurns(props: { sessionId: string }) {
  const host = useHost();
  const sessionId = props.sessionId;
  const turns = signal<ReturnType<typeof recentMessages>>([]);
  const error = createText();
  let alive = true;
  let through = 0;
  let scroll: ScrollRef | undefined;
  const tail = async () => {
    const page = await host.query('agent', 'history', {
      sessionId,
      position: { kind: 'tail' },
      view: 'chat',
      includeThinking: false,
    });
    if (page.kind !== 'ready') throw new UiError('Could not load conversation history.');
    if (alive) {
      through = page.through ?? 0;
      turns.set(
        recentMessages(mergeHistoryPage(page.chunks, () => undefined, false, page.through)),
      );
      error.set('');
    }
  };
  const stop = observeDiscovery(
    async () => {
      await tail();
      return host.subscribe('agent', 'watch', { sessionId, after: through });
    },
    async (update) => {
      if (
        update.kind === 'events' &&
        update.events.some(
          ({ sequence, fact }) =>
            sequence > through &&
            (fact.kind === 'opened' ||
              fact.kind === 'part_committed' ||
              fact.kind === 'ended' ||
              fact.kind === 'executor_text_changed' ||
              fact.kind === 'transcript_changed'),
        )
      )
        await tail();
    },
    (reason) => error.set(errorText(reason, 'Could not load conversation history.')),
  );
  cleanup(() => {
    alive = false;
    stop();
  });
  return (
    <>
      <If when={turns().length > 0}>
        <Scroll
          ref={(node) => {
            scroll = node;
          }}
          style={{ maxHeight: 146, flexShrink: 1 }}
        >
          <View style={{ gap: 5 }} onLayout={() => scroll?.scrollToEnd({ animated: false })}>
            <Each of={turns()} key={(turn) => turn.id}>
              {(turn) => (
                <View
                  style={{
                    alignSelf: turn().role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '92%',
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 8,
                    backgroundColor: turn().role === 'user' ? C.card : undefined,
                  }}
                >
                  <Text
                    style={[
                      { ...secondaryTextStyle, color: C.text, userSelect: 'text' },
                      { numberOfLines: 3 },
                    ]}
                  >
                    {turn().text}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>
      <If when={error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </>
  );
}

export function DossierThread(props: {
  topicId: string;
  threadSessionId(): string | null;
  openSession(id: string): void;
}) {
  const host = useHost();
  const topicId = props.topicId;
  const draft = signal('');
  const sending = signal(false);
  const opened = signal<string | null>(null);
  const session = () => props.threadSessionId() ?? opened();
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const send = async () => {
    const message = draft().trim();
    if (!alive || !message || sending()) return;
    sending.set(true);
    error.set('');
    try {
      let sessionId = session();
      if (sessionId === null) {
        const thread = await host.mutateAgent('openDossierThread', { topicId });
        sessionId = thread.sessionId;
        if (alive) opened.set(sessionId);
      }
      const result = await host.mutateAgent('send', { sessionId, message, delivery: 'steer' });
      if (result.kind === 'rejected') {
        const reasons = {
          model_unavailable: 'Selected model is unavailable',
          skills_unavailable: 'Requested skills are unavailable',
          turn_stopped: 'The turn was stopped before delivery',
          original_operation_unsettled: 'The original send is still being resolved',
        } as const;
        throw new UiError(reasons[result.reason]);
      }
      if (result.sessionId !== sessionId || (result.kind !== 'started' && result.kind !== 'queued'))
        throw new UiError('Host returned an unexpected send result.');
      if (alive) draft.set('');
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not send the message.'));
    } finally {
      if (alive) sending.set(false);
    }
  };
  return (
    <View style={{ gap: 6, borderTopWidth: 1, borderColor: C.line, padding: 12 }}>
      <Each of={session() ? [session()!] : []} key={(id) => id}>
        {(id) => (
          <>
            <View style={{ alignSelf: 'flex-end' }}>
              <SettingsButton
                label={tr('Open full thread')}
                tone="quiet"
                onPress={inputAction(props.openSession, id())}
              />
            </View>
            <RecentTurns sessionId={id()} />
          </>
        )}
      </Each>
      <If when={error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Input
          accessibilityLabel={tr('Reply to this dossier')}
          placeholder={tr('Reply to this dossier')}
          value={draft()}
          onChange={({ value }) => draft.set(value)}
          readonly={sending()}
          onSubmit={() => void send()}
          submitBehavior="submit"
          style={{
            ...inputTextStyle,
            flex: 1,
            minWidth: 0,
            height: 32,
            paddingHorizontal: 9,
            color: C.text,
            placeholderColor: C.muted,
            backgroundColor: C.background,
            borderRadius: 7,
            borderWidth: 1,
            borderColor: C.line,
          }}
          focusStyle={{ borderColor: C.accent }}
        />
        <SettingsButton
          label={tr('Send')}
          onPress={() => void send()}
          disabled={sending() || !draft().trim()}
        />
      </View>
    </View>
  );
}
