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
import { Button } from 'nsh/base';
import { ChoiceIndicator } from './ChoiceIndicator';
import { sameValue } from '../../../../plugins/shared/value';
import { tr } from './locale';
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
  SettingsBody,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  settingsGutter,
} from './SettingsPage';
import { errorText, renderText } from './text';

export type Attached = { tool: UiContributionRef; handle: QuickToolHandle };

const ENABLED_KEY = 'maka.quick-launcher.tools-enabled';

const DISABLED_KEY = 'maka.quick-launcher.disabled-plugins';
const pluginKey = (tool: UiContributionRef) => JSON.stringify(tool.instance.path);
const builtInNames: Partial<Record<string, Parameters<typeof tr>[0]>> = {
  'maka.calculator': 'Calculator',
  'maka.symbols': 'Symbols',
  'maka.file-search': 'Search files',
  'maka.applications': 'Search applications',
};

export type QuickTools = {
  runtime: UiRuntime<JSX.Element>;
  /** Whether the launcher offers the tools at all; off until the user turns them on. */
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
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
  const toolEnabled = (tool: UiContributionRef) => ready() && !disabled().has(pluginKey(tool));
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
    runtime.settings().find((item) => sameValue(item.instance.instance, tool.instance.instance));
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
    failure,
    tools,
    ready,
    toolEnabled,
    toggleTool(tool) {
      if (!ready()) return;
      const key = pluginKey(tool);
      const next = new Set(disabled());
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
          !toolEnabled(tool) && key.startsWith(`${tool.instance.path.join('/')}/${tool.id}/`),
      ),
    ),
    page,
    configurable: (tool) => page(tool) !== undefined || ownEntries(tool).length > 0,
    title(tool) {
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
      <If when={quick.commands.failure() !== null}>
        <View style={{ paddingHorizontal: settingsGutter, paddingBottom: 12 }}>
          <SettingsProblem message={renderText(errorText(quick.commands.failure()))} />
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
        <If when={quick.failure() !== null}>
          <SettingsProblem message={renderText(errorText(quick.failure()))} />
        </If>
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
        <If when={quick.enabled()}>
          <SettingsSection
            note={tr(
              'In the quick launcher, {shortcut} on a selected tool opens these same settings.',
              { shortcut: keymap.label('mod+,') },
            )}
          >
            <Each of={quick.tools()} key={(item: UiContributionRef) => item.key}>
              {(item) => (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <If
                      when={quick.configurable(item())}
                      else={<SettingsRow label={quick.title(item())} />}
                    >
                      <SettingsRow
                        label={quick.title(item())}
                        description={summary(item()) || undefined}
                        opens
                        onPress={() => selected.set(item())}
                      />
                    </If>
                  </View>
                  <Button
                    accessibilityLabel={tr('{label}: {state}', {
                      label: quick.title(item()),
                      state: quick.toolEnabled(item()) ? tr('On') : tr('Off'),
                    })}
                    selected={quick.toolEnabled(item())}
                    disabled={!quick.ready()}
                    onPress={() => quick.toggleTool(item())}
                    style={{
                      width: 52,
                      height: 42,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <ChoiceIndicator kind="switch" checked={quick.toolEnabled(item())} />
                  </Button>
                </View>
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
