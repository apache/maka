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
  computed,
  effect,
  Input,
  inputAction,
  List,
  Overlay,
  signal,
  Text,
  View,
} from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import { keymap } from 'nsh/keymap';
import { windowSize } from 'nsh/device';
import { host } from './host';
import { tr } from './locale';
import { createText, errorText } from './text';
import type { ComposerSession, SendAction } from './Composer';
import type { ComposerCommand } from './composerCommands';
import type { WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import { sameRoute } from './modelSelection';
import {
  completionToken,
  fileInvocation,
  referenceEdit,
  validSelection,
} from './composerCompletion';
import type { CompletionToken, Selection } from './composerCompletion';
import { C, bodyTextStyle, captionTextStyle } from './ui';
import { Icon } from './Icon';

type Source = 'add' | 'files' | 'skills' | 'commands' | 'slash';
type Rect = { x: number; y: number; width: number; height: number };
type Editor = { sessionId: string | null; node: YNode };
type Read = {
  serial: number;
  owner: ComposerSession;
  editor: YNode;
  text: string;
  selection: Selection;
  token: CompletionToken | null;
  source: Source;
  explicit: boolean;
  query: string;
  inputQuery: string;
  directory: WorkspacePath | null;
  backend: string;
  commands: ComposerCommand[];
};
type Row = {
  id: string;
  title: string;
  detail?: string;
  icon: 'paperclip' | 'file' | 'folder' | 'code' | 'command';
  disabled?: boolean;
  action: { read: number; id: string };
} & (
  | { kind: 'source'; source: 'files' | 'skills' | 'commands' }
  | { kind: 'attachment' }
  | { kind: 'insert'; insert: string }
  | { kind: 'directory'; path: string; directory: WorkspacePath }
  | { kind: 'command'; command: ComposerCommand }
);
type Options = {
  session(): ComposerSession | null;
  commands(): ComposerCommand[];
  active(): boolean;
};
type FileRead = { close(): Promise<void>; closing: Promise<void> | null };

const sameSelection = (a: Selection, b: Selection) => a.start === b.start && a.end === b.end;
const backendKey = (owner: ComposerSession) => {
  const backend = owner.backend();
  const details = owner.modelDetails();
  return JSON.stringify([
    backend,
    details.kind === 'ready' ? details.choice.selection : details.kind,
  ]);
};

/** One resident editor owns its menu, selection and latest outstanding lookup. */
export function createComposerCompletion(options: Options) {
  const editor = signal<Editor | null>(null);
  const caret = signal<Rect | null>(null);
  const selection = signal<Selection>({ start: 0, end: 0 });
  const composing = signal(false);
  const explicit = signal<Source | null>(null);
  const query = signal('');
  const queryInput = signal<YNode | null>(null);
  const querySelection = signal<Selection>({ start: 0, end: 0 });
  const queryComposing = signal(false);
  const opened = signal<Read | null>(null);
  const rows = signal<Row[]>([]);
  const selected = signal(0);
  const loading = signal(false);
  const error = createText();
  let list: YNode | undefined;
  let addAnchor: YNode | undefined;
  let serial = 0;
  let current: Read | null = null;
  let dismissed: Pick<Read, 'owner' | 'editor' | 'text' | 'selection'> | null = null;
  let wanted: Read | null = null;
  let querying = false;
  let alive = true;
  let fileRead: FileRead | null = null;
  let directoryHint: { prefix: string; path: WorkspacePath } | null = null;
  let textVersion = 0;
  let pendingCommand: { owner: ComposerSession; text: string; version: number; id: string } | null =
    null;

  const releaseFile = (read: FileRead) => (read.closing ??= read.close());
  const stopFile = () => {
    if (fileRead) void releaseFile(fileRead).catch(() => {});
  };
  const fileQuery = (value: string) => {
    const slash = value.lastIndexOf('/');
    if (slash <= 0) return { query: value, directory: null };
    const prefix = value.slice(0, slash);
    if (directoryHint?.prefix === prefix)
      return { query: value.slice(slash + 1), directory: directoryHint.path };
    let binary = '';
    for (const byte of new TextEncoder().encode(prefix)) binary += String.fromCharCode(byte);
    return { query: value.slice(slash + 1), directory: { bytesBase64: btoa(binary) } };
  };

  const owns = (read: Read) =>
    alive &&
    options.active() &&
    options.session() === read.owner &&
    read.owner.editable() &&
    editor()?.sessionId === read.owner.sessionId &&
    editor()?.node === read.editor &&
    read.owner.draft() === read.text &&
    sameSelection(selection(), read.selection) &&
    backendKey(read.owner) === read.backend &&
    !composing();
  const sameDismissed = (context: Pick<Read, 'owner' | 'editor' | 'text' | 'selection'>) =>
    dismissed !== null &&
    dismissed.owner === context.owner &&
    dismissed.editor === context.editor &&
    dismissed.text === context.text &&
    sameSelection(dismissed.selection, context.selection);
  const hide = () => {
    stopFile();
    current = null;
    wanted = null;
    opened.set(null);
    rows.set([]);
    loading.set(false);
  };
  const close = () => {
    dismissed = current;
    explicit.set(null);
    hide();
  };
  const dismiss = () => {
    close();
    editor()?.node.focus();
  };
  const row = <T extends Omit<Row, 'action'>>(read: Read, value: T): Row =>
    Object.assign(value, { action: { read: read.serial, id: value.id } }) as Row;
  const commandRows = (read: Read) =>
    read.commands
      .filter(
        (command) =>
          read.explicit ||
          !read.token ||
          !read.text.slice(read.token.end).trim() ||
          command.takesArgument,
      )
      .filter((command) =>
        `${command.trigger} ${command.title} ${command.detail ?? ''}`
          .toLowerCase()
          .includes(read.query.toLowerCase()),
      )
      .map((command) =>
        row(read, {
          id: `command:${command.id}`,
          kind: 'command',
          command,
          title: `/${command.trigger}`,
          detail: command.title,
          icon: 'command',
        }),
      );
  const localRows = (read: Read): Row[] => {
    if (read.source === 'add')
      return [
        row(read, {
          id: 'add:attachment',
          kind: 'attachment',
          get title() {
            return tr('Attach files');
          },
          detail: 'Ctrl+U',
          icon: 'paperclip',
          disabled: read.owner.attachments.restoring(),
        }),
        row(read, {
          id: 'add:files',
          kind: 'source',
          source: 'files',
          get title() {
            return tr('Reference a workspace file');
          },
          detail: '@',
          icon: 'file',
        }),
        row(read, {
          id: 'add:skills',
          kind: 'source',
          source: 'skills',
          get title() {
            return tr('Use a skill');
          },
          detail: '/',
          icon: 'code',
        }),
        row(read, {
          id: 'add:commands',
          kind: 'source',
          source: 'commands',
          get title() {
            return tr('Message commands');
          },
          detail: '/',
          icon: 'command',
        }),
      ];
    return read.source === 'commands' || (read.source === 'slash' && read.token?.leading)
      ? commandRows(read)
      : [];
  };
  const appendRows = (read: Read, matches: Row[]) => {
    if (current !== read || !owns(read) || matches.length === 0) return;
    const first = rows().length === 0;
    rows.set([...rows(), ...matches]);
    if (first) list?.scrollToIndex({ index: 0, animated: false, viewPosition: 0 });
  };
  const lookup = async (read: Read): Promise<void> => {
    if (read.source === 'files') {
      const stream = await host.subscribe('agent', 'fileCandidates', {
        sessionId: read.owner.sessionId,
        query: read.query,
        ...(read.directory ? { directory: read.directory } : {}),
      });
      const active: FileRead = { close: () => stream.close(), closing: null };
      fileRead = active;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const seen = new Set<string>();
      try {
        while (current === read && owns(read)) {
          const result = await stream.next();
          if (result === null || current !== read || !owns(read)) break;
          const matches = result.entries
            .filter((entry) => {
              const key = entry.path.bytesBase64;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((entry) => {
              let insert: string | null = null;
              let path: string | null = null;
              let title: string;
              try {
                const bytes = Uint8Array.from(atob(entry.path.bytesBase64), (value) =>
                  value.charCodeAt(0),
                );
                path = decoder.decode(bytes);
                insert = fileInvocation(path);
                title = path.replace(/\p{Cc}/gu, '�');
              } catch {
                // Opaque bytes stay authoritative; display labels are never decoded back into paths.
                title = host.pathLabel(entry.path);
              }
              const common = {
                id: `file:${entry.path.bytesBase64}`,
                title: title + (entry.kind === 'directory' ? '/' : ''),
                get detail() {
                  return insert === null
                    ? tr('This file name cannot be inserted as text.')
                    : undefined;
                },
                disabled: insert === null,
              };
              return entry.kind === 'directory'
                ? row(read, {
                    ...common,
                    kind: 'directory',
                    path: path ?? '',
                    directory: entry.path,
                    icon: 'folder',
                  })
                : row(read, { ...common, kind: 'insert', insert: insert ?? '', icon: 'file' });
            });
          appendRows(read, matches);
        }
      } finally {
        await releaseFile(active);
        if (fileRead === active) fileRead = null;
      }
      return;
    }
    const backend = read.owner.backend();
    const details = read.owner.modelDetails();
    if (!backend || details.kind !== 'ready' || !sameRoute(backend, details.choice.selection))
      return;
    const result = await host.query('agent', 'skillCandidates', {
      sessionId: read.owner.sessionId,
      backend: {
        kind: 'model',
        model: details.choice.selection,
        thinkingLevel: backend.thinkingLevel,
      },
      query: read.query,
    });
    appendRows(
      read,
      result.skills.map((skill) =>
        row(read, {
          id: `skill:${skill.reference}`,
          kind: 'insert',
          insert: skill.invocation,
          title: skill.name,
          detail: skill.description,
          icon: 'code',
        }),
      ),
    );
  };
  const pump = async () => {
    if (querying) return;
    querying = true;
    try {
      while (alive && wanted) {
        const read = wanted;
        wanted = null;
        try {
          await lookup(read);
          if (current === read && owns(read)) loading.set(false);
        } catch (reason) {
          if (current === read && owns(read)) {
            error.set(errorText(reason));
            loading.set(false);
          }
        }
      }
    } finally {
      querying = false;
    }
  };
  effect(() => {
    const owner = options.session();
    const binding = editor();
    if (!options.active()) {
      if (current) dismissed = current;
      explicit.set(null);
      hide();
      return;
    }
    if (
      !owner ||
      !owner.editable() ||
      !binding ||
      binding.sessionId !== owner.sessionId ||
      composing()
    ) {
      hide();
      return;
    }
    const text = owner.draft();
    const range = selection();
    if (!validSelection(text, range)) {
      hide();
      return;
    }
    const context = { owner, editor: binding.node, text, selection: range };
    if (dismissed && !sameDismissed(context)) dismissed = null;
    if (sameDismissed(context)) {
      hide();
      return;
    }
    const token = completionToken(text, range);
    const requested = explicit();
    const source =
      requested ??
      (token?.kind === 'file'
        ? 'files'
        : token?.kind === 'skill'
          ? 'skills'
          : token
            ? 'slash'
            : null);
    if (source === null) {
      hide();
      return;
    }
    const commands =
      source === 'commands' || (source === 'slash' && token?.leading) ? options.commands() : [];
    const inputQuery = requested === null ? (token?.query ?? '') : query();
    const location =
      source === 'files' ? fileQuery(inputQuery) : { query: inputQuery, directory: null };
    const read: Read = {
      serial: serial + 1,
      owner,
      editor: binding.node,
      text,
      selection: { ...range },
      token: requested === null ? token : null,
      source,
      explicit: requested !== null,
      ...location,
      inputQuery,
      backend: backendKey(owner),
      commands,
    };
    stopFile();
    serial += 1;
    current = read;
    opened.set(read);
    selected.set(0);
    error.set('');
    rows.set(localRows(read));
    list?.scrollToIndex({ index: 0, animated: false, viewPosition: 0 });
    const remote = source === 'files' || source === 'skills' || source === 'slash';
    const model = owner.modelDetails();
    const available =
      source === 'files' ||
      (model.kind === 'ready' && sameRoute(owner.backend(), model.choice.selection));
    loading.set(remote && available);
    wanted = remote && available ? read : null;
    if (wanted) void pump();
  });
  const command = (text: string) => {
    const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
    if (!match || match[1].startsWith('skill:')) return null;
    const found = options.commands().find((entry) => entry.trigger === match[1]);
    const argument = match[2]?.trim() ?? '';
    return found && (!argument || found.takesArgument) ? { found, argument } : null;
  };
  const runCommand = (
    owner: ComposerSession,
    text: string,
    command: ComposerCommand,
    argument: string | undefined,
    consume: boolean,
  ) => {
    const ticket = { owner, text, version: textVersion, id: command.id };
    if (
      pendingCommand &&
      pendingCommand.owner === owner &&
      pendingCommand.text === text &&
      pendingCommand.version === textVersion &&
      pendingCommand.id === command.id
    )
      return;
    pendingCommand = ticket;
    const finish = (accepted: void | boolean) => {
      if (pendingCommand === ticket) pendingCommand = null;
      if (
        consume &&
        accepted !== false &&
        alive &&
        options.session() === owner &&
        textVersion === ticket.version &&
        owner.draft() === text
      ) {
        textVersion += 1;
        owner.changeDraft('');
      }
    };
    try {
      const result = command.run(argument);
      if (result instanceof Promise)
        void result.then(finish, (reason) => {
          if (pendingCommand === ticket) pendingCommand = null;
          throw reason;
        });
      else finish(result);
    } catch (reason) {
      if (pendingCommand === ticket) pendingCommand = null;
      throw reason;
    }
  };
  const submitCommand = (owner: ComposerSession, text: string) => {
    const action = command(text);
    if (
      !action ||
      !options.active() ||
      options.session() !== owner ||
      owner.draft() !== text ||
      !owner.editable() ||
      composing()
    )
      return false;
    close();
    runCommand(owner, text, action.found, action.argument || undefined, true);
    return true;
  };
  const accept = (action: { read: number; id: string }) => {
    const read = current;
    const item = rows().find((entry) => entry.id === action.id);
    if (
      !read ||
      action.read !== read.serial ||
      !item ||
      item.disabled ||
      !owns(read) ||
      queryComposing()
    )
      return;
    if (item.kind === 'directory' && read.explicit) {
      const target = queryInput();
      if (!target) return;
      directoryHint = { prefix: item.path, path: item.directory };
      target.focus();
      target.replaceRange({
        start: 0,
        end: read.inputQuery.length,
        text: item.path + '/',
        expectedText: read.inputQuery,
        expectedSelection: querySelection(),
      });
      return;
    }
    if (item.kind === 'source') {
      dismissed = null;
      query.set('');
      explicit.set(item.source);
      return;
    }
    read.editor.focus();
    if (item.kind === 'attachment') {
      close();
      read.owner.attachments.open({ owner: read.owner.sessionId, value: true });
      return;
    }
    if (item.kind === 'command') {
      const selected = options
        .commands()
        .find((entry) => entry.id === item.command.id && entry.trigger === item.command.trigger);
      if (!selected) return;
      close();
      if (!read.explicit) {
        if (!read.token?.leading) return;
      }
      runCommand(
        read.owner,
        read.text,
        selected,
        !read.explicit && selected.takesArgument
          ? read.text.slice(read.token!.end).trim() || undefined
          : undefined,
        !read.explicit,
      );
      return;
    }
    if (item.kind === 'directory') {
      if (read.token?.kind !== 'file') return;
      const invocation = fileInvocation(item.path + '/');
      directoryHint = { prefix: item.path, path: item.directory };
      close();
      read.editor.replaceRange({
        start: read.token.start,
        end: read.token.end,
        text: invocation.startsWith('@"') ? invocation.slice(0, -1) : invocation,
        expectedText: read.text,
        expectedSelection: read.selection,
      });
      return;
    }
    const edit = referenceEdit(read.text, read.selection, read.token, item.insert);
    close();
    read.editor.replaceRange({
      ...edit,
      expectedText: read.text,
      expectedSelection: read.selection,
    });
  };
  const index = () => Math.min(selected(), Math.max(0, rows().length - 1));
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(rows().length - 1, index() + delta));
    selected.set(next);
    list?.scrollToIndex({
      index: next,
      animated: false,
      viewPosition: delta > 0 ? 1 : 0,
    });
  };
  effect(() => {
    const read = opened();
    if (!read || composing() || queryComposing()) return;
    const target = read.explicit && read.source !== 'add' ? queryInput() : read.editor;
    if (!target) return;
    const valid = () => current === read && owns(read);
    const unbind = [
      keymap.bind(
        'escape',
        () => {
          if (valid()) dismiss();
        },
        { when: 'always', within: target },
      ),
    ];
    if (loading() || rows().some((item) => !item.disabled)) {
      unbind.push(
        keymap.bind(
          'down',
          () => {
            if (valid()) move(1);
          },
          {
            when: 'always',
            repeat: true,
            within: target,
          },
        ),
        keymap.bind(
          'up',
          () => {
            if (valid()) move(-1);
          },
          {
            when: 'always',
            repeat: true,
            within: target,
          },
        ),
        ...['enter', 'tab'].map((key) =>
          keymap.bind(
            key,
            () => {
              if (!valid()) return;
              const item = rows()[index()];
              if (item) accept(item.action);
            },
            { when: 'always', within: target },
          ),
        ),
      );
    }
    return () => unbind.forEach((remove) => remove());
  });
  cleanup(() => {
    alive = false;
    hide();
  });
  return {
    rows,
    opened,
    loading,
    error,
    composing,
    accept,
    close,
    dismiss,
    index,
    query,
    queryComposing,
    clearDraft() {
      const owner = options.session();
      const target = editor();
      if (
        !alive ||
        !owner ||
        !target ||
        target.sessionId !== owner.sessionId ||
        !options.active() ||
        !owner.editable() ||
        composing()
      )
        return;
      const text = owner.draft();
      if (!text) return;
      target.node.replaceRange({
        start: 0,
        end: text.length,
        text: '',
        expectedText: text,
        expectedSelection: selection(),
      });
      close();
    },
    anchor: () => (opened()?.explicit ? addAnchor : (caret() ?? editor()?.node)),
    addButton(node: YNode) {
      addAnchor = node;
    },
    attach(sessionId: string | null, node: YNode) {
      directoryHint = null;
      editor.set({ sessionId, node });
      selection.set({ start: 0, end: 0 });
      caret.set(null);
      composing.set(false);
      queryComposing.set(false);
      explicit.set(null);
    },
    change(owner: ComposerSession, text: string) {
      if (options.session() !== owner) return;
      textVersion += 1;
      owner.changeDraft(text);
    },
    caret(owner: ComposerSession, event: { pageBounds: Rect }) {
      if (options.session() === owner) caret.set(event.pageBounds);
    },
    selection(owner: ComposerSession, event: Selection) {
      if (options.session() === owner) selection.set({ ...event });
    },
    composition(owner: ComposerSession, event: { composing: boolean }) {
      if (options.session() === owner) composing.set(event.composing);
    },
    toggleAdd(target: { sessionId: string | null }) {
      const owner = options.session();
      if (
        !owner ||
        !options.active() ||
        owner.sessionId !== target.sessionId ||
        !owner.editable() ||
        composing()
      )
        return;
      if (opened()?.source === 'add') {
        close();
        return;
      }
      editor()?.node.focus();
      dismissed = null;
      query.set('');
      explicit.set('add');
    },
    isCommand: () => !!options.session()?.editable() && !!command(options.session()!.draft()),
    submit(owner: ComposerSession, event: { text: string }) {
      if (options.session() !== owner || !options.active() || composing()) return;
      if (submitCommand(owner, event.text)) return;
      if (!loading()) owner.submit(event);
    },
    send(action: SendAction) {
      const owner = options.session();
      if (!owner || !options.active() || owner.sessionId !== action.owner) return;
      if (!submitCommand(owner, action.text)) owner.sendRendered(action);
    },
    list(node: YNode) {
      list = node;
    },
    queryInput(node: YNode) {
      queryInput.set(node);
      querySelection.set({ start: 0, end: 0 });
      node.focus();
    },
    querySelection(event: Selection) {
      querySelection.set({ ...event });
    },
    queryComposition(event: { composing: boolean }) {
      queryComposing.set(event.composing);
    },
    acceptSelected(action: { read: number }) {
      if (!current || current.serial !== action.read || !owns(current)) return;
      const item = rows()[index()];
      if (item) accept(item.action);
    },
    queryPlaceholder: () =>
      opened()?.source === 'files'
        ? tr('Search files…')
        : opened()?.source === 'commands'
          ? tr('Search commands…')
          : tr('Search skills…'),
    title: () =>
      opened()?.source === 'add'
        ? tr('Add to message')
        : opened()?.source === 'files'
          ? tr('Files')
          : opened()?.source === 'commands'
            ? tr('Commands')
            : tr('Skills'),
    empty: () =>
      opened()?.source === 'files'
        ? tr('No matching files.')
        : opened()?.source === 'commands'
          ? tr('No matching commands.')
          : options.session()?.backend() === null ||
              options.session()?.modelDetails().kind !== 'ready'
            ? tr('Choose a model to browse skills.')
            : tr('No matching skills.'),
  };
}

export type ComposerCompletionState = ReturnType<typeof createComposerCompletion>;

export function ComposerCompletion(props: { state: ComposerCompletionState }) {
  const state = props.state;
  const byId = computed(() => new Map(state.rows().map((row) => [row.id, row])));
  const ids = computed(() => state.rows().map((row) => row.id));
  return (
    <If when={state.opened() !== null}>
      <Overlay
        anchor={state.anchor()}
        placement="top"
        align="start"
        offset={8}
        margin={16}
        onPressOutside={state.close}
        onCancel={state.dismiss}
        accessibilityLabel={state.title()}
        style={{
          width: Math.min(480, Math.max(0, windowSize().width - 32)),
          maxHeight: Math.max(0, windowSize().height - 32),
          borderRadius: 12,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.surface,
          padding: 8,
          gap: 6,
        }}
      >
        <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 8 }}>
          {state.title()}
        </Text>
        <If when={state.opened()?.explicit && state.opened()?.source !== 'add'}>
          <Input
            ref={state.queryInput}
            value={state.query()}
            onChange={(text) => state.query.set(text)}
            onSelectionChange={state.querySelection}
            onSubmit={inputAction(state.acceptSelected, { read: state.opened()!.serial })}
            onCompositionChange={state.queryComposition}
            placeholder={state.queryPlaceholder()}
            accessibilityLabel={state.queryPlaceholder()}
            style={{
              ...bodyTextStyle,
              color: C.text,
              placeholderColor: C.muted,
              backgroundColor: C.background,
              borderRadius: 8,
              paddingHorizontal: 10,
              height: 36,
            }}
          />
        </If>
        <If when={state.loading()}>
          <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
            {state.opened()?.source === 'files' ? tr('Searching files…') : tr('Loading skills…')}
          </Text>
        </If>
        <If when={state.error()}>
          <Text selectable style={{ ...captionTextStyle, color: C.danger, padding: 8 }}>
            {state.error()}
          </Text>
        </If>
        <If when={!state.queryComposing()}>
          <List
            each={ids()}
            ref={state.list}
            estimatedItemSize={52}
            style={{
              height: Math.min(Math.max(1, state.rows().length) * 52, windowSize().height / 2),
              flexShrink: 1,
              minHeight: 0,
            }}
            empty={
              !state.loading() && !state.error() ? (
                <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
                  {state.empty()}
                </Text>
              ) : (
                <View />
              )
            }
          >
            {(id) => (
              <Each of={[byId().get(id())]} key={(row) => row?.action.read ?? -1}>
                {(value) => {
                  const row = value();
                  if (!row) return <View />;
                  return (
                    <Button
                      accessibilityLabel={row.title}
                      disabled={row.disabled}
                      onPress={inputAction(state.accept, row.action)}
                      style={{
                        height: 52,
                        borderRadius: 8,
                        paddingHorizontal: 10,
                        gap: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor:
                          state.rows()[state.index()]?.id === row.id ? C.raised : C.surface,
                      }}
                      hoverStyle={{ backgroundColor: C.raised }}
                      focusStyle={{ backgroundColor: C.line }}
                      disabledStyle={{ opacity: 0.5 }}
                    >
                      <Icon name={row.icon} color={C.secondary} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text numberOfLines={1} style={{ ...bodyTextStyle, color: C.text }}>
                          {row.title}
                        </Text>
                        <If when={row.detail}>
                          <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
                            {row.detail}
                          </Text>
                        </If>
                      </View>
                    </Button>
                  );
                }}
              </Each>
            )}
          </List>
        </If>
      </Overlay>
    </If>
  );
}
