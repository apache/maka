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
  Storage,
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
  type QuickIcon,
  type QuickToolHandle,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { afterKeyword, matchOf } from '../../../../plugins/shared/quick-search';
import { loadDraft, saveDraft, type Output } from './host';
import {
  MakaMark,
  QUICK_BAR_SLOT,
  QUICK_ROW_HEIGHT,
  QUICK_SECTION_HEIGHT,
  QuickFooter,
  QuickRow,
  QuickSectionTitle,
  quickBarStyle,
  quickInputStyle,
} from './QuickBar';
import { tr } from './locale';
import {
  isFrequent,
  parseUsage,
  ranked,
  recommended,
  recordUse,
  type Usage,
} from './quick-results';
import { errorText, renderText } from './text';
import { C, bodyTextStyle } from './ui';

const SHORTCUT = 'alt+space';
const MAX_HEIGHT = 560;
const MAX_LIST_HEIGHT = 360;
const USAGE_KEY = 'maka.quick-launcher.usage';

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

type UsageStore = { current(): Usage; record(key: string): void };

function createUsageStore(report: (reason: unknown) => void): UsageStore {
  const usage = signal<Usage>({});
  Storage.getItem(USAGE_KEY)
    .then((stored) => usage.set(parseUsage(stored)))
    .catch(report);
  let saving: Promise<void> = Promise.resolve();
  return {
    current: usage,
    record(key) {
      const next = recordUse(usage(), key, Date.now());
      usage.set(next);
      const value = JSON.stringify(next);
      saving = saving.then(() => Storage.setItem(USAGE_KEY, value)).catch(report);
    },
  };
}

type Row = {
  key: string;
  icon: QuickIcon | 'maka';
  image?: (() => string | undefined) | undefined;
  title: string;
  detail?: string | undefined;
  trailing?: string | undefined;
  unread?: boolean;
  action: string;
  run(): void;
};

type Section = { key: string; title: string | null; rows: readonly Row[]; start: number };

function LauncherRow(props: { row: Row; selected: boolean }) {
  return (
    <QuickRow
      label={`${props.row.action} ${props.row.title}`}
      title={props.row.title}
      detail={props.row.detail}
      trailing={props.row.trailing}
      icon={props.row.icon}
      image={props.row.image?.()}
      unread={props.row.unread === true}
      selected={props.selected}
      onPress={props.row.run}
    />
  );
}

function Launcher(
  props: Navigation & {
    runtime: UiRuntime<JSX.Element>;
    close(): Promise<boolean>;
    usage: UsageStore;
  },
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
  const attached = () =>
    tools().flatMap((tool) => {
      const handle = handles().get(tool.key);
      return handle === undefined ? [] : [{ tool, handle }];
    });
  const candidates = computed(() =>
    attached().flatMap(({ tool, handle }) =>
      handle.items().map((item) => {
        const key = `${tool.instance.path.join('/')}/${tool.id}/${item.id}`;
        return {
          key,
          icon: item.icon,
          image: item.image,
          title: item.title,
          detail: item.detail,
          trailing: item.source,
          action: item.action,
          match: item.match,
          remembered: item.remembered === true,
          run() {
            if (item.remembered) props.usage.record(key);
            item.run();
          },
        };
      }),
    ),
  );
  const entries = computed(() =>
    attached().flatMap(({ tool, handle }) =>
      handle.entries().map((entry) => ({
        key: `${tool.key}/entry/${entry.keywords[0]}`,
        entry,
        icon: entry.icon,
        title: entry.title,
        trailing: entry.keywords[0],
        action: tr('Open'),
        run:
          entry.run ??
          (() => {
            selection.set(0);
            query.set(`${entry.keywords[0]} `);
          }),
      })),
    ),
  );
  const home = computed(() => query().trim() === '');
  const botRow = (): Row => ({
    key: 'bot',
    icon: 'maka',
    title: 'Maka Bot',
    detail: unread()?.preview,
    trailing: unread() === null ? undefined : clock(unread()!.at),
    unread: unread() !== null,
    action: tr('Open'),
    run: () => void run(),
  });
  const askRow = (): Row => ({
    key: 'ask',
    icon: 'maka',
    title: tr('Ask Maka'),
    action: tr('Ask Maka'),
    run: () => void run(),
  });
  const results = (): Row[] => {
    const text = query();
    const found = entries().flatMap((row) => {
      // Inside a tool its own entry would only push the results down.
      if (row.entry.run === undefined && afterKeyword(text, row.entry.keywords) !== null) return [];
      const match = matchOf([row.entry.title, ...row.entry.keywords], text);
      return match === null ? [] : [{ ...row, match }];
    });
    return ranked([...candidates(), ...found], props.usage.current());
  };
  const recommendations = (): Row[] => {
    const usage = props.usage.current();
    return recommended(candidates(), usage).map((row) => ({
      ...row,
      detail: isFrequent(usage[row.key]!) ? tr('Frequently used') : tr('Recently used'),
    }));
  };
  const sections = computed(() => {
    const groups: { key: string; title: string | null; rows: readonly Row[] }[] = home()
      ? [
          { key: 'bot', title: null, rows: [botRow()] },
          { key: 'recommended', title: tr('Recommended'), rows: recommendations() },
          { key: 'tools', title: tr('Tools'), rows: entries() },
        ]
      : [{ key: 'results', title: null, rows: results() }];
    let start = 0;
    return groups.flatMap((group): Section[] => {
      if (group.rows.length === 0) return [];
      const section = { ...group, start };
      start += group.rows.length;
      return [section];
    });
  });
  const listed = computed(() => sections().flatMap((section) => section.rows));
  // A typed query always keeps a way to ask the Bot, below the rows that scroll.
  const pinned = computed(() => (home() ? null : askRow()));
  const rows = computed(() => [...listed(), ...(pinned() ? [pinned()!] : [])]);
  const selection = signal(0);
  const selected = computed(() => Math.min(selection(), rows().length - 1));
  // Where each listed row sits; a section's first row reveals its title with it.
  const placement = computed(() => {
    const spans: { top: number; bottom: number }[] = [];
    let y = 0;
    for (const section of sections()) {
      const top = y;
      if (section.title !== null) y += QUICK_SECTION_HEIGHT;
      section.rows.forEach((_, index) => {
        y += QUICK_ROW_HEIGHT;
        spans.push({ top: index === 0 ? top : y - QUICK_ROW_HEIGHT, bottom: y });
      });
    }
    return { spans, height: y };
  });
  const listHeight = computed(() => Math.min(placement().height, MAX_LIST_HEIGHT));
  const toolView = (tool: UiContributionRef) => {
    cleanup(() => {
      const remaining = new Map(handles());
      remaining.delete(tool.key);
      handles.set(remaining);
    });
    return props.runtime.renderView({ path: tool.instance.path, id: tool.id }, quickToolView, {
      query,
      close: () => void props.close(),
      report: (reason) => failure.set(errorText(reason)),
      attach: (handle) => handles.set(new Map(handles()).set(tool.key, handle)),
    });
  };
  let list: ScrollRef | undefined;
  let scrolled = 0;
  const reveal = (y: number) => {
    scrolled = y;
    list?.scrollTo({ y, animated: false });
  };
  effect(() => {
    const span = placement().spans[selected()];
    if (span === undefined) return;
    if (span.top < scrolled) reveal(span.top);
    else if (span.bottom > scrolled + listHeight()) reveal(span.bottom - listHeight());
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
  const activate = () => rows()[selected()]!.run();
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
              keymap.bind(
                'down',
                () => selection.set(Math.min(rows().length - 1, selected() + 1)),
                {
                  when: 'always',
                  repeat: true,
                  within: node,
                },
              ),
            ];
            removeKeys = () => unbind.forEach((remove) => remove());
          }}
          autoFocus
          accessibilityLabel={tr('Search tools or ask Maka')}
          placeholder={tr('Search tools or ask Maka')}
          value={query()}
          onChange={({ value }) => {
            selection.set(0);
            query.set(value);
          }}
          onSubmit={activate}
          style={{ ...quickInputStyle(), flex: 1, minWidth: 0, marginTop: 8 }}
        />
      </View>
      <Each of={tools()} key={(tool: UiContributionRef) => tool.key}>
        {(tool) => toolView(tool())}
      </Each>
      <View style={{ borderTopWidth: 1, borderTopColor: C.line }}>
        <Scroll
          ref={(node) => {
            list = node;
          }}
          onScroll={({ offset }) => {
            scrolled = offset.y;
          }}
          style={{ height: listHeight() }}
        >
          <Each of={sections()} key={(section: Section) => section.key}>
            {(section) => (
              <>
                <If when={section().title !== null}>
                  <QuickSectionTitle title={section().title!} />
                </If>
                <Each of={section().rows} key={(row: Row) => row.key}>
                  {(row, index) => (
                    <LauncherRow row={row()} selected={selected() === section().start + index()} />
                  )}
                </Each>
              </>
            )}
          </Each>
        </Scroll>
        <If when={pinned() !== null}>
          <LauncherRow row={pinned()!} selected={selected() === listed().length} />
        </If>
      </View>
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
      <QuickFooter action={rows()[selected()]!.action} />
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
  const usage = createUsageStore(props.report);
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
      defaultSize={{ width: 680, height: 400 }}
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
            usage={usage}
          />
        }
      >
        <View style={[frameStyle, { maxHeight: MAX_HEIGHT }]}>{props.conversation()}</View>
      </If>
    </Window>
  );
}
