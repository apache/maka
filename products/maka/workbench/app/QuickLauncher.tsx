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
import {
  cleanup,
  computed,
  effect,
  keymap,
  platform,
  Scroll,
  signal,
  Text,
  View,
  type JSX,
  type ScrollRef,
  type Signal,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import { GlobalShortcut, Window, currentWindow } from 'nsh/desktop';
import type {
  UiContributionRef,
  UiRuntime,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { loadDraft, saveDraft, type Output } from './host';
import {
  MakaMark,
  QUICK_BAR_SLOT,
  QUICK_ROW_HEIGHT,
  QuickRow,
  quickBarStyle,
  quickInputStyle,
  quickRowStyle,
} from './QuickBar';
import { tr } from './locale';
import { errorText, renderText } from './text';
import { C, bodyTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

const SHORTCUT = 'alt+space';
const MAX_HEIGHT = 560;
const VISIBLE_TOOL_ROWS = 8;

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

function Launcher(
  props: Navigation & { runtime: UiRuntime<JSX.Element>; close(): Promise<boolean> },
) {
  // A window that does not activate leaves the keyboard with the app in use until focused.
  currentWindow().focus();
  const query = signal('');
  const failure = signal<ReturnType<typeof errorText> | null>(null);
  const unread = watchUnread((reason) => failure.set(errorText(reason)));
  const tools = computed(() =>
    props.runtime
      .contributions()
      .filter(
        (item) =>
          item.declaration.kind === 'view' && item.declaration.contract === quickToolView.id,
      ),
  );
  const handles = signal<ReadonlyMap<string, QuickToolHandle>>(new Map());
  const counts = computed(() =>
    tools().map((tool) => ({ key: tool.key, rows: handles().get(tool.key)?.rows() ?? 0 })),
  );
  const toolRows = computed(() => counts().reduce((sum, tool) => sum + tool.rows, 0));
  // Past every tool's rows is the row that asks the Bot.
  const selection = signal(0);
  const selected = computed(() => Math.min(selection(), toolRows()));
  const locate = (index: number) => {
    let offset = 0;
    for (const tool of counts()) {
      if (index < offset + tool.rows) return { key: tool.key, row: index - offset };
      offset += tool.rows;
    }
    return null;
  };
  const toolView = (tool: UiContributionRef) => {
    cleanup(() => {
      const remaining = new Map(handles());
      remaining.delete(tool.key);
      handles.set(remaining);
    });
    return props.runtime.renderView({ path: tool.instance.path, id: tool.id }, quickToolView, {
      query,
      selected: () => {
        const location = locate(selected());
        return location?.key === tool.key ? location.row : null;
      },
      close: () => void props.close(),
      report: (reason) => failure.set(errorText(reason)),
      attach: (handle) => handles.set(new Map(handles()).set(tool.key, handle)),
    });
  };
  const listHeight = computed(() => Math.min(toolRows(), VISIBLE_TOOL_ROWS) * QUICK_ROW_HEIGHT);
  let list: ScrollRef | undefined;
  let scrolled = 0;
  const reveal = (y: number) => {
    scrolled = y;
    list?.scrollTo({ y, animated: false });
  };
  effect(() => {
    const index = selected();
    if (index >= toolRows()) return;
    const top = index * QUICK_ROW_HEIGHT;
    const bottom = top + QUICK_ROW_HEIGHT;
    if (top < scrolled) reveal(top);
    else if (bottom > scrolled + listHeight()) reveal(bottom - listHeight());
  });
  let removeKeys = () => {};
  cleanup(() => removeKeys());
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
  const activate = () => {
    const location = locate(selected());
    if (location === null) void run();
    else handles().get(location.key)!.activate(location.row);
  };
  return (
    <View style={frameStyle}>
      <View style={quickBarStyle}>
        <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
          <MakaMark />
        </View>
        <Input
          ref={(node) => {
            removeKeys();
            const unbind = [
              keymap.bind('up', () => selection.set(Math.max(0, selected() - 1)), {
                when: 'always',
                repeat: true,
                within: node,
              }),
              keymap.bind('down', () => selection.set(Math.min(toolRows(), selected() + 1)), {
                when: 'always',
                repeat: true,
                within: node,
              }),
            ];
            removeKeys = () => unbind.forEach((remove) => remove());
          }}
          autoFocus
          accessibilityLabel={tr('Ask Maka')}
          placeholder={tr('Ask Maka')}
          value={query()}
          onChange={({ value }) => {
            selection.set(0);
            query.set(value);
          }}
          onSubmit={activate}
          style={{ ...quickInputStyle(), flex: 1, minWidth: 0, marginTop: 8 }}
        />
      </View>
      <View style={{ borderTopWidth: toolRows() > 0 ? 1 : 0, borderTopColor: C.line }}>
        <Scroll
          ref={(node) => {
            list = node;
          }}
          onScroll={({ offset }) => {
            scrolled = offset.y;
          }}
          style={{ height: listHeight() }}
        >
          <Each of={tools()} key={(tool: UiContributionRef) => tool.key}>
            {(tool) => toolView(tool())}
          </Each>
        </Scroll>
        <If when={toolRows() > 0}>
          <QuickRow
            label={tr('Ask Maka')}
            title={tr('Ask Maka')}
            icon={<MakaMark />}
            selected={selected() === toolRows()}
            onPress={() => void run()}
          />
        </If>
      </View>
      <If when={unread() !== null && query() === ''}>
        <Button
          accessibilityLabel={`Maka Bot: ${unread()!.preview}`}
          onPress={() => void run()}
          style={{ ...quickRowStyle, borderTopWidth: 1, borderTopColor: C.line }}
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
    runtime: UiRuntime<JSX.Element>;
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
        else={
          <Launcher
            openBot={props.openBot}
            vacate={props.vacate}
            open={props.open}
            close={props.close}
            runtime={props.runtime}
          />
        }
      >
        <View style={[frameStyle, { maxHeight: MAX_HEIGHT }]}>{props.conversation()}</View>
      </If>
    </Window>
  );
}
