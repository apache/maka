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

import {
  cleanup,
  host as surfaceHost,
  effect,
  keymap,
  signal,
  untracked,
  Text,
  View,
  Image,
  Scroll,
  type InputRef,
  type ViewRef,
  type ScrollRef,
  type JSX,
} from 'nsh';
import { Button, Checkbox, Dialog, Input } from 'nsh/base';
import { host } from 'maka/host';
import { createAssistantInbox } from '../../../../plugins/application/quick-tools/runtime/inbox';
import { FieldError } from '../../../../plugins/application/quick-tools/shared/field-error';
import { QuickTools, type Page } from '../../../../plugins/application/quick-tools/runtime/engine';
import type { QuickLocale } from '../../../../plugins/application/quick-tools/shared/i18n';
import {
  completeInput,
  recallInput,
} from '../../../../plugins/application/quick-tools/shared/input-history';
import type {
  Action,
  PackagePreview,
  ResultRow,
  View as ToolView,
} from '../../../../plugins/application/quick-tools/shared/plugin';
import { currentLocale } from './locale';
import { loadDraft, saveDraft } from './host';
import type { OperationReply } from '../../../../packages/plugin-sdk/src/index.js';
import { C, isDark, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';

import { toolIcon } from './QuickToolIcon';
import { Icon } from './Icon';
import { serveQuickSettings } from './quickSettings';
import { QuickShortcutRecorder } from './QuickShortcutRecorder';
import { IconButton } from './ui';

import {
  QuickToolsBar,
  QuickToolsMark,
  quickToolsLabel as qt,
  quickFieldText as compactText,
  quickFieldHeight,
  quickFieldPadding,
  quickFieldStyle,
} from './QuickToolsBar';
function ErrorHint(props: { message: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
      <Text
        accessibilityElementsHidden
        style={{ fontSize: 14, lineHeight: 18, color: isDark() ? C.danger : '#a0413c' }}
      >
        ⓘ
      </Text>
      <Text
        style={{ flex: 1, fontSize: 12, lineHeight: 18, color: isDark() ? C.danger : '#a0413c' }}
      >
        {props.message}
      </Text>
    </View>
  );
}
/** NSH components: the same native view runs on GPUI and AppKit. */
export function QuickToolsSurface(props: {
  opened(): boolean;
  close(): void;
  openAssistant(sessionId: string): Promise<boolean>;
  prepareAssistant?(sessionId: string): Promise<void>;
  keepOpenAfterAssistant?: boolean;
  beforeItemShortcut?(): Promise<boolean>;
  attachSettings?(open: () => void): void;
}) {
  const locale = (): QuickLocale =>
    currentLocale() === 'en' ? 'en' : currentLocale() === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  const version = signal(0),
    ready = signal(false),
    query = signal('');
  const page = signal<Page>(null),
    result = signal<{ rows: ResultRow[]; view?: ToolView }>({ rows: [] });
  const index = signal(0),
    actions = signal(false),
    actionIndex = signal(0);
  const settings = signal(false),
    busy = signal(false),
    error = signal('');
  props.attachSettings?.(() => settings.set(true));
  const editor = signal<{ plugin: string; action: Action; row?: ResultRow } | null>(null);
  const confirmation = signal<{ plugin: string; action: Action; row?: ResultRow } | null>(null);
  const values = signal<Record<string, string | boolean>>({});
  const packagePreview = signal<PackagePreview | null>(null);
  const actionQuery = signal(''),
    expandedPlugin = signal<string | null>(null);
  const orderLocked = signal(false);
  const drafts = new Map<string, Record<string, string | boolean>>();
  const draftKey = (value: NonNullable<ReturnType<typeof editor>>) =>
    `${value.plugin}/${value.action.form?.draftKey ?? value.action.id}/${value.row?.id ?? ''}`;
  const rememberEditor = () => {
    const current = editor();
    if (current && current.action.id !== '$preferences') {
      drafts.set(draftKey(current), { ...values() });
      if (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
    }
  };
  const commandHeld = signal(false);
  surfaceHost.on('quickTools.modifiers', (value) =>
    commandHeld.set((value as { command: boolean }).command),
  );
  const composing = signal(false),
    atEnd = signal(true),
    dismissed = signal<string | null>(null);
  let cursor = { index: -1, draft: '', text: '' },
    input: InputRef | null = null,
    alive = true,
    revision = 0;
  let searchAbort = new AbortController();
  const fieldError = signal<FieldError | null>(null);
  const clearErrors = () => {
    fieldError.set(null);
    error.set('');
  };
  const editValue = (field: string, value: string | boolean) => {
    values.set({ ...values(), [field]: value });
    if (fieldError()?.field === field) fieldError.set(null);
  };
  const report = (cause: unknown) => {
    if (alive) error.set(cause instanceof Error ? cause.message : String(cause));
  };
  const inbox = createAssistantInbox(report);
  const engine = new QuickTools({
    changed: () => untracked(() => version.set(version() + 1)),
    report,
    close: props.close,
    appearance: () => (isDark() ? 'dark' : 'light'),
    assistant: async (text) => {
      const response = (await host.mutation('agent', 'openBot', {})) as { reply: OperationReply };
      const receipt = response.reply?.receipt;
      if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned')
        throw Error(qt('无法打开个人助手'));
      const value = receipt.outcome.value;
      if (
        !value ||
        typeof value !== 'object' ||
        !('kind' in value) ||
        value.kind !== 'opened' ||
        !('sessionId' in value) ||
        typeof value.sessionId !== 'string'
      )
        throw Error(qt('无法打开个人助手'));
      const id = value.sessionId;
      await props.prepareAssistant?.(id);
      if (text) {
        const session = host.session(id),
          draft = await loadDraft(session);
        if (draft?.text?.trim()) throw Error(qt('助手已有未发送草稿，请先处理草稿'));
        await saveDraft(session, draft.revision, {
          text,
          attachments: draft?.attachments ?? [],
        });
      }
      if (alive && (await props.openAssistant(id))) {
        query.set('');
        if (!props.keepOpenAfterAssistant) props.close();
      }
    },
  });
  const resetHome = () => {
    clearErrors();
    rememberEditor();
    if (packagePreview()) engine.packages.cancel(packagePreview()!.token);
    packagePreview.set(null);
    confirmation.set(null);
    editor.set(null);
    settings.set(false);
    actions.set(false);
    page.set(null);
    change('');
  };
  surfaceHost.on('quickTools.visibility', (value) => {
    const event = value as {
      visible: boolean;
      home?: boolean;
      settings?: boolean;
      source?: { pid?: number };
    };
    if (event.visible) {
      engine.setSource(event.source?.pid);
      if (event.home) resetHome();
      if (event.settings) settings.set(true);
      if (!query() && !page() && !editor() && !settings() && !actions()) orderLocked.set(false);
    } else commandHeld.set(false);
  });
  effect(() => {
    if (surfaceHost.params.quickToolsPanel && props.opened())
      void surfaceHost
        .call('quickTools.resize', {
          height: settings() || (editor() && editor()?.plugin !== 'maka.links') ? 560 : 400,
        })
        .catch(report);
  });
  const started = engine.start(locale());
  if (surfaceHost.params.quickToolsPanel)
    serveQuickSettings(engine, started, version, ready, locale);
  void started
    .then(() => {
      if (alive) ready.set(true);
    })
    .catch((cause) => {
      report(cause);
      if (alive) ready.set(true);
    });
  cleanup(() => {
    alive = false;
    searchAbort.abort();
    void engine.dispose();
  });
  effect(() => {
    engine.locale(locale());
  });
  const installed = () => {
    version();
    return engine.installed();
  };
  const selected = () => result().rows[Math.min(index(), Math.max(0, result().rows.length - 1))];
  const offered = () => {
    version();
    return !composing() && atEnd() && dismissed() !== query()
      ? completeInput(engine.history.search, query())
      : undefined;
  };
  effect(() => {
    if (!offered() || !props.opened() || editor() || settings() || actions() || !input) return;
    return keymap.bind(
      'tab',
      () => {
        const text = offered();
        if (text && !composing()) {
          change(text);
          dismissed.set(text);
        }
      },
      { within: input, when: 'always' },
    );
  });
  const rowMenu = () => {
    const row = selected();
    return row
      ? [
          ...row.actions,
          ...(!row.actions.length
            ? []
            : [
                {
                  id: '$preferences',
                  title: qt('设置'),
                  form: {
                    title: qt('设置'),
                    fields: [
                      { id: 'alias', label: qt('别名'), maxLength: 80 },
                      { id: 'shortcut', label: qt('快捷键'), maxLength: 100 },
                      { id: 'favorite', label: qt('收藏'), type: 'checkbox' as const },
                    ],
                    values: {
                      alias: engine.alias(row),
                      shortcut: engine.shortcut(row),
                      favorite: engine.favorite(row),
                    },
                  },
                },
              ]),
        ]
      : [];
  };
  const menu = () => {
    const target = page();
    return [
      ...rowMenu().map((action) => ({ action, plugin: selected()?.plugin ?? '', row: selected() })),
      ...(target
        ? (result().view?.actions ?? []).map((action) => ({
            action,
            plugin: target.plugin,
            row: undefined,
          }))
        : []),
      ...(engine.history.search.length || engine.history.assistant.length
        ? [
            {
              action: { id: '$clearHistory', title: qt('清空输入历史') },
              plugin: '$host',
              row: undefined,
            },
          ]
        : []),
    ].filter(({ action }) =>
      action.title.toLocaleLowerCase().includes(actionQuery().trim().toLocaleLowerCase()),
    );
  };
  const toggleActions = () => {
    orderLocked.set(true);
    actionQuery.set('');
    actionIndex.set(0);
    actions.set(!actions());
  };
  let resultScroll: ScrollRef | undefined, actionScroll: ScrollRef | undefined;
  let resultHeight = 400,
    actionHeight = 280,
    resultOffset = 0,
    noticeHeight = 0,
    actionOffset = 0;
  const reveal = (at: number, menu = false) => {
    const rowHeight = menu ? 36 : 40,
      height = menu ? actionHeight : resultHeight;
    const offset = menu ? actionOffset : resultOffset,
      top = at * rowHeight + (!menu && result().view?.notice ? noticeHeight : 0);
    if (top < offset || top + rowHeight > offset + height) {
      const next = top < offset ? top : top + rowHeight - height;
      (menu ? actionScroll : resultScroll)?.scrollTo({ y: next, animated: false });
    }
  };
  const select = (at: number) => {
    orderLocked.set(true);
    index.set(Math.max(0, Math.min(result().rows.length - 1, at)));
    reveal(index());
  };
  const selectAction = (at: number) => {
    actionIndex.set(Math.max(0, Math.min(menu().length - 1, at)));
    reveal(actionIndex(), true);
  };
  let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => {
    if (suggestionTimer !== undefined) clearTimeout(suggestionTimer);
  });
  let pendingSearch: Promise<void> = Promise.resolve();
  const update = async () => {
    version();
    if (!ready() || !props.opened() || editor() || settings() || composing()) return;
    const ticket = ++revision;
    if (suggestionTimer !== undefined) clearTimeout(suggestionTimer);
    searchAbort.abort();
    searchAbort = new AbortController();
    try {
      const next = await engine.search(page(), query(), searchAbort.signal);
      if (alive && ticket === revision) {
        if (!page() && !query().trim() && inbox.unread() > 0 && !orderLocked() && !actions()) {
          next.rows.sort(
            (a, b) =>
              Number(b.plugin === 'maka.assistant' && b.id === 'open') -
              Number(a.plugin === 'maka.assistant' && a.id === 'open'),
          );
        }
        result.set(next);
        index.set(Math.max(0, Math.min(index(), next.rows.length - 1)));
        if (!page() && query().trim().length >= 2) {
          const text = query(),
            signal = searchAbort.signal;
          suggestionTimer = setTimeout(() => {
            void engine
              .suggest(text, next.rows, signal)
              .then((rows) => {
                if (
                  rows &&
                  alive &&
                  ticket === revision &&
                  !orderLocked() &&
                  !commandHeld() &&
                  index() === 0 &&
                  !actions() &&
                  !editor()
                )
                  result.set({ ...next, rows });
              })
              .catch((cause) => {
                if (!signal.aborted) console.warn('Quick Tools ranking:', String(cause));
              });
          }, 600);
        }
      }
    } catch (cause) {
      if (alive && ticket === revision && !searchAbort.signal.aborted) report(cause);
    }
  };
  effect(() => {
    version();
    ready();
    props.opened();
    page();
    query();
    settings();
    editor();
    pendingSearch = update();
  });
  const change = (text: string) => {
    orderLocked.set(false);
    query.set(text);
    index.set(0);
    actions.set(false);
    cursor = { index: -1, draft: '', text: '' };
    dismissed.set(null);
  };
  const permissionLabels = (): Record<string, string> => ({
    'web.run': qt('执行声明的网页只读命令'),
    'web.connect': qt('连接已有 OpenCLI 浏览器扩展'),
    'assistant.open': qt('打开个人助手并发送所选消息'),
    'model.rank': qt('使用配置的模型推荐选项'),
    'applications.list': qt('发现应用'),
    'system.open': qt('打开网址和文件'),
    'system.reveal': qt('显示文件位置'),
    'clipboard.read': qt('读取剪贴板'),
    'clipboard.write': qt('写入剪贴板'),
    'clipboard.watch': qt('观察剪贴板变化'),
    paste: qt('粘贴到原应用'),
    'text.transliterate': qt('文字拼音转换'),
    'screenshots.capture': qt('截图'),
    'screenshots.pin': qt('置顶贴图'),
  });

  const back = () => {
    if (busy()) return;
    if (packagePreview()) {
      engine.packages.cancel(packagePreview()!.token);
      packagePreview.set(null);
      return;
    }
    if (confirmation()) {
      confirmation.set(null);
      return;
    }
    if (editor()) {
      clearErrors();
      rememberEditor();
      editor.set(null);
      return;
    }
    if (actions()) {
      actions.set(false);
      input?.focus();
      return;
    }
    if (settings()) {
      settings.set(false);
      return;
    }
    if (offered()) {
      dismissed.set(query());
      return;
    }
    if (page()) {
      page.set(null);
      change('');
      return;
    }
    props.close();
  };
  const execute = async (plugin: string, action: Action, confirmed = false, origin?: ResultRow) => {
    const row = origin ?? editor()?.row ?? confirmation()?.row;
    if (busy()) return;
    if (action.form && !editor()) {
      clearErrors();
      const next = { plugin, action, row };
      values.set({
        ...(action.id === '$preferences'
          ? action.form.values
          : (drafts.get(draftKey(next)) ?? action.form.values)),
      });
      editor.set(next);
      actions.set(false);
      return;
    }
    if (action.confirm && !confirmed) {
      confirmation.set({ plugin, action, row });
      actions.set(false);
      return;
    }
    if (editor())
      for (const field of action.form?.fields ?? []) {
        const value = values()[field.id];
        if (field.required && !(typeof value === 'string' ? value.trim() : value)) {
          clearErrors();
          fieldError.set(new FieldError(field.id, qt('请填写${0}', field.label)));
          return;
        }
      }
    const text = query();
    busy.set(true);
    clearErrors();
    try {
      if (action.id === '$clearHistory') {
        await engine.clearHistory();
        cursor = { index: -1, draft: '', text: '' };
        dismissed.set(null);
        actions.set(false);
        input?.focus();
        return;
      }
      if (action.id === '$removePackage' || action.id === '$rollbackPackage') {
        if (action.id === '$removePackage') await engine.removePackage(String(action.data));
        else await engine.rollbackPackage(String(action.data));
        confirmation.set(null);
        version.set(version() + 1);
        return;
      }
      if (action.id === '$preferences') {
        if (!row) throw Error('Missing item for preferences');
        await engine.configureItem(row, String(values().shortcut ?? ''), {
          alias: String(values().alias ?? '')
            .trim()
            .slice(0, 80),
          favorite: Boolean(values().favorite),
        });
        editor.set(null);
        actions.set(false);
        return;
      }
      if (action.id === '$shortcut' || action.id === '$globalShortcut') {
        await engine.setShortcut(
          String(values().shortcut ?? ''),
          action.id === '$shortcut' ? row : undefined,
        );
        editor.set(null);
        actions.set(false);
        return;
      }
      if (action.id === '$alias') {
        if (!row) throw Error('Missing item for alias');
        await engine.preference(row, {
          alias: String(values().alias ?? '')
            .trim()
            .slice(0, 100),
        });
        editor.set(null);
        actions.set(false);
        return;
      }
      const submittedEditor = editor();
      const reply = await engine.run(plugin, action, values(), new AbortController().signal);
      if (row && !reply?.removed?.includes(row.id)) await engine.used(row);
      await engine.remember(text);
      if (submittedEditor) drafts.delete(draftKey(submittedEditor));
      editor.set(null);
      confirmation.set(null);
      actions.set(false);
      if (reply?.navigate) {
        page.set({ plugin, id: reply.navigate });
        change('');
      }
      version.set(version() + 1);
    } catch (cause) {
      if (cause instanceof FieldError && editor()) fieldError.set(cause);
      else report(cause);
    } finally {
      if (alive) busy.set(false);
    }
  };
  surfaceHost.on('quickTools.error', (value) => report(String(value)));
  surfaceHost.on('quickTools.execute', (value) => {
    void started
      .then(async () => {
        if (props.beforeItemShortcut && !(await props.beforeItemShortcut())) return;
        resetHome();
        const row = await engine.shortcutRow((value as { id: string }).id);
        if (row.actions[0]) await execute(row.plugin, row.actions[0], false, row);
      })
      .catch(report);
  });
  const choose = async (position = index()) => {
    const requestedQuery = query(),
      requestedPage = page();
    for (;;) {
      const pending = pendingSearch;
      await pending;
      if (!alive || query() !== requestedQuery || page() !== requestedPage || !props.opened())
        return;
      if (pending === pendingSearch) break;
    }
    if (actions()) {
      const item = menu()[position];
      if (item) void execute(item.plugin, item.action, false, item.row);
    } else {
      const row = result().rows[position];
      if (row?.actions[0]) void execute(row.plugin, row.actions[0], false, row);
    }
  };
  let menuKeys: (() => void)[] = [];
  cleanup(() => menuKeys.forEach((remove) => remove()));
  let unbind: (() => void)[] = [];
  cleanup(() => unbind.forEach((remove) => remove()));
  const bindKeys = (node: ViewRef) => {
    unbind.forEach((remove) => remove());
    const key = (name: string, run: () => void) =>
      keymap.bind(
        name,
        () => {
          if (!composing() && props.opened() && (!busy() || name === 'escape')) run();
        },
        {
          when: name === 'escape' || name.startsWith('mod+') ? 'always' : undefined,
          within: node,
          repeat: false,
        },
      );
    unbind = [
      key('escape', back),
      key('mod+k', () => {
        if (!editor() && !settings()) toggleActions();
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        key(`mod+${i + 1}`, () => {
          if (!editor() && !settings() && !confirmation()) {
            orderLocked.set(true);
            void choose(i);
          }
        }),
      ),
    ];
  };
  let searchKeys: (() => void)[] = [];
  cleanup(() => searchKeys.forEach((unbind) => unbind()));
  const bindSearch = (node: InputRef) => {
    searchKeys.forEach((unbind) => unbind());
    searchKeys = [
      keymap.bind(
        'enter',
        () => {
          if (!composing() && !busy()) void choose();
        },
        { within: node, when: 'always' },
      ),
      keymap.bind(
        'down',
        () => {
          if (composing()) return;
          if (cursor.index >= 0) {
            cursor = recallInput(engine.history.search, cursor.index, cursor.draft, query(), -1);
            query.set(cursor.text);
          } else select(index() + 1);
        },
        { within: node, when: 'always', repeat: true },
      ),
      keymap.bind(
        'up',
        () => {
          if (composing()) return;
          if (engine.history.search.length) {
            cursor = recallInput(engine.history.search, cursor.index, cursor.draft, query(), 1);
            query.set(cursor.text);
          } else select(index() - 1);
        },
        { within: node, when: 'always', repeat: true },
      ),
    ];
  };
  const button = (title: string, run: () => void) => (
    <Button
      accessibilityLabel={title}
      disabled={busy()}
      onPress={run}
      style={{
        ...controlStyle,
        minHeight: 32,
        paddingVertical: 6,
        alignSelf: 'flex-start',
        backgroundColor: title === qt('保存') ? C.accent : C.raised,
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <Text style={{ ...compactText, color: title === qt('保存') ? '#ffffff' : C.secondary }}>
        {title}
      </Text>
    </Button>
  );
  return (
    <>
      <If when={props.opened()}>
        <Dialog
          animation="none"
          onOpenChange={back}
          closeOnEscape={false}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: surfaceHost.params.quickToolsPanel ? C.surface : C.scrim,
            padding: surfaceHost.params.quickToolsPanel ? 0 : 24,
          }}
        >
          <View
            ref={bindKeys}
            style={{
              width: surfaceHost.params.quickToolsPanel ? '100%' : 720,
              maxWidth: '100%',
              height: surfaceHost.params.quickToolsPanel ? '100%' : 560,
              maxHeight: '100%',
              backgroundColor: C.surface,
              borderRadius: surfaceHost.params.quickToolsPanel ? 0 : 12,
              borderWidth: surfaceHost.params.quickToolsPanel ? 0 : 1,
              borderColor: C.line,
              overflow: 'hidden',
            }}
          >
            <QuickToolsBar showSettings={!settings()} openSettings={() => settings.set(true)}>
              <If when={page() || editor() || settings()} else={<QuickToolsMark />}>
                <IconButton label={qt('返回')} icon="back" onPress={back} />
              </If>
              <If when={!editor() && !settings()}>
                <View style={{ flex: 1, minWidth: 0, height: quickFieldHeight }}>
                  <If when={offered()}>
                    <Text
                      style={{
                        ...compactText,
                        position: 'absolute',
                        left: 0,
                        top: quickFieldPadding,
                        color: `${C.muted}99`,
                        pointerEvents: 'none',
                        numberOfLines: 1,
                      }}
                    >
                      <Text style={{ color: 'transparent' }}>{query()}</Text>
                      {offered()?.slice(query().length)}
                    </Text>
                  </If>
                  <Input
                    ref={(node) => {
                      input = node;
                      bindSearch(node);
                    }}
                    testID="quick-tools-input"
                    accessibilityLabel={qt('搜索')}
                    autoFocus
                    value={query()}
                    onChange={({ value }) => change(value)}
                    onSelectionChange={(event) =>
                      atEnd.set(event.start === query().length && event.end === query().length)
                    }
                    onCompositionChange={(event) => composing.set(event.composing)}
                    placeholder={
                      offered()
                        ? ''
                        : page()
                          ? qt('搜索${0}…', result().view?.title ?? '')
                          : qt('搜索应用、工具和插件…')
                    }
                    style={quickFieldStyle()}
                  />
                </View>
              </If>
              <If when={editor() || settings()}>
                <Text style={{ ...compactText, flex: 1, color: C.text }}>
                  {editor()?.action.form?.title ??
                    (settings() ? qt('快捷工具设置') : qt('个人助手'))}
                </Text>
              </If>
              <If when={inbox.unread()}>
                <IconButton
                  label={qt('助手有新消息')}
                  icon="unread"
                  selected
                  onPress={() => {
                    void execute('maka.assistant', { id: 'open', title: qt('个人助手') });
                  }}
                />
              </If>
            </QuickToolsBar>
            <If when={error()}>
              <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
                <ErrorHint message={error()} />
              </View>
            </If>
            <If when={settings()}>
              <Scroll style={{ flex: 1, padding: 20 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingBottom: 20,
                  }}
                >
                  {button(qt('全局快捷键'), () => {
                    settings.set(false);
                    void execute('$host', {
                      id: '$globalShortcut',
                      title: qt('全局快捷键'),
                      form: {
                        title: qt('全局快捷键'),
                        fields: [{ id: 'shortcut', label: qt('快捷键'), maxLength: 100 }],
                        values: { shortcut: engine.shortcut() },
                      },
                    });
                  })}
                  <Checkbox
                    accessibilityLabel={qt('全局快捷键')}
                    checked={Boolean(engine.shortcut())}
                    disabled={busy()}
                    onChange={({ checked }) => {
                      busy.set(true);
                      void engine
                        .setLauncherEnabled(checked)
                        .catch(report)
                        .finally(() => busy.set(false));
                    }}
                    style={{ padding: 6, flexDirection: 'row', gap: 8, alignItems: 'center' }}
                    indicatorStyle={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      borderWidth: 1,
                      borderColor: C.line,
                      backgroundColor: engine.shortcut() ? C.accent : C.background,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    indicator={
                      engine.shortcut() ? <Icon name="check" color="#ffffff" /> : undefined
                    }
                  >
                    <Text style={{ fontSize: 12, color: C.secondary }}>
                      {engine.shortcut() || qt('已停用')}
                    </Text>
                  </Checkbox>
                </View>
                {button(
                  qt('辅助功能权限'),
                  () => void engine.openAccessibilitySettings().catch(report),
                )}
                {button(qt('安装插件'), () => {
                  void surfaceHost
                    .call('quickTools.package.pick', {})
                    .then(async (text) => {
                      if (typeof text === 'string')
                        packagePreview.set(await engine.packages.preview(JSON.parse(text)));
                    })
                    .catch(report);
                })}

                <Text style={{ fontSize: 12, color: C.muted, paddingTop: 24, paddingBottom: 8 }}>
                  {qt('插件')} · {installed().length}
                </Text>
                <Each of={installed()} key={(item) => item.manifest.id}>
                  {(item) => (
                    <View style={{ borderBottomWidth: 1, borderColor: C.line }}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          paddingVertical: 4,
                        }}
                      >
                        <Button
                          accessibilityLabel={qt('插件详情：${0}', item().manifest.name)}
                          onPress={() =>
                            expandedPlugin.set(
                              expandedPlugin() === item().manifest.id ? null : item().manifest.id,
                            )
                          }
                          style={{
                            flex: 1,
                            minWidth: 0,
                            paddingVertical: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                          }}
                          hoverStyle={controlHoverStyle()}
                        >
                          {toolIcon(item().manifest.icon, item().manifest.id)}
                          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                            <Text style={{ ...compactText, color: C.text, numberOfLines: 1 }}>
                              {item().manifest.name}
                            </Text>
                            <If when={item().manifest.description !== item().manifest.name}>
                              <Text
                                style={{
                                  fontSize: 12,
                                  lineHeight: 16,
                                  color: C.muted,
                                  numberOfLines: 1,
                                }}
                              >
                                {item().manifest.description}
                              </Text>
                            </If>
                          </View>
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {item().manifest.version}
                          </Text>
                          <Icon
                            name={expandedPlugin() === item().manifest.id ? 'down' : 'right'}
                            color={C.muted}
                          />
                        </Button>
                        <Checkbox
                          accessibilityLabel={qt('启用 ${0}', item().manifest.name)}
                          checked={item().enabled}
                          disabled={busy()}
                          onChange={({ checked }) => {
                            busy.set(true);
                            void engine
                              .enable(item().manifest.id, checked)
                              .catch(report)
                              .finally(() => busy.set(false));
                          }}
                          style={{ padding: 6 }}
                          indicatorStyle={{
                            width: 20,
                            height: 20,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: C.line,
                            backgroundColor: item().enabled ? C.accent : C.background,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          indicator={
                            item().enabled ? <Icon name="check" color="#ffffff" /> : undefined
                          }
                        />
                      </View>
                      <If when={expandedPlugin() === item().manifest.id}>
                        <View style={{ paddingLeft: 42, paddingBottom: 16, gap: 8 }}>
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {item().manifest.id} · {item().manifest.version}
                          </Text>
                          <Text style={{ ...compactText, color: C.secondary }}>
                            {item().manifest.description}
                          </Text>
                          <Text style={{ fontSize: 12, color: C.secondary }}>
                            {qt('声明权限：')}
                            {item()
                              .manifest.permissions.map(
                                (permission) => permissionLabels()[permission] ?? permission,
                              )
                              .join(' · ') || qt('无系统权限')}
                          </Text>
                          <If
                            when={engine.packages.records.find(
                              (record) => record.bundle.manifest.id === item().manifest.id,
                            )}
                          >
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              {button(qt('更新…'), () => {
                                void surfaceHost
                                  .call('quickTools.package.pick', {})
                                  .then(async (text) => {
                                    if (typeof text !== 'string') return;
                                    const preview = await engine.packages.preview(JSON.parse(text));
                                    if (preview.manifest.id !== item().manifest.id) {
                                      engine.packages.cancel(preview.token);
                                      throw Error(qt('请选择同一个插件的更新包'));
                                    }
                                    packagePreview.set(preview);
                                  })
                                  .catch(report);
                              })}
                              <If
                                when={
                                  engine.packages.records.find(
                                    (record) => record.bundle.manifest.id === item().manifest.id,
                                  )?.previous
                                }
                              >
                                {button(
                                  qt('回退'),
                                  () =>
                                    void execute('$host', {
                                      id: '$rollbackPackage',
                                      title: qt('回退'),
                                      data: item().manifest.id,
                                      confirm: qt('确认回退插件？'),
                                    }),
                                )}
                              </If>
                              {button(
                                qt('卸载'),
                                () =>
                                  void execute('$host', {
                                    id: '$removePackage',
                                    title: qt('卸载'),
                                    data: item().manifest.id,
                                    confirm: qt('确认卸载插件？'),
                                  }),
                              )}
                            </View>
                          </If>
                        </View>
                      </If>
                    </View>
                  )}
                </Each>
                <View style={{ paddingTop: 24, paddingBottom: 8, alignItems: 'flex-start' }}>
                  {button(qt('清空输入历史'), () => void engine.clearHistory().catch(report))}
                </View>
              </Scroll>
            </If>
            <If when={editor() && !settings()}>
              <Scroll style={{ flex: 1, padding: 20 }}>
                <If when={editor()?.action.id === '$preferences' && editor()?.row}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingBottom: 16,
                      marginBottom: 16,
                      borderBottomWidth: 1,
                      borderColor: C.line,
                    }}
                  >
                    {toolIcon(editor()?.row?.icon, editor()?.row?.plugin)}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ ...compactText, color: C.text, numberOfLines: 1 }}>
                        {editor()?.row?.name}
                      </Text>
                      <Text style={{ fontSize: 12, color: C.muted, numberOfLines: 1 }}>
                        {editor()?.row?.pluginName === editor()?.row?.name
                          ? qt('自定义快捷访问方式')
                          : editor()?.row?.pluginName}
                      </Text>
                    </View>
                  </View>
                </If>
                <Each of={editor()?.action.form?.fields ?? []} key={(field) => field.id}>
                  {(field) => (
                    <View
                      style={{
                        gap: 12,
                        paddingBottom: 16,
                        flexDirection: editor()?.action.id === '$preferences' ? 'row' : 'column',
                        alignItems: editor()?.action.id === '$preferences' ? 'center' : 'stretch',
                      }}
                    >
                      <View
                        style={{
                          width: editor()?.action.id === '$preferences' ? 190 : '100%',
                          gap: 2,
                        }}
                      >
                        <Text style={{ ...compactText, color: C.text }}>{field().label}</Text>
                        <If when={editor()?.action.id === '$preferences'}>
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {qt(
                              field().id === 'alias'
                                ? '用简短名称快速搜索'
                                : field().id === 'shortcut'
                                  ? '在任意应用中直接唤起'
                                  : '在首页优先显示',
                            )}
                          </Text>
                        </If>
                      </View>
                      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                        <If when={field().id === 'shortcut'} else={''}>
                          <QuickShortcutRecorder
                            value={String(values().shortcut ?? '')}
                            onChange={(value) => editValue('shortcut', value)}
                          />
                        </If>
                        <If when={field().id !== 'shortcut'}>
                          <If
                            when={field().type === 'checkbox'}
                            else={
                              <Input
                                accessibilityLabel={field().label}
                                autoFocus={editor()?.action.form?.fields[0]?.id === field().id}
                                onSubmit={() => {
                                  if (field().type !== 'textarea') {
                                    const form = editor();
                                    if (form)
                                      void execute(form.plugin, form.action, false, form.row);
                                  }
                                }}
                                value={String(values()[field().id] ?? '')}
                                multiline={field().type === 'textarea'}
                                onChange={({ value }) =>
                                  editValue(field().id, value.slice(0, field().maxLength ?? 100000))
                                }
                                style={{
                                  ...compactText,
                                  color: C.text,
                                  padding: 8,
                                  borderWidth: 1,
                                  borderColor:
                                    fieldError()?.field === field().id
                                      ? isDark()
                                        ? C.danger
                                        : '#b96761'
                                      : C.line,
                                  borderRadius: 6,
                                  minHeight: field().type === 'textarea' ? 112 : 40,
                                  backgroundColor: C.background,
                                }}
                              />
                            }
                          >
                            <Checkbox
                              accessibilityLabel={field().label}
                              checked={Boolean(values()[field().id])}
                              disabled={busy()}
                              onChange={({ checked }) => editValue(field().id, checked)}
                              style={{ alignSelf: 'flex-end', padding: 6 }}
                              indicatorStyle={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                borderWidth: 1,
                                borderColor: C.line,
                                backgroundColor: values()[field().id] ? C.accent : C.background,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              indicator={
                                values()[field().id] ? (
                                  <Icon name="check" color="#ffffff" />
                                ) : undefined
                              }
                            />
                          </If>
                        </If>
                        <If when={fieldError()?.field === field().id}>
                          <ErrorHint message={fieldError()?.message ?? ''} />
                        </If>
                      </View>
                    </View>
                  )}
                </Each>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'flex-end',
                    gap: 8,
                    paddingTop: 12,
                  }}
                >
                  {button(qt('取消'), back)}
                  {button(qt('保存'), () => {
                    const form = editor();
                    if (form) void execute(form.plugin, form.action, false, form.row);
                  })}
                </View>
              </Scroll>
            </If>
            <If when={!editor() && !settings()}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 20,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ fontSize: 12, color: C.muted, flex: 1 }}>
                  {result().view?.title ?? qt('Maka 快捷工具')}
                </Text>
                <If when={busy()}>
                  <Text style={{ fontSize: 12, color: C.muted }}>{qt('正在执行，请稍候…')}</Text>
                </If>
              </View>
              <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
                <Scroll
                  ref={(node) => {
                    resultScroll = node;
                  }}
                  onLayout={({ bounds }) => {
                    resultHeight = bounds.size.height;
                  }}
                  onScroll={({ offset }) => {
                    resultOffset = offset.y;
                  }}
                  onScrollDragStart={() => orderLocked.set(true)}
                  onScrollIntent={() => orderLocked.set(true)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <If when={result().view?.notice}>
                    <Text
                      onLayout={({ bounds }) => {
                        noticeHeight = bounds.size.height;
                      }}
                      style={{ ...compactText, color: C.secondary, padding: 16 }}
                    >
                      {result().view?.notice}
                    </Text>
                  </If>
                  <If when={!ready()}>
                    <Text style={{ ...compactText, color: C.muted, padding: 16 }}>
                      {qt('正在加载…')}
                    </Text>
                  </If>

                  <Each of={result().rows} key={(row) => engine.itemKey(row)}>
                    {(row, position) => (
                      <View
                        role="button"
                        focusable
                        accessibilityState={{ selected: index() === position() }}
                        accessibilityLabel={row().name}
                        onPress={(event) => {
                          select(position());
                          input?.focus();
                          if (event.clickCount === 2) void choose(position());
                        }}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 4,
                          height: 40,
                          minHeight: 40,
                          marginHorizontal: 8,
                          borderRadius: 8,
                          backgroundColor: index() === position() ? C.raised : 'transparent',
                          alignItems: 'center',
                          flexDirection: 'row',
                          gap: 12,
                        }}
                        hoverStyle={controlHoverStyle()}
                      >
                        {toolIcon(
                          row().icon ??
                            installed().find((item) => item.manifest.id === row().plugin)?.manifest
                              .icon,
                          row().plugin,
                        )}
                        <View
                          style={{
                            flex: 1,
                            minWidth: 0,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <Text
                            style={{
                              ...compactText,
                              color: C.text,
                              numberOfLines: 1,
                              flexShrink: 1,
                              minWidth: 0,
                            }}
                          >
                            {row().name}
                          </Text>
                          <Text
                            style={{
                              color: C.muted,
                              maxWidth: '45%',
                              flexShrink: 2,
                              minWidth: 0,
                              fontSize: 12,
                              lineHeight: 16,
                              numberOfLines: 1,
                            }}
                          >
                            {row().plugin === 'maka.assistant' &&
                            row().id === 'open' &&
                            inbox.unread() > 0
                              ? inbox.preview()
                              : row().pluginName !== row().name && row().pluginName !== row().kind
                                ? row().pluginName
                                : ''}
                          </Text>
                        </View>
                        <If
                          when={
                            row().plugin === 'maka.assistant' &&
                            row().id === 'open' &&
                            inbox.unread() > 0
                          }
                        >
                          <Text
                            accessibilityLabel={qt('${0} 条未读消息', inbox.unread())}
                            style={{
                              fontSize: 11,
                              color: C.background,
                              backgroundColor: C.accent,
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 8,
                              flexShrink: 0,
                            }}
                          >
                            {inbox.unread() > 99 ? '99+' : String(inbox.unread())}
                          </Text>
                        </If>
                        <Text
                          style={{
                            fontSize: 12,
                            color: C.muted,
                            minWidth: 36,
                            textAlign: 'right',
                            flexShrink: 0,
                          }}
                        >
                          {commandHeld() && position() < 9
                            ? keymap.label(`mod+${position() + 1}`)
                            : (row().kind ?? '')}
                        </Text>
                      </View>
                    )}
                  </Each>
                  <If when={ready() && !result().rows.length}>
                    <Text style={{ ...compactText, color: C.muted, padding: 16 }}>
                      {qt('没有匹配结果')}
                    </Text>
                  </If>
                </Scroll>
                <If when={selected()?.detail || selected()?.image}>
                  <Scroll
                    style={{ width: '38%', padding: 16, borderLeftWidth: 1, borderColor: C.line }}
                  >
                    <If
                      when={selected()?.image}
                      else={
                        <Text style={{ ...compactText, color: C.secondary }}>
                          {selected()?.detail}
                        </Text>
                      }
                    >
                      <Image src={selected()?.image ?? ''} style={{ width: '100%', height: 240 }} />
                    </If>
                  </Scroll>
                </If>
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  alignItems: 'center',
                  gap: 8,
                  borderTopWidth: 1,
                  borderColor: C.line,
                }}
              >
                <Each of={result().view?.actions ?? []} key={(action) => action.id}>
                  {(action) =>
                    button(action().title, () => {
                      const target = page();
                      if (target) void execute(target.plugin, action());
                    })
                  }
                </Each>
                <View style={{ flex: 1 }} />
                <If when={selected()?.actions[0]}>
                  {button(`${selected()!.actions[0].title} ↵`, () => void choose())}
                </If>
                <If when={selected()?.actions.length}>
                  <IconButton
                    label={qt('条目设置')}
                    icon="settings"
                    onPress={() => {
                      const row = selected(),
                        action = rowMenu().find((item) => item.id === '$preferences');
                      if (row && action) void execute(row.plugin, action, false, row);
                    }}
                  />
                </If>
                {button(qt('操作 ⌘ K'), toggleActions)}
              </View>
            </If>
            <If when={actions()}>
              <View style={{ position: 'absolute', top: 60, left: 0, right: 0, bottom: 0 }}>
                <View
                  onPress={() => {
                    actions.set(false);
                    input?.focus();
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: C.scrim,
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 48,
                    width: 300,
                    maxWidth: '90%',
                    maxHeight: '90%',
                    backgroundColor: C.surface,
                    borderWidth: 1,
                    borderColor: C.line,
                    borderRadius: 10,
                    overflow: 'hidden',
                  }}
                >
                  <Input
                    autoFocus
                    accessibilityLabel={qt('搜索操作')}
                    placeholder={qt('搜索操作…')}
                    value={actionQuery()}
                    ref={(node) => {
                      menuKeys.forEach((remove) => remove());
                      menuKeys = [
                        keymap.bind('up', () => selectAction(actionIndex() - 1), {
                          within: node,
                          when: 'always',
                          repeat: true,
                        }),
                        keymap.bind('down', () => selectAction(actionIndex() + 1), {
                          within: node,
                          when: 'always',
                          repeat: true,
                        }),
                        keymap.bind('enter', () => void choose(actionIndex()), {
                          within: node,
                          when: 'always',
                        }),
                      ];
                    }}
                    onChange={({ value }) => {
                      actionQuery.set(value);
                      actionIndex.set(0);
                    }}
                    style={{
                      ...compactText,
                      height: 40,
                      padding: 12,
                      color: C.text,
                      placeholderColor: C.muted,
                      borderBottomWidth: 1,
                      borderColor: C.line,
                    }}
                  />
                  <Scroll
                    ref={(node) => {
                      actionScroll = node;
                    }}
                    onLayout={({ bounds }) => {
                      actionHeight = bounds.size.height;
                    }}
                    onScroll={({ offset }) => {
                      actionOffset = offset.y;
                    }}
                    style={{ maxHeight: 280 }}
                  >
                    <Each of={menu()} key={(item) => `${item.plugin}:${item.action.id}`}>
                      {(item, position) => (
                        <Button
                          accessibilityLabel={item().action.title}
                          disabled={busy()}
                          selected={actionIndex() === position()}
                          onPress={() => void choose(position())}
                          style={{
                            height: 36,
                            paddingHorizontal: 12,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                          }}
                          selectedStyle={{ backgroundColor: C.raised }}
                          hoverStyle={controlHoverStyle()}
                        >
                          <Text style={{ ...compactText, flex: 1, color: C.text }}>
                            {item().action.title}
                          </Text>
                          <Text style={{ fontSize: 12, color: C.muted }}>
                            {commandHeld() && position() < 9
                              ? keymap.label(`mod+${position() + 1}`)
                              : ''}
                          </Text>
                        </Button>
                      )}
                    </Each>
                    <If when={!menu().length}>
                      <Text style={{ ...compactText, padding: 12, color: C.muted }}>
                        {qt('没有结果')}
                      </Text>
                    </If>
                  </Scroll>
                </View>
              </View>
            </If>
            <If when={packagePreview()}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  backgroundColor: C.scrim,
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                }}
              >
                <Scroll
                  style={{
                    maxHeight: '90%',
                    width: '100%',
                    maxWidth: 480,
                    backgroundColor: C.surface,
                    borderRadius: 10,
                    padding: 20,
                  }}
                >
                  <View style={{ gap: 12 }}>
                    <Text style={{ ...compactText, color: C.text }}>
                      {packagePreview()?.manifest.name} · {packagePreview()?.manifest.version}
                    </Text>
                    <Text style={{ ...compactText, color: C.secondary }}>
                      {packagePreview()?.manifest.description}
                    </Text>
                    <Text style={{ ...compactText, color: C.secondary }}>
                      {qt('声明权限：')}
                      {packagePreview()
                        ?.manifest.permissions.map(
                          (permission) => permissionLabels()[permission] ?? permission,
                        )
                        .join(' · ') || qt('无系统权限')}
                    </Text>
                    <Text style={{ color: C.muted, fontSize: 11 }}>
                      SHA-256: {packagePreview()?.digest}
                    </Text>
                    {button(qt('安装'), () => {
                      const preview = packagePreview();
                      if (!preview || busy()) return;
                      busy.set(true);
                      void engine
                        .installPackage(preview.token)
                        .then(() => {
                          packagePreview.set(null);
                          version.set(version() + 1);
                        })
                        .catch(report)
                        .finally(() => busy.set(false));
                    })}
                    {button(qt('取消'), () => {
                      if (packagePreview()) engine.packages.cancel(packagePreview()!.token);
                      packagePreview.set(null);
                    })}
                  </View>
                </Scroll>
              </View>
            </If>
            <If when={confirmation()}>
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: C.scrim,
                  justifyContent: 'center',
                  alignItems: 'center',
                  padding: 24,
                }}
              >
                <View
                  style={{
                    width: 400,
                    maxWidth: '100%',
                    padding: 20,
                    gap: 16,
                    borderRadius: 12,
                    backgroundColor: C.surface,
                  }}
                >
                  <Text style={{ ...compactText, color: C.text }}>
                    {confirmation()?.action.confirm}
                  </Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                    {button(qt('取消'), () => confirmation.set(null))}
                    {button(qt('确认'), () => {
                      const pending = confirmation();
                      if (pending) void execute(pending.plugin, pending.action, true, pending.row);
                    })}
                  </View>
                </View>
              </View>
            </If>
          </View>
        </Dialog>
      </If>
    </>
  );
}
