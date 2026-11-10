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

import { host } from 'maka/host';
import { cleanup, platform, signal, Text, View, type JSX, type Signal } from 'nsh';
import { Button, Input } from 'nsh/base';
import { GlobalShortcut, Window, currentWindow } from 'nsh/desktop';
import { loadDraft, saveDraft, type Output } from './host';
import { MakaMark, QUICK_BAR_SLOT, quickBarStyle, quickInputStyle } from './QuickBar';
import { tr } from './locale';
import { errorText, renderText } from './text';
import { C, bodyTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

const SHORTCUT = 'alt+space';
const MAX_HEIGHT = 560;

type BotOutbox = Output<'agent', 'botOutbox'>;

type Navigation = {
  openBot(): Promise<string>;
  /** Takes the conversation out of the panes showing it, which saves their draft. */
  vacate(sessionId: string): Promise<boolean>;
  /** `message` goes out once the conversation can send; it must have no draft. */
  open(sessionId: string, message?: string): Promise<void>;
};

const frameStyle = {
  backgroundColor: C.surface,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: C.line,
  overflow: 'hidden',
} as const;

const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** The Bot's newest unread message, for as long as the launcher shows. */
function watchUnread(fail: (reason: unknown) => void) {
  const unread = signal<{ preview: string; at: number } | null>(null);
  let alive = true;
  let stream: { next(): Promise<unknown>; close(): Promise<void> } | undefined;
  cleanup(() => {
    alive = false;
    void stream?.close().catch(fail);
  });
  void (async () => {
    stream = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
    if (!alive) return void (await stream.close());
    for (;;) {
      const head = (await stream.next()) as BotOutbox | null;
      if (!alive || head === null) return;
      if (!head.isBot || head.through <= head.readThrough) {
        unread.set(null);
        continue;
      }
      const page = (await host.query('agent', 'botOutbox', {
        after: head.through - 1,
        limit: 1,
      })) as BotOutbox;
      if (!alive) return;
      unread.set({ preview: head.preview, at: page.messages[0]!.at });
    }
  })().catch((reason) => {
    if (alive) fail(reason);
  });
  return unread;
}

function Launcher(props: Navigation) {
  // A window that does not activate leaves the keyboard with the app in use until focused.
  currentWindow().focus();
  const query = signal('');
  const failure = signal<ReturnType<typeof errorText> | null>(null);
  const unread = watchUnread((reason) => failure.set(errorText(reason)));
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    failure.set(null);
    try {
      const sessionId = await props.openBot();
      const submitted = query();
      const text = submitted.trim();
      if (!text) {
        await props.open(sessionId);
        return;
      }
      if (!(await props.vacate(sessionId))) return;
      const session = host.session(sessionId);
      const draft = await loadDraft(session);
      // A saved draft is unfinished work and a slash command needs the composer: neither is sent.
      if (draft.text === '' && draft.attachments.length === 0 && !text.startsWith('/')) {
        await props.open(sessionId, text);
        return;
      }
      await saveDraft(session, draft.revision, {
        text: draft.text.trim() ? `${draft.text}\n\n${text}` : text,
        attachments: draft.attachments,
      });
      // The draft holds it now; a retry after refused navigation must not append it again.
      if (query().startsWith(submitted)) query.set(query().slice(submitted.length));
      await props.open(sessionId);
    } catch (reason) {
      failure.set(errorText(reason));
    } finally {
      running = false;
    }
  };
  return (
    <View style={frameStyle}>
      <View style={quickBarStyle}>
        <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
          <MakaMark />
        </View>
        <Input
          autoFocus
          accessibilityLabel={tr('Ask Maka')}
          placeholder={tr('Ask Maka')}
          value={query()}
          onChange={({ value }) => query.set(value)}
          onSubmit={() => void run()}
          style={{ ...quickInputStyle(), flex: 1, minWidth: 0, marginTop: 8 }}
        />
      </View>
      <If when={unread() !== null && query() === ''}>
        <Button
          accessibilityLabel={`Maka Bot: ${unread()!.preview}`}
          onPress={() => void run()}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: C.line,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <MakaMark />
          <Text style={{ ...bodyTextStyle, flexShrink: 0, fontWeight: '600', color: C.text }}>
            Maka Bot
          </Text>
          <Text
            style={{
              ...bodyTextStyle,
              flex: 1,
              minWidth: 0,
              color: C.secondary,
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {unread()!.preview}
          </Text>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              flexShrink: 0,
              backgroundColor: C.accent,
            }}
          />
          <Text style={{ fontSize: 12, lineHeight: 18, flexShrink: 0, color: C.muted }}>
            {clock(unread()!.at)}
          </Text>
        </Button>
      </If>
      <If when={failure() !== null}>
        <Text
          style={[
            { ...bodyTextStyle, paddingVertical: 8, paddingLeft: 42, paddingRight: 12 },
            { color: C.warning, userSelect: 'text' },
          ]}
        >
          {renderText(failure()!)}
        </Text>
      </If>
    </View>
  );
}

/** A popup from the app's one engine; it never activates Maka over the app in use. */
export function QuickLauncher(
  props: Navigation & {
    opened: Signal<boolean>;
    conversing(): boolean;
    conversation(): JSX.Element;
    /** Closes the popup once a conversation in it has saved its draft. */
    close(): Promise<boolean>;
    closed(): void;
    report(reason: unknown): void;
  },
) {
  const toggle = () => {
    if (props.opened()) void props.close();
    else props.opened.set(true);
  };
  void GlobalShortcut.register(SHORTCUT, toggle).then((registered) => {
    if (!registered)
      props.report(
        new Error(
          platform.os === 'macos'
            ? tr('The Option+Space shortcut is unavailable')
            : tr('The Alt+Space shortcut is unavailable'),
        ),
      );
  }, props.report);
  cleanup(() => GlobalShortcut.unregister(SHORTCUT));
  return (
    <Window
      id="quick-launcher"
      kind="popup"
      title={tr('Ask Maka')}
      activate={false}
      level="aboveDock"
      transparent
      defaultPosition="center"
      defaultSize={{ width: 640, height: 112 }}
      sizeToContent="height"
      // Escape stops a running reply, and every way out has to save the draft first.
      closeOnEscape={!props.conversing()}
      closeOnBlur={!props.conversing()}
      closeOnPress={!props.conversing()}
      onClosePress={() => void props.close()}
      open={props.opened()}
      onOpenChange={({ open }) => {
        if (!open) props.closed();
      }}
    >
      <If
        when={props.conversing()}
        else={<Launcher openBot={props.openBot} vacate={props.vacate} open={props.open} />}
      >
        <View style={[frameStyle, { maxHeight: MAX_HEIGHT }]}>{props.conversation()}</View>
      </If>
    </Window>
  );
}
