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
  untracked,
  View,
  type InputRef,
  type JSX,
  type ScrollRef,
  type Signal,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import { GlobalShortcut, Window, currentWindow } from 'nsh/desktop';
import type { UiContributionRef } from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickIcon,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { afterKeyword, matchOf } from '../../../../plugins/shared/quick-search';
import { Icon } from './Icon';
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
import { LAUNCHER_SHORTCUT, type ToolEntry } from './QuickCommands';
import { expandAlias } from './quick-commands';
import { createToolNavigation, QuickToolSettings, type QuickTools } from './QuickTools';
import {
  isFrequent,
  parseUsage,
  ranked,
  recommended,
  recordUse,
  type Usage,
} from './quick-results';
import { errorText, renderText } from './text';
import { C, bodyTextStyle, controlHoverStyle, textTooltip } from './ui';

const MAX_HEIGHT = 560;
const MAX_LIST_HEIGHT = 360;
/** Settings pages scroll inside a fixed height, so the popup does not jump with their content. */
const SETTINGS_HEIGHT = 440;
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
  badge?: string | undefined;
  unread?: boolean;
  action: string;
  /** The tool behind the row, whose settings the row opens. */
  tool?: UiContributionRef | undefined;
  run(): void;
};

type Section = { key: string; title: string | null; rows: readonly Row[]; start: number };

function LauncherRow(props: { row: Row; selected: boolean; pressed(): void }) {
  return (
    <QuickRow
      label={`${props.row.action} ${props.row.title}`}
      title={props.row.title}
      detail={props.row.detail}
      trailing={props.row.trailing}
      badge={props.row.badge}
      icon={props.row.icon}
      image={props.row.image?.()}
      unread={props.row.unread === true}
      selected={props.selected}
      onPress={() => {
        props.row.run();
        // A press takes the keyboard to the row; typing goes on in the query.
        props.pressed();
      }}
    />
  );
}

/** A tool's settings in place of the results; Escape or the back button returns to them. */
function QuickSettings(props: { quick: QuickTools; tool: UiContributionRef; back(): void }) {
  const navigation = createToolNavigation();
  const busy = () => navigation.inner()?.busy?.() ?? false;
  const back = () => {
    if (busy() || !navigation.back()) return;
    navigation.leave(props.back);
  };
  cleanup(keymap.bind('escape', back, { when: 'always' }));
  const action = () => navigation.inner()?.action?.() ?? null;
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 52,
          paddingLeft: 10,
          paddingRight: 16,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        <Button
          accessibilityLabel={navigation.inner()?.backLabel?.() ?? tr('Back')}
          tooltip={textTooltip(() => tr('Back'))}
          disabled={busy()}
          onPress={back}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          hoverStyle={controlHoverStyle()}
        >
          <Icon name="back" color={C.secondary} size={16} />
        </Button>
        <Text
          style={[
            { ...bodyTextStyle, flex: 1, minWidth: 0, fontWeight: '600', color: C.text },
            { numberOfLines: 1, textOverflow: 'ellipsis' },
          ]}
        >
          {navigation.inner()?.title() ?? props.quick.title(props.tool)}
        </Text>
        <If when={action() !== null}>
          <Button
            accessibilityLabel={action()!.label}
            disabled={busy() || action()!.disabled === true}
            onPress={() => action()!.run()}
            style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6 }}
            hoverStyle={controlHoverStyle()}
          >
            <Text style={{ fontSize: 13, lineHeight: 18, color: C.accent }}>{action()!.label}</Text>
          </Button>
        </If>
      </View>
      <View style={{ height: SETTINGS_HEIGHT, paddingTop: 12 }}>
        <QuickToolSettings
          quick={props.quick}
          tool={props.tool}
          recording={navigation.recording}
          attach={navigation.attach}
        />
      </View>
    </View>
  );
}

function Launcher(
  props: Navigation & {
    quick: QuickTools;
    usage: UsageStore;
    query: Signal<string>;
    /** The query as tools see it, a leading alias replaced by its keyword. */
    toolQuery(): string;
    failure: Signal<ReturnType<typeof errorText> | null>;
    /** The tool whose settings show in place of the results. */
    page: Signal<UiContributionRef | null>;
    /** The tool entered by choosing its entry, searched with what is typed. */
    scope: Signal<ToolEntry | null>;
    /** Whether the query is inside a tool, entered or typed with its keyword. */
    inside(): boolean;
    /** Back from inside a tool to every tool. */
    leave(): void;
  },
) {
  // A window that does not activate leaves the keyboard with the app in use until focused.
  currentWindow().focus();
  const { query, failure } = props;
  const unread = watchUnread((reason) => failure.set(errorText(reason)));
  const { quick } = props;
  const candidates = computed(() =>
    quick.attached().flatMap(({ tool, handle }) =>
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
          tool: quick.configurable(tool) ? tool : undefined,
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
  let input: InputRef | undefined;
  const refocus = () => input?.focus();
  // Entering or leaving a tool redraws the bar around the query, which takes the keyboard away.
  effect(() => {
    props.scope();
    untracked(refocus);
  });
  const entries = computed(() =>
    quick.entries().map((item) => {
      const { key, tool, entry } = item;
      const choice = quick.commands.choice(key);
      const word = choice?.alias ?? entry.keywords[0]!;
      return {
        key,
        entry,
        alias: choice?.alias,
        icon: entry.icon,
        title: entry.title,
        badge: word,
        // As Raycast does: the kind of row, after its shortcut.
        trailing: choice?.shortcut
          ? `${keymap.label(choice.shortcut)}   ${tr('Command')}`
          : tr('Command'),
        action: tr('Open'),
        tool,
        run:
          entry.run ??
          (() => {
            selection.set(0);
            query.set('');
            props.scope.set(item);
          }),
      };
    }),
  );
  const home = computed(() => query().trim() === '' && props.scope() === null);
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
    // Inside an entered tool only its results are offered.
    const found = (props.scope() === null ? entries() : []).flatMap((row) => {
      // Inside a tool its own entry would only push the results down.
      if (
        row.entry.run === undefined &&
        afterKeyword(props.toolQuery(), row.entry.keywords) !== null
      )
        return [];
      // An alias is the user's own name for the entry: typed in full, it comes first.
      const match =
        row.alias !== undefined && text.trim().toLowerCase() === row.alias
          ? -1
          : matchOf([row.entry.title, ...row.entry.keywords], text);
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
  // A typed query keeps a way to ask the Bot below the rows that scroll, except inside a tool,
  // whose query is the tool's to search.
  const pinned = computed(() => (home() || props.inside() ? null : askRow()));
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
  // Escape inside a tool goes back to every tool; outside one the popup closes.
  effect(() => {
    if (!props.inside()) return;
    cleanup(
      keymap.bind(
        'escape',
        () => {
          selection.set(0);
          props.leave();
        },
        { when: 'always' },
      ),
    );
  });
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
    rows()[selected()]!.run();
    refocus();
  };
  /** Cmd+1 to Cmd+9 run the row with that number, counting from the top. */
  const runNumbered = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    selection.set(index);
    row.run();
    refocus();
  };
  const placeholder = () =>
    props.scope() !== null
      ? tr('Search {tool}', { tool: props.scope()!.entry.title })
      : tr('Search tools or ask Maka');
  const openSettings = (tool: UiContributionRef) => {
    failure.set(null);
    props.page.set(tool);
  };
  return (
    <View style={frameStyle}>
      <If
        when={props.page() === null}
        else={
          <QuickSettings quick={quick} tool={props.page()!} back={() => props.page.set(null)} />
        }
      >
        <View style={quickBarStyle}>
          <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
            <MakaMark />
          </View>
          <If when={props.scope() !== null}>
            <View style={{ height: 24, marginTop: 8, justifyContent: 'center' }}>
              <Text
                style={{
                  fontSize: 13,
                  lineHeight: 20,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  backgroundColor: C.raised,
                  color: C.text,
                }}
              >
                {props.scope()!.entry.title}
              </Text>
            </View>
          </If>
          {/* A new field per tool: a field keeps the placeholder it was made with. */}
          <Each of={[props.scope()?.key ?? '']} key={(key: string) => key}>
            {() => (
              <Input
                ref={(node) => {
                  input = node;
                  removeKeys();
                  const unbind = [
                    ...Array.from({ length: 9 }, (_, index) =>
                      keymap.bind(`mod+${index + 1}`, () => runNumbered(index), {
                        when: 'always',
                        within: node,
                      }),
                    ),
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
                    keymap.bind(
                      'mod+,',
                      () => {
                        const tool = rows()[selected()]!.tool;
                        if (tool) openSettings(tool);
                      },
                      { when: 'always', within: node },
                    ),
                  ];
                  removeKeys = () => unbind.forEach((remove) => remove());
                }}
                autoFocus
                accessibilityLabel={placeholder()}
                placeholder={placeholder()}
                value={query()}
                onChange={({ value }) => {
                  selection.set(0);
                  query.set(value);
                }}
                onSubmit={activate}
                style={{ ...quickInputStyle(), flex: 1, minWidth: 0, marginTop: 8 }}
              />
            )}
          </Each>
        </View>
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
                      <LauncherRow
                        row={row()}
                        selected={selected() === section().start + index()}
                        pressed={refocus}
                      />
                    )}
                  </Each>
                </>
              )}
            </Each>
          </Scroll>
          <If when={pinned() !== null}>
            <LauncherRow
              row={pinned()!}
              selected={selected() === listed().length}
              pressed={refocus}
            />
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
        <QuickFooter
          action={rows()[selected()]!.action}
          settings={rows()[selected()]!.tool !== undefined}
        />
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
    quick: QuickTools;
    report(reason: unknown): void;
  },
) {
  const { quick } = props;
  const { commands, handles } = quick;
  const usage = createUsageStore(props.report);
  effect(() => {
    if (commands.failure() !== null) props.report(commands.failure());
  });
  const page = signal<UiContributionRef | null>(null);
  const query = signal('');
  const failure = signal<ReturnType<typeof errorText> | null>(null);
  // Tools live as long as the app, not the popup, so their commands run from shortcuts too.
  const tools = computed(() => quick.tools());
  const aliases = computed(() =>
    quick.entries().flatMap(({ key, entry }) => {
      const alias = commands.choice(key)?.alias;
      return alias ? [{ alias, keyword: entry.keywords[0]! }] : [];
    }),
  );
  const scope = signal<ToolEntry | null>(null);
  const toolQuery = computed(() => {
    const entered = scope();
    return entered ? `${entered.entry.keywords[0]} ${query()}` : expandAlias(query(), aliases());
  });
  const inside = computed(
    () =>
      scope() !== null ||
      quick
        .entries()
        .some(
          ({ entry }) =>
            entry.run === undefined && afterKeyword(toolQuery(), entry.keywords) !== null,
        ),
  );
  const leave = () => {
    scope.set(null);
    query.set('');
  };
  const toolView = (tool: UiContributionRef) => {
    cleanup(() => {
      const remaining = new Map(handles());
      remaining.delete(tool.key);
      handles.set(remaining);
    });
    return quick.runtime.renderView({ path: tool.instance.path, id: tool.id }, quickToolView, {
      query: toolQuery,
      close: () => void props.close(),
      report: (reason) => failure.set(errorText(reason)),
      attach: (handle) => handles.set(new Map(handles()).set(tool.key, handle)),
    });
  };
  const show = (entered: ToolEntry | null) => {
    query.set('');
    scope.set(entered);
    failure.set(null);
    page.set(null);
    props.opened.set(true);
  };
  const toggle = () => {
    if (props.opened()) void props.close();
    else show(null);
  };
  /** A command's shortcut: runs it, or opens the launcher inside its tool. */
  const launch = (key: string) => {
    const found = untracked(quick.entries).find((item) => item.key === key);
    if (!found) return;
    if (found.entry.run) found.entry.run();
    else show(found);
  };
  // Only a change of the shortcuts themselves registers them again.
  const bound = computed(() =>
    Object.entries(quick.enabled() ? commands.choices() : {})
      .flatMap(([key, choice]) => (choice.shortcut ? [`${choice.shortcut}\t${key}`] : []))
      .join('\n'),
  );
  effect(() => {
    const list = bound()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string]);
    untracked(() => {
      for (const [shortcut, key] of list)
        void GlobalShortcut.register(shortcut, () => launch(key)).then(
          (taken) => commands.registered(shortcut, taken),
          props.report,
        );
    });
    cleanup(() => list.forEach(([shortcut]) => GlobalShortcut.unregister(shortcut)));
  });
  // The whole launcher is off until the user turns it on: no shortcut, no popup.
  effect(() => {
    if (!quick.enabled()) {
      if (untracked(props.opened)) void props.close();
      return;
    }
    void GlobalShortcut.register(LAUNCHER_SHORTCUT, toggle).then((registered) => {
      if (!registered)
        props.report(
          new Error(
            platform.os === 'macos'
              ? tr('The Option+Space shortcut is unavailable')
              : tr('The Alt+Space shortcut is unavailable'),
          ),
        );
    }, props.report);
    cleanup(() => GlobalShortcut.unregister(LAUNCHER_SHORTCUT));
  });
  return (
    <>
      <Each of={quick.enabled() ? tools() : []} key={(tool: UiContributionRef) => tool.key}>
        {(tool) => toolView(tool())}
      </Each>
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
        // Escape stops a running reply, and every way out has to save the draft first. In a tool's
        // settings Escape goes back, and a picker the page opens must not close it.
        closeOnEscape={!props.conversing() && page() === null && !inside()}
        closeOnBlur={!props.conversing() && page() === null}
        closeOnPress={!props.conversing()}
        onClosePress={() => void props.close()}
        open={props.opened() && quick.enabled()}
        onOpenChange={({ open }) => {
          if (open) return;
          page.set(null);
          scope.set(null);
          props.closed();
        }}
      >
        <If
          when={props.conversing()}
          else={
            <Launcher
              openBot={props.openBot}
              vacate={props.vacate}
              open={props.open}
              quick={quick}
              usage={usage}
              query={query}
              toolQuery={toolQuery}
              failure={failure}
              page={page}
              scope={scope}
              inside={inside}
              leave={leave}
            />
          }
        >
          <View style={[frameStyle, { maxHeight: MAX_HEIGHT }]}>{props.conversation()}</View>
        </If>
      </Window>
    </>
  );
}
