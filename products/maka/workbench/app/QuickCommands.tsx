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
  effect,
  keymap,
  platform,
  signal,
  Storage,
  Text,
  View,
  type JSX,
  type Signal,
} from 'nsh';
import { Button } from 'nsh/base';
import type { UiContributionRef } from '../../../../packages/plugin-sdk/src/workbench.js';
import type { QuickEntry } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { tr } from './locale';
import {
  choose,
  normalAlias,
  parseChoices,
  recordable,
  type CommandChoice,
  type CommandChoices,
} from './quick-commands';
import { SettingsButton, SettingsInlineInput, SettingsRow, SettingsSection } from './SettingsPage';
import { C } from './ui';

const KEY = 'maka.quick-launcher.commands';
const LAUNCHER_KEY = 'maka.quick-launcher.shortcut';
/** What opens the launcher until the user records another. */
const DEFAULT_LAUNCHER_SHORTCUT = 'alt+space';
const apple = platform.os === 'macos' || platform.os === 'ios';

/** An entry a quick tool offers, with the key its choices are kept under across runs. */
export type ToolEntry = { key: string; tool: UiContributionRef; entry: QuickEntry };

export const entryKey = (tool: UiContributionRef, entry: QuickEntry) =>
  `${tool.instance.path.join('/')}/${tool.id}/${entry.id}`;

export type Commands = {
  /** Why the choices could not be read or saved. */
  failure(): unknown;
  reserved(field: keyof CommandChoice, value: string): boolean;
  choice(key: string): CommandChoice | undefined;
  choose(key: string, patch: Partial<Record<keyof CommandChoice, string | null>>): void;
  /** The shortcut that opens the launcher, which no command may take. */
  launcher(): string;
  setLauncher(shortcut: string): void;
  /** Shortcuts the system refused, taken by another app. */
  refused(): ReadonlySet<string>;
  registered(shortcut: string, taken: boolean): void;
};

export function createCommands(disabledCommand: (key: string) => boolean): Commands {
  const failure = signal<unknown>(null);
  const report = (reason: unknown) => failure.set(reason);
  const choices = signal<CommandChoices>({});
  const refused = signal<ReadonlySet<string>>(new Set());
  const launcher = signal(DEFAULT_LAUNCHER_SHORTCUT);
  // A choice made before the stored ones arrive wins over them.
  let chosen = false;
  let launcherChosen = false;
  Storage.getItem(KEY)
    .then((stored) => {
      if (!chosen) choices.set(parseChoices(stored));
    })
    .catch(report);
  Storage.getItem(LAUNCHER_KEY)
    .then((stored) => {
      if (launcherChosen || stored === null) return;
      if (!recordable(apple).includes(stored))
        throw new Error('The quick launcher shortcut is damaged.');
      launcher.set(stored);
    })
    .catch(report);
  let saving: Promise<void> = Promise.resolve();
  return {
    failure,
    reserved: (field, value) =>
      Object.entries(choices()).some(
        ([key, choice]) => choice[field] === value && disabledCommand(key),
      ),
    choice: (key) => choices()[key],
    choose(key, patch) {
      chosen = true;
      const next = choose(choices(), key, patch);
      choices.set(next);
      const value = JSON.stringify(next);
      saving = saving.then(() => Storage.setItem(KEY, value)).catch(report);
    },
    launcher,
    setLauncher(shortcut) {
      launcherChosen = true;
      launcher.set(shortcut);
      saving = saving.then(() => Storage.setItem(LAUNCHER_KEY, shortcut)).catch(report);
    },
    refused,
    registered(shortcut, taken) {
      if (taken === refused().has(shortcut)) {
        const next = new Set(refused());
        if (taken) next.delete(shortcut);
        else next.add(shortcut);
        refused.set(next);
      }
    },
  };
}

/** Records the next shortcut pressed while `recording` is this entry; Escape cancels. */
function ShortcutRecorder(props: {
  shortcut: string | undefined;
  recording: boolean;
  start(): void;
  record(shortcut: string): void;
  /** Offers to remove the shortcut; without it one is always kept. */
  clear?: () => void;
}) {
  effect(() => {
    if (!props.recording) return;
    cleanup(
      keymap.bind(
        Object.fromEntries(
          recordable(apple).map((keystroke) => [keystroke, () => props.record(keystroke)]),
        ),
        { when: 'always' },
      ),
    );
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      <Button
        accessibilityLabel={tr('Record shortcut')}
        selected={props.recording}
        onPress={props.start}
        style={{
          minWidth: 120,
          height: 28,
          paddingHorizontal: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: props.recording ? C.accent : C.line,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        hoverStyle={{ backgroundColor: C.raised }}
      >
        <Text
          style={{
            fontSize: 13,
            lineHeight: 18,
            color: props.recording || props.shortcut === undefined ? C.muted : C.text,
          }}
        >
          {props.recording
            ? tr('Press keys…')
            : props.shortcut === undefined
              ? tr('Record shortcut')
              : keymap.label(props.shortcut)}
        </Text>
      </Button>
      <If when={props.clear !== undefined && props.shortcut !== undefined && !props.recording}>
        <SettingsButton
          icon="trash"
          iconOnly
          tone="quiet"
          label={tr('Remove shortcut')}
          onPress={() => props.clear?.()}
        />
      </If>
    </View>
  );
}

function CommandRow(props: {
  item: ToolEntry;
  all: readonly ToolEntry[];
  commands: Commands;
  recording: Signal<string | null>;
}) {
  const { item, commands } = props;
  const alias = signal(commands.choice(item.key)?.alias ?? '');
  const problem = signal<string | null>(null);
  const holder = (taken: (choice: CommandChoice | undefined) => boolean) =>
    props.all.find((other) => other.key !== item.key && taken(commands.choice(other.key)));
  const changeAlias = (text: string) => {
    alias.set(text);
    const next = normalAlias(text);
    const other = next
      ? (holder((choice) => choice?.alias === next) ??
        props.all.find(
          (other) =>
            other.key !== item.key &&
            other.entry.keywords.some((keyword) => keyword.toLowerCase() === next),
        ))
      : undefined;
    if (other) return problem.set(tr('Used by {title}', { title: other.entry.title }));
    problem.set(null);
    if (next && commands.reserved('alias', next)) return problem.set(tr('Used by a disabled tool'));
    commands.choose(item.key, { alias: next || null });
  };
  const record = (shortcut: string) => {
    props.recording.set(null);
    const other = holder((choice) => choice?.shortcut === shortcut);
    if (shortcut === commands.launcher())
      return problem.set(tr('Used by {title}', { title: tr('Quick launcher') }));
    if (other) return problem.set(tr('Used by {title}', { title: other.entry.title }));
    problem.set(null);
    if (commands.reserved('shortcut', shortcut)) return problem.set(tr('Used by a disabled tool'));
    commands.choose(item.key, { shortcut });
  };
  const shortcut = () => commands.choice(item.key)?.shortcut;
  return (
    <SettingsRow
      label={item.entry.title}
      status={
        problem() ??
        (shortcut() !== undefined && commands.refused().has(shortcut()!)
          ? tr('Taken by another app')
          : undefined)
      }
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, width: 300 }}>
          <SettingsInlineInput
            label={tr('Alias')}
            // The first keyword is the built-in alias, until the user gives their own.
            placeholder={item.entry.keywords[0]}
            value={alias()}
            change={changeAlias}
          />
          <ShortcutRecorder
            shortcut={shortcut()}
            recording={props.recording() === item.key}
            start={() => {
              problem.set(null);
              props.recording.set(item.key);
            }}
            record={record}
            clear={() => commands.choose(item.key, { shortcut: null })}
          />
        </View>
      }
    />
  );
}

/** A tool's entries, each with its alias and shortcut. */
export function CommandSettings(props: {
  entries: readonly ToolEntry[];
  all: readonly ToolEntry[];
  commands: Commands;
  recording: Signal<string | null>;
}): JSX.Element {
  return (
    <SettingsSection
      title={tr('Commands')}
      note={tr(
        'A shortcut runs the command from any app. Typing the alias finds it; left empty, the built-in alias is used.',
      )}
    >
      <Each of={props.entries} key={(item: ToolEntry) => item.key}>
        {(item) => (
          <CommandRow
            item={item()}
            all={props.all}
            commands={props.commands}
            recording={props.recording}
          />
        )}
      </Each>
    </SettingsSection>
  );
}

/** The shortcut that opens the launcher, recorded like a command's and never another's. */
export function LauncherShortcutRow(props: {
  all: readonly ToolEntry[];
  commands: Commands;
  recording: Signal<string | null>;
}): JSX.Element {
  const { commands } = props;
  const problem = signal<string | null>(null);
  const record = (shortcut: string) => {
    props.recording.set(null);
    const other = props.all.find((item) => commands.choice(item.key)?.shortcut === shortcut);
    if (other) return problem.set(tr('Used by {title}', { title: other.entry.title }));
    problem.set(null);
    if (commands.reserved('shortcut', shortcut)) return problem.set(tr('Used by a disabled tool'));
    commands.setLauncher(shortcut);
  };
  return (
    <SettingsRow
      label={tr('Shortcut to open the quick launcher')}
      status={
        problem() ??
        (commands.refused().has(commands.launcher()) ? tr('Taken by another app') : undefined)
      }
      trailing={
        <ShortcutRecorder
          shortcut={commands.launcher()}
          recording={props.recording() === 'launcher'}
          start={() => {
            problem.set(null);
            props.recording.set('launcher');
          }}
          record={record}
        />
      }
    />
  );
}
