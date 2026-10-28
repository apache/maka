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

import { textTooltip } from './ui';
import { createText, errorText, message, UiError } from './text';
import { tr } from './locale';
import { batch, cleanup, computed, effect, inputAction, signal, Text, View, List } from 'nsh';
import { Input } from 'nsh/base';
import type { ListRef, Signal } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { keymap } from 'nsh';
import { windowSize } from 'nsh';
import { host as shell, platform } from 'nsh';
import { host } from './host';
import type {
  AgentDirectory,
  AgentDirectoryPage,
  AgentDirectorySelection,
  AgentWorkspaceSelection,
  DirectoryRootSpec,
} from '../../../../packages/plugin-sdk/src/index.js';
import {
  C,
  inputBorderRadius,
  compact,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  shortcut,
} from './ui';
import { Icon } from './Icon';
import { WorkspaceLocations } from './WorkspaceLocations';
import { dialogTop, ownTitleBar } from './chrome';
import { createSettingsOperations } from './settingsOperations';

type Location = {
  id: number;
  trail: AgentDirectory[];
  page: Signal<AgentDirectoryPage | null>;
  entries: Signal<AgentDirectory[]>;
  reading: boolean;
};
type FolderAction = { location: number; selection: AgentDirectorySelection };
const selectionKey = (selection: AgentDirectorySelection) =>
  JSON.stringify([selection.rootId, selection.segments, selection.directoryIdentity]);
const pathNames = (path: string) =>
  path.split(platform.os === 'windows' ? /[\\/]/ : /\//).filter(Boolean);
/** The names from `root` down to `path`, or null when `path` is not in it. */
const below = (root: string, path: string) => {
  const [base, names] = [pathNames(root), pathNames(path)];
  return base.length <= names.length && base.every((name, i) => name === names[i])
    ? names.slice(base.length)
    : null;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function WorkspacePicker(props: {
  instance: number;
  current(): boolean;
  close(instance: number): boolean;
  create(workspace: AgentWorkspaceSelection): Promise<void>;
  changed(): void;
}) {
  const managing = signal(false);
  const picking = signal(false);
  const operations = createSettingsOperations();
  const awaitingRoots = signal<DirectoryRootSpec[] | null>(null);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshSession = false;
  const sameRoots = (left: DirectoryRootSpec[], right: DirectoryRootSpec[]) =>
    left.length === right.length &&
    left.every(
      (root, index) => root.label === right[index]?.label && root.path === right[index]?.path,
    );
  const scheduleRefresh = (read: Location) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (owns(read) && awaitingRoots()) void load(read);
    }, 500);
  };
  const query = signal('');
  const selected = signal(0);
  const loading = signal(false);
  const error = createText();
  const viewportHeight = signal(0);
  let alive = true;
  let serial = 0;
  const newLocation = (trail: AgentDirectory[]): Location => ({
    id: ++serial,
    trail,
    page: signal<AgentDirectoryPage | null>(null),
    entries: signal<AgentDirectory[]>([]),
    reading: false,
  });
  const location = signal(newLocation([]));
  const entries = () => location().entries();
  let list: ListRef | undefined;
  let removeKeys = () => {};
  let removeSearchKeys = () => {};
  const owns = (read: Location) => alive && props.current() && !managing() && location() === read;
  const matches = computed(() => {
    const needle = query().trim().toLowerCase();
    return entries().filter((directory) => directory.name.toLowerCase().includes(needle));
  });
  const count = () => Math.max(1, Math.ceil(viewportHeight() / 32));
  const index = () => Math.min(selected(), Math.max(0, matches().length - 1));
  const isSelected = (directory: AgentDirectory) => {
    const row = matches()[index()];
    return !!row && selectionKey(row.selection) === selectionKey(directory.selection);
  };
  const currentDirectory = (read = location()) => {
    const page = read.page();
    return page?.kind === 'children' ? page.directory : null;
  };
  const load = async (read = location()) => {
    const previous = read.page();
    if (!owns(read) || read.reading || (previous && (previous.kind === 'roots' || !previous.after)))
      return;
    read.reading = true;
    loading.set(true);
    error.set('');
    try {
      if (!read.trail.length) await host.refresh();
      const directory = read.trail.at(-1);
      const after = previous?.kind === 'children' ? previous.after : null;
      const page: AgentDirectoryPage = await host.query(
        'agent',
        'directories',
        directory ? { kind: 'children', selection: directory.selection, after } : { kind: 'roots' },
      );
      if (!owns(read)) return;
      if ((directory && page.kind !== 'children') || (!directory && page.kind !== 'roots'))
        throw new UiError('The Host returned a different directory view. Reopen the folder.');
      if (page.kind === 'children' && page.after !== null && page.after === after)
        throw new UiError('Folder paging did not advance. Reopen the folder.');
      if (page.kind === 'roots' && awaitingRoots()) {
        const published = page.roots.map((root) => ({ label: root.name, path: root.path }));
        if (!sameRoots(published, awaitingRoots()!)) {
          const desired = await host.query('settings', 'workspaceLocations', {});
          if (!owns(read)) return;
          if (desired) awaitingRoots.set(desired.roots);
          if (desired && !sameRoots(published, desired.roots)) {
            scheduleRefresh(read);
            return;
          }
        }
        awaitingRoots.set(null);
      }
      if (page.kind === 'roots' && refreshSession) {
        refreshSession = false;
        props.changed();
      }
      const rows = new Map(read.entries().map((entry) => [selectionKey(entry.selection), entry]));
      for (const entry of page.kind === 'roots' ? page.roots : page.children)
        rows.set(selectionKey(entry.selection), entry);
      batch(() => {
        read.page.set(page);
        read.entries.set([...rows.values()]);
      });
    } catch (reason) {
      if (owns(read) && awaitingRoots()) scheduleRefresh(read);
      if (owns(read))
        error.set(
          reason instanceof Error && reason.message.includes('agent_directory_unavailable')
            ? message(
                'This folder is unavailable or cannot be opened. Choose another location or retry.',
              )
            : errorText(reason),
        );
    } finally {
      read.reading = false;
      if (owns(read)) loading.set(false);
    }
  };
  const navigate = (trail: AgentDirectory[]) => {
    if (!alive || !props.current()) return;
    const read = newLocation(trail);
    batch(() => {
      location.set(read);
      query.set('');
      selected.set(0);
      error.set('');
      loading.set(true);
    });
    list = undefined;
    void load(read);
  };
  const browse = (action: FolderAction) => {
    const read = location();
    if (!owns(read) || action.location !== read.id || error()) return;
    const directory = read
      .entries()
      .find((entry) => selectionKey(entry.selection) === selectionKey(action.selection));
    if (directory) navigate([...read.trail, directory]);
  };
  const back = ({ location: original, roots = false }: { location: number; roots?: boolean }) => {
    const read = location();
    if (owns(read) && original === read.id && read.trail.length)
      navigate(roots ? [] : read.trail.slice(0, -1));
  };
  const retry = ({ location: original }: { location: number }) => {
    const read = location();
    if (owns(read) && original === read.id) navigate(read.trail);
  };
  const choose = (action: FolderAction) => {
    const read = location();
    const directory = currentDirectory();
    if (
      !owns(read) ||
      action.location !== read.id ||
      error() ||
      !directory ||
      selectionKey(directory.selection) !== selectionKey(action.selection)
    )
      return;
    if (props.close(props.instance))
      void props.create({ kind: 'directory', selection: action.selection });
  };
  const roots = async () => {
    await host.refresh();
    const page: AgentDirectoryPage = await host.query('agent', 'directories', { kind: 'roots' });
    if (page.kind !== 'roots')
      throw new UiError('The Host returned a different directory view. Reopen the folder.');
    return page.roots;
  };
  /** The location `path` is in (the innermost one) and the names below it. */
  const locate = (rows: AgentDirectory[], path: string) =>
    rows
      .map((root) => ({ root, names: root.path ? below(root.path, path) : null }))
      .filter((found) => found.names !== null)
      .sort((a, b) => a.names!.length - b.names!.length)[0] ?? null;
  /** Adds `path` as a workspace location and waits until the Host serves it. */
  const addLocation = async (path: string) => {
    if (operations.pending().length)
      throw new UiError('Recover the unfinished settings action in Manage locations first.');
    const current = await host.query('settings', 'workspaceLocations', {});
    if (!current) throw new UiError('This Host does not manage workspace locations.');
    const name =
      (pathNames(path).at(-1) ?? path).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() ||
      tr('Workspace');
    const labels = new Set(current.roots.map((root: DirectoryRootSpec) => root.label));
    let label = name;
    let suffix = 2;
    while (labels.has(label)) label = `${name} (${suffix++})`;
    const value: any = await operations.mutate('settings', 'updateWorkspaceLocations', {
      source: current.source,
      roots: [...current.roots, { label, path }],
    });
    if (value?.status === 'conflict')
      throw new UiError('Workspace locations changed elsewhere. Reload before saving again.');
    if (value?.status !== 'committed')
      throw new UiError('The Host rejected these workspace locations.');
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = locate(await roots(), path);
      if (found) return found;
      await pause(500);
    }
    throw new UiError('Locations saved. Waiting for the Host to apply them…');
  };
  /** The selection of the folder at `path`, adding a location for it when none holds it. */
  const resolve = async (path: string) => {
    const { root, names } = locate(await roots(), path) ?? (await addLocation(path));
    let directory = root;
    for (const name of names!) {
      let after: string | null = null;
      let found: AgentDirectory | undefined;
      do {
        const page: AgentDirectoryPage = await host.query('agent', 'directories', {
          kind: 'children' as const,
          selection: directory.selection,
          after,
        });
        if (page.kind !== 'children')
          throw new UiError('The Host returned a different directory view. Reopen the folder.');
        found = page.children.find((child) => child.name === name);
        after = page.after;
      } while (!found && after !== null);
      if (!found)
        throw new UiError(
          'This folder is unavailable or cannot be opened. Choose another location or retry.',
        );
      directory = found;
    }
    return directory.selection;
  };
  /** Chooses the workspace with the system's folder dialog (the desktop window's). */
  const chooseFolder = () => {
    if (!alive || !props.current() || picking() || managing()) return;
    picking.set(true);
    error.set('');
    void (async () => {
      try {
        // The dialog stays open as long as the user needs it.
        const path: string | null = await shell.call('workspace.chooseFolder', {}, { timeout: 0 });
        if (!path || !alive || !props.current()) return;
        const selection = await resolve(path);
        if (alive && props.close(props.instance))
          void props.create({ kind: 'directory', selection });
      } catch (reason) {
        if (alive) error.set(errorText(reason));
      } finally {
        if (alive) picking.set(false);
      }
    })();
  };
  const chooseCurrent = (read: Location) => {
    const directory = currentDirectory(read);
    if (directory) choose({ location: read.id, selection: directory.selection });
  };
  const move = (read: Location, delta: number) => {
    if (!owns(read)) return;
    const next = Math.max(0, Math.min(matches().length - 1, index() + delta));
    selected.set(next);
    list?.scrollToIndex({ index: next, animated: false, viewPosition: delta > 0 ? 1 : 0 });
    if (next >= matches().length - 2) void load();
  };
  const activate = (read: Location) => {
    if (!owns(read)) return;
    const directory = matches()[index()];
    if (directory) browse({ location: read.id, selection: directory.selection });
  };
  effect(() => {
    if (!awaitingRoots() && !loading() && !error() && matches().length < count()) void load();
  });
  cleanup(() => {
    alive = false;
    clearTimeout(refreshTimer);
    removeKeys();
    removeSearchKeys();
  });
  void load();
  return (
    <Dialog
      animation="none"
      closeOnEscape={!managing()}
      closeOnBackdropPress={!managing()}
      closeOnSwipe={!managing()}
      onOpenChange={() => {
        if (!managing()) props.close(props.instance);
      }}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: C.scrim,
        padding: 16,
        paddingTop: dialogTop(16),
      }}
    >
      <If when={managing()}>
        <WorkspaceLocations
          close={(roots) =>
            batch(() => {
              refreshSession = true;
              awaitingRoots.set(roots);
              managing.set(false);
              navigate([]);
            })
          }
        />
      </If>
      <Each of={managing() ? [] : [location().id]} key={(id: number) => id}>
        {() => {
          const read = location();
          const status = () => (
            <View style={{ gap: 8, padding: 12 }}>
              <If when={awaitingRoots()}>
                <Text style={{ color: C.muted, fontSize: 13, lineHeight: 16 }}>
                  {tr('Locations saved. Waiting for the Host to apply them…')}
                </Text>
              </If>
              <If when={loading() && !awaitingRoots()}>
                <Text style={{ color: C.muted, fontSize: 13, lineHeight: 16 }}>
                  {tr('Loading folders…')}
                </Text>
              </If>
              <If when={!awaitingRoots() && !loading() && !error() && !matches().length}>
                <Text style={{ color: C.muted, fontSize: 13, lineHeight: 16 }}>
                  {query()
                    ? tr('No matching folders.')
                    : read.trail.length
                      ? tr('This folder has no subfolders.')
                      : tr('No workspace locations are available.')}
                </Text>
              </If>
              <If when={error()}>
                <Text
                  style={[
                    { color: C.danger, fontSize: 13, lineHeight: 16 },
                    { userSelect: 'text' },
                  ]}
                >
                  {error()}
                </Text>
                <Button
                  accessibilityLabel={tr('Retry folder')}
                  onPress={inputAction(retry, { location: read.id })}
                  style={{
                    ...controlStyle,
                    alignSelf: 'flex-start',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name="refresh" color={C.secondary} />
                  <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Retry folder')}</Text>
                </Button>
              </If>
            </View>
          );
          return (
            <View
              ref={(node) => {
                removeKeys();
                const unbind = [
                  keymap.bind('alt+up', () => back({ location: read.id }), {
                    when: 'always',
                    within: node,
                  }),
                  keymap.bind('mod+enter', () => chooseCurrent(read), {
                    when: 'always',
                    within: node,
                  }),
                ];
                removeKeys = () => unbind.forEach((remove) => remove());
              }}
              style={{
                width: '100%',
                maxWidth: 680,
                height: Math.min(500, windowSize().height - 32),
                maxHeight: '100%',
                backgroundColor: C.surface,
                borderWidth: 1,
                borderRadius: 16,
                borderColor: C.line,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingTop: 12,
                  paddingBottom: 8,
                }}
              >
                <Icon name="folder" color={C.secondary} />
                <Text
                  style={{
                    flex: 1,
                    color: C.text,
                    fontSize: 18,
                    lineHeight: 24,
                    fontWeight: '600',
                  }}
                >
                  {tr('Choose workspace')}
                </Text>
                <Button
                  accessibilityLabel={tr('Close workspace picker')}
                  tooltip={textTooltip(() => tr('Close · Esc'))}
                  onPress={inputAction(props.close, props.instance)}
                  style={{
                    ...controlStyle,
                    width: 32,
                    paddingHorizontal: 8,
                    alignItems: 'center',
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name="close" color={C.muted} />
                </Button>
              </View>
              <View
                style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}
              >
                <Button
                  disabled={!read.trail.length}
                  accessibilityLabel={tr('Parent workspace folder')}
                  tooltip={textTooltip(() => shortcut(tr('Parent folder'), 'alt+up'))}
                  onPress={inputAction(back, { location: read.id })}
                  style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name="back" color={C.secondary} />
                  <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Parent')}</Text>
                </Button>
                <Button
                  disabled={!read.trail.length}
                  accessibilityLabel={tr('Workspace locations')}
                  onPress={inputAction(back, { location: read.id, roots: true })}
                  style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name="folder" color={C.secondary} />
                  <Text style={{ color: C.secondary, fontSize: 13 }}>{tr('Locations')}</Text>
                </Button>
                <Button
                  accessibilityLabel={tr('Manage workspace locations')}
                  onPress={inputAction(() => {
                    removeKeys();
                    removeSearchKeys();
                    managing.set(true);
                  }, null)}
                  style={controlStyle}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ color: C.accent, fontSize: 13 }}>{tr('Manage locations')}</Text>
                </Button>
                <If when={ownTitleBar}>
                  <View style={{ flex: 1 }} />
                  <Button
                    disabled={picking()}
                    accessibilityLabel={tr('Choose a folder on this computer')}
                    onPress={inputAction(chooseFolder, null)}
                    style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Icon name="folder" color={C.accent} />
                    <Text style={{ color: C.accent, fontSize: 13 }}>
                      {picking() ? tr('Opening folder…') : tr('Choose folder…')}
                    </Text>
                  </Button>
                </If>
              </View>
              <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <Input
                  ref={(node) => {
                    removeSearchKeys();
                    const unbind = [
                      keymap.bind('up', () => move(read, -1), {
                        when: 'always',
                        repeat: true,
                        within: node,
                      }),
                      keymap.bind('down', () => move(read, 1), {
                        when: 'always',
                        repeat: true,
                        within: node,
                      }),
                      keymap.bind('enter', () => activate(read), { when: 'always', within: node }),
                      keymap.bind('escape', () => props.close(props.instance), {
                        when: 'always',
                        within: node,
                      }),
                    ];
                    removeSearchKeys = () => unbind.forEach((remove) => remove());
                  }}
                  autoFocus
                  accessibilityLabel={tr('Search workspace folders')}
                  value={query()}
                  onChange={({ value: text }) => {
                    if (!owns(read)) return;
                    selected.set(0);
                    query.set(text);
                    list?.scrollToIndex({ index: 0, animated: false });
                  }}
                  placeholder={tr('Search workspaces…')}
                  style={{
                    placeholderColor: C.muted,
                    color: C.text,
                    height: compact() ? 32 : 40,
                    backgroundColor: C.background,
                    borderRadius: inputBorderRadius,
                    paddingHorizontal: 12,
                    fontSize: 14,
                  }}
                />
              </View>
              <List
                each={matches()}
                keyExtractor={(entry) => selectionKey(entry.selection)}
                ref={(node) => {
                  list = node;
                }}
                estimatedItemSize={32}
                header={() => (
                  <View style={{ gap: 4, paddingHorizontal: 16, paddingBottom: 12 }}>
                    <Text
                      style={{ color: C.text, fontSize: 13, lineHeight: 16, fontWeight: '600' }}
                    >
                      {read.trail.length
                        ? tr('Folder · {name}', { name: read.trail.at(-1)!.name })
                        : tr('Workspace locations')}
                    </Text>
                    <Text
                      style={[
                        { color: C.muted, fontSize: 12, lineHeight: 16 },
                        { userSelect: 'text' },
                      ]}
                    >
                      {currentDirectory(read)?.path ??
                        read.trail.at(-1)?.path ??
                        tr(
                          'Open a location, then choose the folder where the conversation can work.',
                        )}
                    </Text>
                  </View>
                )}
                empty={status}
                footer={() => (
                  <If when={matches().length > 0 && (loading() || error())}>{status()}</If>
                )}
                onLayout={({ bounds: frame }) => {
                  if (owns(read)) viewportHeight.set(frame.size.height);
                }}
                onLoadMore={() => {
                  void load(read);
                }}
                accessibilityLabel={tr('Workspace folders')}
                style={{ flex: 1, minHeight: 32 }}
              >
                {(entry) => (
                  <Button
                    disabled={!!error()}
                    accessibilityLabel={tr('Browse folder {name}', { name: entry().name })}
                    tooltip={textTooltip(() => entry().path)}
                    selected={isSelected(entry())}
                    onPress={inputAction(browse, {
                      location: read.id,
                      selection: entry().selection,
                    })}
                    style={{
                      height: 32,
                      paddingHorizontal: 16,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      backgroundColor: isSelected(entry()) ? C.line : C.surface,
                    }}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.raised }}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Icon name="folder" color={C.muted} />
                    <Text style={[{ flex: 1, color: C.text, fontSize: 13 }, { numberOfLines: 1 }]}>
                      {entry().name}
                    </Text>
                    <Icon name="right" color={C.muted} />
                  </Button>
                )}
              </List>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: 1,
                  borderTopColor: C.line,
                }}
              >
                <Button
                  disabled={!currentDirectory(read) || !!error()}
                  accessibilityLabel={tr('Use this workspace folder')}
                  tooltip={textTooltip(() => shortcut(tr('Use this folder'), 'mod+enter'))}
                  onPress={
                    currentDirectory(read)
                      ? inputAction(choose, {
                          location: read.id,
                          selection: currentDirectory(read)!.selection,
                        })
                      : undefined
                  }
                  style={{ ...controlStyle, backgroundColor: C.accent }}
                  hoverStyle={{ backgroundColor: C.accentHover }}
                  focusStyle={{ backgroundColor: C.accentHover }}
                  disabledStyle={{ ...controlDisabledStyle, backgroundColor: C.line }}
                >
                  <Text
                    style={{
                      color: currentDirectory(read) && !error() ? C.background : C.muted,
                      fontSize: 13,
                      lineHeight: 16,
                      fontWeight: '600',
                    }}
                  >
                    {tr('Use this folder')}
                  </Text>
                </Button>
              </View>
            </View>
          );
        }}
      </Each>
    </Dialog>
  );
}
