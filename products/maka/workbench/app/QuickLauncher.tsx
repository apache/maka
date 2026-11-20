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
  batch,
  cleanup,
  computed,
  effect,
  Image,
  keymap,
  host as shell,
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
import { Button, Input, Menu, MenuItem, MenuSeparator } from 'nsh/base';
import { createQuickQuestion } from './quickQuestion';
import { quickQuestionIcon } from './quick-question-icon';
import { QuickQuestionPanel } from './QuickQuestionPanel';
import { rememberInput, historyAtSelection } from './quick-input-history';
import { GlobalShortcut, Window, currentWindow } from 'nsh/desktop';
import type { UiContributionRef } from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickIcon,
  type QuickAction,
  type QuickPreview,
  type QuickTextEditor,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { matchOf } from '../../../../plugins/shared/quick-search';
import { Icon } from './Icon';
import { loadDraft, saveDraft, type Output } from './host';
import { hasComposerContent } from '../../../../packages/plugin-sdk/src/composer-view.js';
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
import { SettingsEditor } from './SettingsField';
import { SettingsButton } from './SettingsPage';
import { toolStoragePath, type ToolEntry } from './QuickCommands';
import { entryMatch } from './quick-commands';
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
import {
  C,
  bodyTextStyle,
  controlHoverStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  menuLabelStyle,
  textTooltip,
} from './ui';

const MAX_HEIGHT = 560;
const MAX_LIST_HEIGHT = 360;
/** Settings pages scroll inside a fixed height, so the popup does not jump with their content. */
const SETTINGS_HEIGHT = 440;
const USAGE_KEY = 'maka.quick-launcher.usage';

type BotOutbox = Output<'agent', 'botOutbox'>;

type ToolScope = {
  entry: ToolEntry;
  previous: { query: string; selection: number };
};

type Navigation = {
  openBot(): Promise<string>;
  /** Takes the conversation out of the panes showing it, which saves their draft. */
  vacate(sessionId: string): Promise<boolean>;
  /** `message` goes out once the conversation can send; it must have no draft. */
  open(sessionId: string, message?: string): void;
};

const frameStyle = () =>
  ({
    backgroundColor: C.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    overflow: 'hidden',
  }) as const;

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

type UsageStore = {
  current(): Usage;
  record(key: string): void;
  failure(): ReturnType<typeof errorText> | null;
};

function createUsageStore(): UsageStore {
  const usage = signal<Usage>({});
  const failure = signal<ReturnType<typeof errorText> | null>(null);
  const report = (reason: unknown) =>
    failure.set(errorText(reason, 'Could not load or save launcher history.'));
  Storage.getItem(USAGE_KEY)
    .then((stored) => usage.set(parseUsage(stored)))
    .catch(report);
  let saving: Promise<void> = Promise.resolve();
  return {
    current: usage,
    failure,
    record(key) {
      const next = recordUse(usage(), key, Date.now());
      usage.set(next);
      const value = JSON.stringify(next);
      saving = saving
        .then(() => Storage.setItem(USAGE_KEY, value))
        .then(() => failure.set(null), report);
    },
  };
}

type Row = {
  actions?: (() => Promise<readonly QuickAction[]>) | undefined;
  itemId?: string;
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

function LauncherRow(props: {
  row: Row;
  shortcut?: string | undefined;
  selected: boolean;
  select?: (() => void) | undefined;
  pressed(): void;
  activate(row: Row): void;
}) {
  return (
    <QuickRow
      label={`${props.row.action} ${props.row.title}`}
      title={props.row.title}
      detail={props.select ? undefined : props.row.detail}
      trailing={props.select || props.shortcut ? undefined : props.row.trailing}
      badge={props.shortcut ?? props.row.badge}
      icon={props.row.icon}
      image={props.row.image?.()}
      unread={props.row.unread === true}
      selected={props.selected}
      previewRow={props.select !== undefined}
      onPress={() => {
        if (props.select) props.select();
        else props.activate(props.row);
        // A press takes the keyboard to the row; typing goes on in the query.
        props.pressed();
      }}
    />
  );
}

function ResultPreview(props: { value: QuickPreview | undefined }) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        padding: 16,
        gap: 10,
        borderLeftWidth: 1,
        borderColor: C.line,
      }}
    >
      <If when={props.value !== undefined}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <If when={props.value?.image}>
            <Image
              src={props.value!.image!}
              style={[{ flex: 1, minHeight: 0, width: '100%' }, { objectFit: 'contain' }]}
            />
          </If>
          <If when={props.value?.text}>
            <Scroll style={{ maxHeight: props.value?.image ? 48 : '100%' }}>
              <Text style={{ ...bodyTextStyle, color: C.text, userSelect: 'text' }}>
                {props.value?.text}
              </Text>
            </Scroll>
          </If>
        </View>
        <View style={{ gap: 5, paddingTop: 9, borderTopWidth: 1, borderColor: C.line }}>
          <Each of={props.value?.fields ?? []} key={(f: QuickPreview['fields'][number]) => f.label}>
            {(field) => (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ fontSize: 12, color: C.muted }}>{field().label}</Text>
                <Text style={{ fontSize: 12, color: C.text }}>{field().value}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
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
    history(): string[];
    remember(text: string): void;
    question: ReturnType<typeof createQuickQuestion>;
    openQuestion(resume: boolean, text?: string): void;
    query: Signal<string>;
    failure: Signal<ReturnType<typeof errorText> | null>;
    /** The tool whose settings show in place of the results. */
    page: Signal<UiContributionRef | null>;
    /** The tool entered by choosing its entry, searched with what is typed. */
    scope(): ToolEntry | null;
    selection: Signal<number>;
    enter(item: ToolEntry, text: string): void;
    leave(): void;
  },
) {
  // A window that does not activate leaves the keyboard with the app in use until focused.
  currentWindow().focus();
  const commandHeld = signal(false);
  if (platform.os === 'macos') {
    let awaitingInitial = true;
    const off = shell.on('quickLauncher.commandChanged', (held: boolean) => {
      awaitingInitial = false;
      commandHeld.set(held);
    });
    void shell
      .call<boolean>('quickLauncher.commandHeld', {})
      .then((held) => {
        if (awaitingInitial) commandHeld.set(held);
      })
      .catch(() => {});
    cleanup(() => {
      awaitingInitial = false;
      off();
    });
  }
  const shortcut = (index: number) =>
    commandHeld() && index < 9 ? keymap.label(`mod+${index + 1}`) : undefined;
  const { query, failure, selection } = props;
  const problem = () => failure() ?? props.usage.failure();
  const unread = watchUnread((reason) =>
    failure.set(errorText(reason, 'Could not check Maka Bot messages.')),
  );
  const { quick } = props;
  const candidates = computed(() =>
    quick
      .attached()
      .filter(({ tool }) => !props.scope() || props.scope()!.tool.key === tool.key)
      .flatMap(({ tool, handle }) =>
        handle.items().map((item) => {
          const key = `${toolStoragePath(tool)}/${item.id}`;
          return {
            key,
            itemId: item.id,
            actions: item.actions,
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
  const input = signal<InputRef | undefined>(undefined);
  const refocus = () => input()?.focus();
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
        item,
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
        run: entry.run ?? (() => props.enter(item, '')),
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
  const questionRow = (resume: boolean): Row => ({
    key: resume ? 'resume-question' : 'quick-question',
    icon: 'maka',
    image: () => quickQuestionIcon,
    title: resume ? tr('Continue last question') : tr('Quick question'),
    detail: resume ? props.question.turns()[0]?.question : undefined,
    action: tr('Open'),
    run: () => props.openQuestion(resume),
  });
  const results = (): Row[] => {
    const text = query();
    // Inside an entered tool only its results are offered.
    const found = (props.scope() === null ? entries() : []).flatMap((row) => {
      const match =
        entryMatch(text, row.alias, row.entry.keywords) ??
        matchOf([row.entry.title, ...row.entry.keywords], text);
      return match === null ? [] : [{ ...row, match }];
    });
    if (props.scope() !== null) return ranked([...candidates(), ...found], props.usage.current());
    const question = questionRow(false);
    const match = matchOf([question.title, 'quick question', '快问'], text);
    return ranked(
      [...candidates(), ...found, ...(match === null ? [] : [{ ...question, match }])],
      props.usage.current(),
    );
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
          {
            key: 'bot',
            title: null,
            rows: [
              botRow(),
              questionRow(false),
              ...(props.question.turns().length ? [questionRow(true)] : []),
            ],
          },
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
  const pinned = computed(() => (home() || props.scope() !== null ? null : askRow()));
  const rows = computed(() => [...listed(), ...(pinned() ? [pinned()!] : [])]);
  const selected = computed(() => Math.min(selection(), rows().length - 1));
  const previewer = computed(() => {
    const scope = props.scope();
    return scope && rows().length ? quick.handles().get(scope.tool.key)?.preview : undefined;
  });
  const preview = computed(() => {
    const id = rows()[selected()]?.itemId;
    return id === undefined ? undefined : previewer()?.(id);
  });
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
  // The settings page and native popup handle Escape on their own.
  effect(() => {
    if (props.scope() === null || props.page() !== null) return;
    cleanup(keymap.bind('escape', props.leave, { when: 'always' }));
  });
  effect(() => {
    const node = input();
    if (!node || props.scope() === null || props.page() !== null) return;
    cleanup(
      keymap.bind(
        'backspace',
        () => {
          if (query() === '') props.leave();
        },
        { when: 'always', within: node, passThrough: true },
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
      if (!(await props.vacate(sessionId))) return;
      if (!text) {
        props.open(sessionId);
        return;
      }
      const session = host.session(sessionId);
      const draft = await loadDraft(session);
      // A saved draft is unfinished work and a slash command needs the composer: neither is sent.
      if (
        !hasComposerContent(draft.text, draft.attachments, draft.quotes) &&
        !text.startsWith('/')
      ) {
        props.open(sessionId, text);
        return;
      }
      await saveDraft(session, draft.revision, {
        text: draft.text.trim() ? `${draft.text}\n\n${text}` : text,
        attachments: draft.attachments,
        quotes: draft.quotes,
      });
      // The draft holds it now; a retry after refused navigation must not append it again.
      if (query().startsWith(submitted)) query.set(query().slice(submitted.length));
      props.open(sessionId);
    } catch (reason) {
      failure.set(errorText(reason, 'Maka Bot could not be opened'));
    } finally {
      running = false;
    }
  };
  let cursor = { index: -1, draft: '', text: '' };
  const navigate = (direction: -1 | 1) => {
    const index = selected();
    const next = props.scope()
      ? null
      : historyAtSelection(props.history(), index, cursor, query(), direction);
    if (next) {
      cursor = next;
      query.set(next.text);
    } else {
      cursor = { index: -1, draft: '', text: '' };
      selection.set(Math.max(0, Math.min(rows().length - 1, index + direction)));
    }
  };
  const executeRow = (row: Row) => {
    if (!props.scope()) props.remember(query());
    row.run();
  };
  const activate = () => {
    const row = rows()[selected()];
    if (row) executeRow(row);
    refocus();
  };
  /** Cmd+1 to Cmd+9 run the row with that number, counting from the top. */
  const runNumbered = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    selection.set(index);
    executeRow(row);
    refocus();
  };
  const menuOpen = signal(false);
  const menuIndex = signal(-1);
  const choices = signal<readonly QuickAction[]>([]);
  const confirm = signal<QuickAction | null>(null);
  let menuRequest = 0;
  const setMenu = (open: boolean, keyboard = false) => {
    menuIndex.set(keyboard ? 0 : -1);
    const ticket = ++menuRequest;
    menuOpen.set(open);
    if (!open) return;
    const row = rows()[selected()];
    if (!row) return;
    const first: QuickAction = {
      icon: row.icon === 'maka' ? 'command' : row.icon,
      title: row.action,
      run: () => executeRow(row),
    };
    const settings: QuickAction[] = row.tool
      ? [
          {
            title: tr('{tool} settings', { tool: quick.title(row.tool) }),
            icon: 'settings',
            startsGroup: true,
            run: () => openSettings(row.tool!),
          },
        ]
      : [];
    choices.set([first, ...settings]);
    if (row.actions)
      void row.actions().then(
        (extra) => {
          if (ticket === menuRequest) choices.set([first, ...extra, ...settings]);
        },
        (reason) => failure.set(errorText(reason, 'Could not run {tool}.', { tool: row.title })),
      );
  };
  const selectAction = (action: QuickAction | undefined) => {
    if (!action) return;
    setMenu(false);
    if (action.confirm) confirm.set(action);
    else action.run();
  };
  const moveSelection = (direction: -1 | 1) => {
    if (!menuOpen()) return navigate(direction);
    menuIndex.set(Math.max(0, Math.min(choices().length - 1, menuIndex() + direction)));
  };
  effect(() => {
    const node = input();
    if (!node) return;
    const inMenu = menuOpen();
    for (let index = 0; index < 9; index++) {
      cleanup(
        keymap.bind(
          `mod+${index + 1}`,
          () => (inMenu ? selectAction(choices()[index]) : runNumbered(index)),
          inMenu ? { when: 'always' } : { when: 'always', within: node },
        ),
      );
    }
    if (inMenu) {
      cleanup(keymap.bind('escape', () => setMenu(false), { when: 'always', within: node }));
    }
  });
  const placeholder = () =>
    props.scope() !== null
      ? tr('Search {tool}', { tool: props.scope()!.entry.title })
      : tr('Search tools or ask Maka');
  const openSettings = (tool: UiContributionRef) => {
    failure.set(null);
    props.page.set(tool);
  };
  return (
    <View style={frameStyle()}>
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
                  input.set(node);
                  removeKeys();
                  const unbind = [
                    keymap.bind('up', () => moveSelection(-1), {
                      when: 'always',
                      repeat: true,
                      within: node,
                    }),
                    keymap.bind('down', () => moveSelection(1), {
                      when: 'always',
                      repeat: true,
                      within: node,
                    }),
                    keymap.bind('mod+k', () => setMenu(!menuOpen(), true), {
                      when: 'always',
                      within: node,
                    }),
                    keymap.bind(
                      'mod+enter',
                      () => {
                        if (!props.scope() && query().trim())
                          props.openQuestion(false, query().trim());
                      },
                      { when: 'always', within: node },
                    ),
                    keymap.bind(
                      'mod+,',
                      () => {
                        const tool = rows()[selected()]?.tool;
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
                  if (menuOpen()) setMenu(false);
                  cursor = { index: -1, draft: '', text: '' };
                  failure.set(null);
                  if (!props.scope()) {
                    const prefix = /^\s*(\S+)\s([\s\S]*)$/u.exec(value);
                    if (prefix) {
                      const word = prefix[1]!.toLowerCase();
                      const searchable = entries().filter(({ entry }) => !entry.run);
                      const row =
                        searchable.find((row) => row.alias === word) ??
                        searchable.find(
                          (row) => entryMatch(word, undefined, row.entry.keywords) !== null,
                        );
                      if (row) {
                        props.enter(row.item, prefix[2]!);
                        return;
                      }
                    }
                  }
                  selection.set(0);
                  query.set(value);
                }}
                onSubmit={() => (menuOpen() ? selectAction(choices()[menuIndex()]) : activate())}
                style={{ ...quickInputStyle(), flex: 1, minWidth: 0, marginTop: 8 }}
              />
            )}
          </Each>
          <If when={props.scope() === null && !!query().trim()}>
            <Button
              accessibilityLabel={tr('Quick question')}
              onPress={() => props.openQuestion(false, query().trim())}
              style={{ height: QUICK_BAR_SLOT, justifyContent: 'center', paddingHorizontal: 8 }}
            >
              <Text style={{ color: C.secondary, fontSize: 12 }}>
                {keymap.label('mod+enter')} {tr('Quick question')}
              </Text>
            </Button>
          </If>
        </View>
        <View
          style={{
            // A content-sized launcher must also fit the overlay above its footer.
            minHeight: menuOpen()
              ? Math.min(
                  MAX_LIST_HEIGHT,
                  choices().length * menuRowStyle().minHeight +
                    32 +
                    choices().filter((item) => item.startsGroup).length * 9,
                )
              : 0,
            borderTopWidth: 1,
            borderTopColor: C.line,
            flexDirection: previewer() ? 'row' : 'column',
          }}
        >
          <View style={{ width: previewer() ? 260 : '100%' }}>
            <Scroll
              ref={(node) => {
                list = node;
              }}
              onScroll={({ offset }) => {
                scrolled = offset.y;
              }}
              style={{ height: previewer() ? MAX_LIST_HEIGHT : listHeight() }}
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
                          shortcut={menuOpen() ? undefined : shortcut(section().start + index())}
                          selected={selected() === section().start + index()}
                          select={
                            previewer() ? () => selection.set(section().start + index()) : undefined
                          }
                          pressed={refocus}
                          activate={executeRow}
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
                shortcut={menuOpen() ? undefined : shortcut(listed().length)}
                selected={selected() === listed().length}
                pressed={refocus}
                activate={executeRow}
              />
            </If>
          </View>
          <If when={previewer() !== undefined}>
            <ResultPreview value={preview()} />
          </If>
        </View>
        <If when={problem() !== null}>
          <Text
            style={[
              { ...bodyTextStyle, paddingVertical: 8, paddingLeft: 42, paddingRight: 12 },
              { color: C.warning, userSelect: 'text' },
            ]}
          >
            {renderText(problem()!)}
          </Text>
        </If>
        <If
          when={rows().length > 0}
          else={
            <Text
              style={{
                ...bodyTextStyle,
                paddingHorizontal: 16,
                paddingVertical: 12,
                color: C.muted,
              }}
            >
              {quick
                .handles()
                .get(props.scope()?.tool.key ?? '')
                ?.emptyMessage?.() || tr('No matches.')}
            </Text>
          }
        >
          <If when={confirm() !== null}>
            <View style={{ padding: 12, gap: 8 }}>
              <Text style={{ ...bodyTextStyle, color: C.text }}>{confirm()?.confirm}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <SettingsButton label={tr('Cancel')} onPress={() => confirm.set(null)} />
                <SettingsButton
                  label={tr('Confirm')}
                  tone="danger"
                  onPress={() => {
                    const action = confirm();
                    confirm.set(null);
                    action?.run();
                  }}
                />
              </View>
            </View>
          </If>
          <QuickFooter
            menuOpen={menuOpen()}
            title={rows()[selected()]?.title ?? ''}
            onAction={activate}
            action={rows()[selected()]?.action ?? ''}
            menu={
              <Menu
                open={menuOpen()}
                onOpenChange={({ open }) => setMenu(open)}
                popupStyle={{ ...floatingStyle(), width: 224 }}
                offset={-30}
                margin={0}
                placement="top"
                align="end"
                trigger={
                  <Button
                    accessibilityLabel={tr('Launcher actions')}
                    style={{ paddingHorizontal: 8, justifyContent: 'center', height: 28 }}
                  >
                    <Text style={{ color: C.secondary, fontSize: 12 }}>
                      {tr('Launcher actions')} {keymap.label('mod+k')}
                    </Text>
                  </Button>
                }
              >
                <Text style={{ ...menuLabelStyle(), numberOfLines: 1, textOverflow: 'ellipsis' }}>
                  {rows()[selected()]?.title}
                </Text>
                <Each of={choices()} key={(item) => item.title}>
                  {(item, index) => (
                    <>
                      <If when={item().startsGroup}>
                        <MenuSeparator style={menuSeparatorStyle()} />
                      </If>
                      <MenuItem
                        accessibilityLabel={item().title}
                        style={{
                          ...menuRowStyle(),
                          minWidth: 184,
                          ...(menuIndex() === index() ? menuRowHoverStyle() : {}),
                        }}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={menuRowHoverStyle()}
                        onSelect={() => selectAction(item())}
                      >
                        <Icon name={item().icon ?? 'command'} size={16} color={C.secondary} />
                        <Text style={{ ...menuDetailTextStyle, color: C.text, flex: 1 }}>
                          {item().title}
                          {item().confirm ? '…' : ''}
                        </Text>
                        <If when={index() === 0 || shortcut(index()) !== undefined}>
                          <Text style={{ ...menuDetailTextStyle, color: C.muted }}>
                            {shortcut(index()) ?? '↵'}
                          </Text>
                        </If>
                      </MenuItem>
                    </>
                  )}
                </Each>
              </Menu>
            }
          />
        </If>
      </If>
    </View>
  );
}

/** A popup from the app's one engine; it never activates Maka over the app in use. */
function QuickEditor(props: { editor: QuickTextEditor; back(): void }) {
  cleanup(keymap.bind('escape', props.back, { when: 'always' }));
  return (
    <View style={[frameStyle(), { height: 380, padding: 14, gap: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SettingsButton label={tr('Back')} onPress={props.back} />
        <Text style={{ color: C.text, fontSize: 16 }}>{props.editor.title}</Text>
      </View>
      <SettingsEditor
        autoFocus
        label={tr('Content')}
        value={props.editor.value()}
        change={(value) => props.editor.change(value)}
      />
      <If when={!!props.editor.error()}>
        <Text style={{ color: C.warning }}>{props.editor.error()}</Text>
      </If>
    </View>
  );
}

export function QuickLauncher(
  props: Navigation & {
    opened: Signal<boolean>;
    conversing(): boolean;
    conversation(): JSX.Element;
    /** Closes the popup once a conversation in it has saved its draft. */
    close(): Promise<boolean>;
    closed(): void;
    quick: QuickTools;
  },
) {
  const { quick } = props;
  const { commands, handles } = quick;
  const failure = signal<ReturnType<typeof errorText> | null>(null);
  const usage = createUsageStore();
  const question = createQuickQuestion(props.openBot);
  const asking = signal(false);
  const inputs = signal<string[]>([]);
  const historyKey = 'maka.quick-launcher.search-history';
  let saves = Storage.getItem(historyKey)
    .then((raw) => {
      const saved: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(saved))
        inputs.set(
          [
            ...new Set([...saved.filter((x): x is string => typeof x === 'string'), ...inputs()]),
          ].slice(-50),
        );
    })
    .catch((reason) => failure.set(errorText(reason, 'Could not load or save launcher history.')));
  const remember = (text: string) => {
    if (!text.trim()) return;
    inputs.set(rememberInput(inputs(), text));
    saves = saves
      .then(() => Storage.setItem(historyKey, JSON.stringify(inputs())))
      .catch((reason) =>
        failure.set(errorText(reason, 'Could not load or save launcher history.')),
      );
  };
  const page = signal<UiContributionRef | null>(null);
  const query = signal('');
  const selection = signal(0);

  // Tools live as long as the app, not the popup, so their commands run from shortcuts too.
  const tools = computed(() => quick.tools().filter(quick.toolEnabled));
  const tool = signal<ToolScope | null>(null);
  const scope = () => tool()?.entry ?? null;
  const editor = signal<QuickTextEditor | null>(null);
  const enter = (entry: ToolEntry, text: string) =>
    batch(() => {
      const previous = tool()?.previous ?? { query: query(), selection: selection() };
      tool.set({ entry, previous });
      query.set(text);
      selection.set(0);
      failure.set(null);
    });
  const leave = () =>
    batch(() => {
      const current = tool();
      if (current === null) return;
      tool.set(null);
      query.set(current.previous.query);
      selection.set(current.previous.selection);
      failure.set(null);
    });
  const toolView = (tool: UiContributionRef) => {
    cleanup(() => {
      const remaining = new Map(handles());
      remaining.delete(tool.key);
      handles.set(remaining);
    });
    return quick.runtime.renderView({ path: tool.instance.path, id: tool.id }, quickToolView, {
      query: () => {
        const entered = scope();
        if (!entered) return query();
        return entered.tool.key === tool.key ? `${entered.entry.keywords[0]} ${query()}` : '';
      },
      editText: (next) => editor.set(next),
      enter: (id, text) => {
        const entry = quick
          .entries()
          .find((row) => row.tool.key === tool.key && row.entry.id === id);
        if (entry) enter(entry, text);
      },
      close: () => void props.close(),
      report: (reason) =>
        failure.set(errorText(reason, 'Could not run {tool}.', { tool: quick.title(tool) })),
      attach: (handle) => handles.set(new Map(handles()).set(tool.key, handle)),
    });
  };
  const show = (entered: ToolEntry | null) =>
    batch(() => {
      query.set('');
      selection.set(0);
      tool.set(null);
      editor.set(null);
      asking.set(false);
      failure.set(null);
      page.set(null);
      if (entered !== null) enter(entered, '');
      props.opened.set(true);
    });
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
  const register = (shortcut: string, onPress: () => void) => {
    let active = true;
    cleanup(() => {
      active = false;
      GlobalShortcut.unregister(shortcut);
    });
    void (async () => {
      try {
        const registered = await GlobalShortcut.register(shortcut, onPress);
        if (active) commands.registered(shortcut, registered ? null : 'Taken by another app');
      } catch (reason) {
        console.warn('Quick tools shortcut registration failed:', reason);
        if (active) commands.registered(shortcut, 'Could not register shortcut');
      }
    })();
  };
  // Only a change of the shortcuts themselves registers them again.
  const bound = computed(() =>
    (quick.enabled() ? quick.entries() : [])
      .flatMap(({ key }) => {
        const shortcut = commands.choice(key)?.shortcut;
        return shortcut ? [`${shortcut}\t${key}`] : [];
      })
      .join('\n'),
  );
  effect(() => {
    const list = bound()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string]);
    for (const [shortcut, key] of list) register(shortcut, () => launch(key));
  });
  // The whole launcher is off until the user turns it on: no shortcut, no popup.
  effect(() => {
    if (!quick.enabled()) {
      if (untracked(props.opened)) void props.close();
      return;
    }
    register(commands.launcher(), toggle);
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
        closeOnEscape={
          !asking() &&
          !props.conversing() &&
          page() === null &&
          scope() === null &&
          editor() === null
        }
        closeOnBlur={!props.conversing() && page() === null}
        onFocusChange={({ focused }) => {
          // Keep the conversation mounted until its pending draft has been saved.
          if (!focused && props.opened() && props.conversing()) void props.close();
        }}
        closeOnPress={!props.conversing()}
        onClosePress={() => void props.close()}
        open={props.opened() && quick.enabled()}
        onOpenChange={({ open }) => {
          if (open) return;
          editor.set(null);
          asking.set(false);
          page.set(null);
          tool.set(null);
          props.closed();
        }}
      >
        <If
          when={props.conversing()}
          else={
            <If
              when={editor() !== null}
              else={
                <If
                  when={asking()}
                  else={
                    <Launcher
                      question={question}
                      history={inputs}
                      remember={remember}
                      openQuestion={(resume, text) => {
                        if (!resume && question.running()) {
                          asking.set(true);
                          return;
                        }
                        if (!resume) question.reset();
                        asking.set(true);
                        if (!resume && text) {
                          remember(text);
                          void question.ask(text, false);
                        }
                      }}
                      openBot={props.openBot}
                      vacate={props.vacate}
                      open={props.open}
                      quick={quick}
                      usage={usage}
                      query={query}
                      failure={failure}
                      page={page}
                      scope={scope}
                      selection={selection}
                      enter={enter}
                      leave={leave}
                    />
                  }
                >
                  <QuickQuestionPanel question={question} back={() => asking.set(false)} />
                </If>
              }
            >
              <QuickEditor editor={editor()!} back={() => editor.set(null)} />
            </If>
          }
        >
          <View style={[frameStyle(), { maxHeight: MAX_HEIGHT }]}>{props.conversation()}</View>
        </If>
      </Window>
    </>
  );
}
