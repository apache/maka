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

// The quick tools as one model, which the launcher and Settings › Quick tools both show: the same
// commands and the same pages, so a change in one is the change in the other.

import { cleanup, keymap, signal, Storage, View, type JSX, type Signal } from 'nsh';
import type {
  UiContributionRef,
  UiRuntime,
} from '../../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolHandle,
  type SettingsPageInput,
  type SettingsPageNavigation,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { PluginIcon } from './PluginIcon';
import { sameValue } from '../../../../plugins/shared/value';
import { localizedPresentation, tr } from './locale';
import { contributionTitle } from './plugins/context';
import {
  CommandSettings,
  createCommands,
  entryKey,
  LauncherShortcutRow,
  type Commands,
  type ToolEntry,
} from './QuickCommands';
import {
  RowLine,
  SettingsBody,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  SettingsSwitchControl,
  settingsGutter,
  settingsInset,
} from './SettingsPage';
import { errorText, renderText } from './text';

export type Attached = { tool: UiContributionRef; handle: QuickToolHandle };

const ENABLED_KEY = 'maka.quick-launcher.tools-enabled';

const DISABLED_KEY = 'maka.quick-launcher.disabled-plugins';
export const dictationTool = (tool: UiContributionRef) =>
  tool.instance.package.id === 'maka.dictation' && tool.id === 'tool';
export const conversationTool = (tool: UiContributionRef) =>
  tool.instance.package.id === 'maka.conversations' && tool.id === 'quickConversations';
export function quickPluginName(tool: UiContributionRef): string {
  if (conversationTool(tool)) return 'Maka';
  const { presentation, package: owner } = tool.instance;
  return (presentation && localizedPresentation(presentation).displayName) || owner.id;
}
const libraryTool = (tool: UiContributionRef) => tool.instance.package.id === 'maka.quick-library';
const pluginKey = (tool: UiContributionRef) =>
  JSON.stringify(libraryTool(tool) ? [...tool.instance.path, tool.id] : tool.instance.path);
const builtInNames: Partial<Record<string, Parameters<typeof tr>[0]>> = {
  'maka.calculator': 'Calculator',
  'maka.symbols': 'Symbols',
  'maka.file-search': 'Search files',
  'maka.applications': 'Applications',
};

export type QuickTools = {
  runtime: UiRuntime<JSX.Element>;
  /** Whether the launcher offers the tools at all; off until the user turns them on. */
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  syncQuestions(): boolean;
  setSyncQuestions(enabled: boolean): void;
  questionPreferenceReady: Promise<void>;
  /** Why the switch could not be read or saved. */
  failure(): unknown;
  ready(): boolean;
  toolEnabled(tool: UiContributionRef): boolean;
  toggleTool(tool: UiContributionRef): void;
  tools(): UiContributionRef[];
  /** What each tool attached, while the launcher's tools are mounted. */
  handles: Signal<ReadonlyMap<string, QuickToolHandle>>;
  attached(): Attached[];
  entries(): ToolEntry[];
  commands: Commands;
  /** The settings page the tool's plugin contributes, if any. */
  page(tool: UiContributionRef): UiContributionRef | undefined;
  /** Whether the tool has anything to set: commands, or a page. */
  configurable(tool: UiContributionRef): boolean;
  title(tool: UiContributionRef): string;
};

export function createQuickTools(runtime: UiRuntime<JSX.Element>): QuickTools {
  const enabled = signal(false);
  const failure = signal<unknown>(null);
  // A choice made before the stored one arrives wins over it.
  let chosen = false;
  Storage.getItem(ENABLED_KEY).then(
    (stored) => {
      if (!chosen) enabled.set(stored === 'true');
    },
    (reason) => failure.set(reason),
  );
  let saving: Promise<void> = Promise.resolve();
  const syncKey = 'maka.quick-launcher.sync-questions';
  const syncQuestions = signal(false);
  let syncChosen = false;
  const questionPreferenceReady = Storage.getItem(syncKey)
    .then((value) => {
      if (!syncChosen) syncQuestions.set(value === 'true');
    })
    .catch((reason) => failure.set(reason));
  const disabled = signal<ReadonlySet<string>>(new Set());
  const ready = signal(false);
  Storage.getItem(DISABLED_KEY)
    .then((raw) => {
      if (raw) {
        const keys: unknown = JSON.parse(raw);
        if (Array.isArray(keys))
          disabled.set(new Set(keys.filter((key) => typeof key === 'string')));
      }
    })
    .catch((reason) => failure.set(reason))
    .finally(() => ready.set(true));
  const toolEnabled = (tool: UiContributionRef) =>
    ready() &&
    !disabled().has(pluginKey(tool)) &&
    !(libraryTool(tool) && disabled().has(JSON.stringify(tool.instance.path)));
  const handles = signal<ReadonlyMap<string, QuickToolHandle>>(new Map());
  const tools = () =>
    runtime
      .contributions()
      .filter(
        (item) =>
          item.declaration.kind === 'view' && item.declaration.contract === quickToolView.id,
      );
  const attached = () =>
    tools()
      .filter(toolEnabled)
      .flatMap((tool) => {
        const handle = handles().get(tool.key);
        return handle === undefined ? [] : [{ tool, handle }];
      });
  const entries = () =>
    attached().flatMap(({ tool, handle }) =>
      handle.entries().map((entry) => ({ key: entryKey(tool, entry), tool, entry })),
    );
  const page = (tool: UiContributionRef) =>
    runtime
      .settings()
      .find(
        (item) =>
          sameValue(item.instance.instance, tool.instance.instance) &&
          (!libraryTool(tool) || item.id === `${tool.id}Settings`),
      );
  const ownEntries = (tool: UiContributionRef) =>
    entries().filter((item) => item.tool.key === tool.key);
  return {
    runtime,
    enabled,
    setEnabled(next) {
      chosen = true;
      enabled.set(next);
      const value = String(next);
      saving = saving
        .then(() => Storage.setItem(ENABLED_KEY, value))
        .catch((reason) => failure.set(reason));
    },
    syncQuestions,
    questionPreferenceReady,
    setSyncQuestions(next) {
      syncChosen = true;
      syncQuestions.set(next);
      saving = saving
        .then(() => Storage.setItem(syncKey, String(next)))
        .catch((reason) => failure.set(reason));
    },
    failure,
    tools,
    ready,
    toolEnabled,
    toggleTool(tool) {
      if (!ready()) return;
      const key = pluginKey(tool);
      const next = new Set(disabled());
      if (libraryTool(tool) && next.delete(JSON.stringify(tool.instance.path))) {
        for (const sibling of tools().filter((other) =>
          sameValue(other.instance.instance, tool.instance.instance),
        ))
          next.add(pluginKey(sibling));
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      disabled.set(next);
      const value = JSON.stringify([...next]);
      saving = saving
        .then(() => Storage.setItem(DISABLED_KEY, value))
        .catch((reason) => failure.set(reason));
    },
    handles,
    attached,
    entries,
    commands: createCommands((key) =>
      tools().some(
        (tool) =>
          !toolEnabled(tool) &&
          (libraryTool(tool)
            ? key === `${tool.instance.path.join('/')}/tool/${tool.id}`
            : key.startsWith(`${tool.instance.path.join('/')}/${tool.id}/`)),
      ),
    ),
    page,
    configurable: (tool) => page(tool) !== undefined || ownEntries(tool).length > 0,
    title(tool) {
      if (conversationTool(tool)) return quickPluginName(tool);
      const own = page(tool);
      if (own) return contributionTitle(own);
      const names = ownEntries(tool).map((item) => item.entry.title);
      if (names.length > 0) return names.join(' · ');
      const name = builtInNames[tool.instance.package.id];
      return name ? tr(name) : tool.instance.path.join(' / ');
    },
  };
}

/** One tool's settings: its commands' aliases and shortcuts, then its plugin's page, if any. */
export function QuickToolSettings(props: {
  quick: QuickTools;
  tool: UiContributionRef;
  recording: Signal<string | null>;
  /** Where the plugin's page registers its own navigation. */
  attach(navigation: SettingsPageNavigation): () => void;
}): JSX.Element {
  const { quick } = props;
  const entries = () => quick.entries().filter((item) => item.tool.key === props.tool.key);
  const page = () => quick.page(props.tool);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <If when={conversationTool(props.tool)}>
        <View style={{ paddingHorizontal: settingsGutter }}>
          <SettingsSection>
            <SettingsSwitch
              label={tr('Save new quick questions to conversations')}
              description={tr(
                'Applies to new quick questions. You can add an earlier one from its actions menu.',
              )}
              checked={quick.syncQuestions()}
              onPress={() => quick.setSyncQuestions(!quick.syncQuestions())}
            />
          </SettingsSection>
        </View>
      </If>
      <If when={entries().length > 0}>
        <View style={{ paddingHorizontal: settingsGutter, paddingBottom: 24 }}>
          <CommandSettings
            entries={entries()}
            all={quick.entries()}
            commands={quick.commands}
            recording={props.recording}
          />
        </View>
      </If>
      <If when={quick.commands.failure() !== null}>
        <View style={{ paddingHorizontal: settingsGutter, paddingBottom: 12 }}>
          <SettingsProblem
            message={renderText(
              errorText(quick.commands.failure(), 'Could not load or save quick tool settings.'),
            )}
          />
        </View>
      </If>
      <If when={page() !== undefined}>
        <View style={{ flex: 1, minHeight: 0 }}>
          {quick.runtime.render(page()!, {
            sessionId: null,
            input: { settings: { attach: props.attach } } satisfies SettingsPageInput,
          })}
        </View>
      </If>
    </View>
  );
}

/** A place where a page's own navigation, and a shortcut being recorded, are held. */
export function createToolNavigation() {
  const inner = signal<SettingsPageNavigation | null>(null);
  const recording = signal<string | null>(null);
  return {
    inner,
    recording,
    attach(value: SettingsPageNavigation) {
      inner.set(value);
      return () => {
        if (inner() === value) inner.set(null);
      };
    },
    /** Escape or back: stops recording, then lets the page go back; true when nothing did. */
    back(): boolean {
      if (recording() !== null) {
        recording.set(null);
        return false;
      }
      return inner()?.back() ?? true;
    },
    leave(next: () => void) {
      const page = inner();
      if (page?.leave) page.leave(next);
      else next();
    },
  };
}

/** Settings › Quick tools: every tool with something to set, each opening its settings. */
export function QuickToolsSettings(props: {
  quick: QuickTools;
  input: SettingsPageInput | undefined;
}): JSX.Element {
  const { quick } = props;
  const selected = signal<UiContributionRef | null>(null);
  const tool = createToolNavigation();
  const close = () => tool.leave(() => selected.set(null));
  const parent = props.input?.settings;
  if (parent)
    cleanup(
      parent.attach({
        title: () =>
          selected() === null
            ? tr('Quick tools')
            : (tool.inner()?.title() ?? quick.title(selected()!)),
        nested: () => selected() !== null,
        navigation: () =>
          selected() === null ? '' : `${selected()!.key}/${tool.inner()?.navigation() ?? ''}`,
        back() {
          // At the list, Escape first stops recording the launcher shortcut.
          if (selected() === null) return tool.back();
          if (tool.back()) close();
          return false;
        },
        leave: (next) => tool.leave(next),
        busy: () => tool.inner()?.busy?.() ?? false,
        action: () => (selected() === null ? null : (tool.inner()?.action?.() ?? null)),
      }),
    );
  const mark = (item: UiContributionRef) => (
    <PluginIcon
      packageId={item.instance.package.id}
      toolId={item.id}
      entry={quick.handles().get(item.key)?.entries()[0]}
      muted={!quick.toolEnabled(item)}
    />
  );
  const summary = (item: UiContributionRef) =>
    quick
      .entries()
      .filter((entry) => entry.tool.key === item.key)
      .flatMap((entry) => {
        const choice = quick.commands.choice(entry.key);
        return [choice?.alias, choice?.shortcut && keymap.label(choice.shortcut)].filter(
          (part): part is string => Boolean(part),
        );
      })
      .join(' · ');
  return (
    <If
      when={selected() === null}
      else={
        <QuickToolSettings
          quick={quick}
          tool={selected()!}
          recording={tool.recording}
          attach={tool.attach}
        />
      }
    >
      <SettingsBody>
        <SettingsSection>
          <SettingsSwitch
            label={tr('Turn on quick tools')}
            description={tr(
              'Press {shortcut} anywhere to open the quick launcher, with its tools, commands and Maka Bot. Still being refined.',
              { shortcut: keymap.label(quick.commands.launcher()) },
            )}
            checked={quick.enabled()}
            onPress={() => quick.setEnabled(!quick.enabled())}
          />
          <If when={quick.enabled()}>
            <LauncherShortcutRow
              all={quick.entries()}
              commands={quick.commands}
              recording={tool.recording}
            />
          </If>
        </SettingsSection>
        <If when={quick.failure() !== null || quick.commands.failure() !== null}>
          <SettingsProblem
            message={renderText(
              errorText(
                quick.failure() ?? quick.commands.failure(),
                'Could not load or save quick tool settings.',
              ),
            )}
          />
        </If>
        <If when={quick.enabled()}>
          <SettingsSection
            note={tr(
              'In the quick launcher, {shortcut} on a selected tool opens these same settings.',
              { shortcut: keymap.label('mod+,') },
            )}
          >
            <Each of={quick.tools()} key={(item: UiContributionRef) => item.key}>
              {(item) => (
                <If
                  when={quick.configurable(item())}
                  else={
                    <SettingsSwitch
                      label={quick.title(item())}
                      leading={mark(item())}
                      checked={quick.toolEnabled(item())}
                      disabled={!quick.ready()}
                      onPress={() => quick.toggleTool(item())}
                    />
                  }
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <RowLine />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <SettingsRow
                        label={quick.title(item())}
                        leading={mark(item())}
                        description={summary(item()) || undefined}
                        opens
                        line={false}
                        onPress={() => selected.set(item())}
                      />
                    </View>
                    <View
                      style={{
                        paddingHorizontal: settingsInset,
                        alignSelf: 'stretch',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <SettingsSwitchControl
                        accessibilityLabel={quick.title(item())}
                        checked={quick.toolEnabled(item())}
                        disabled={!quick.ready()}
                        onChange={() => quick.toggleTool(item())}
                      />
                    </View>
                  </View>
                </If>
              )}
            </Each>
            <If when={quick.tools().length === 0}>
              <SettingsRow label={tr('No quick tools to set up.')} tone="muted" />
            </If>
          </SettingsSection>
        </If>
      </SettingsBody>
    </If>
  );
}
