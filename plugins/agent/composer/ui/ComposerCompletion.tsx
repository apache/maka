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

import { cleanup, effect, inputAction, List, Overlay, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { Bounds, CaretEvent, InputRef, ListRef, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { keymap } from 'nsh';
import { windowSize } from 'nsh';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { createText, errorText } from '../../../../products/maka/workbench/app/text';
import type {
  ComposerSession,
  ComposerSendAction as SendAction,
  ComposerCommand,
  ComposerViewInput,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import { sameRoute } from '../../../../products/maka/workbench/app/modelSelection';
import { matchComposerCommand } from '../../../../products/maka/workbench/app/composerCommands';
import {
  completionToken,
  fileInvocation,
  referenceEdit,
  validSelection,
} from './composerCompletionSyntax.ts';
import type { CompletionToken, Selection } from './composerCompletionSyntax.ts';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuLabelStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
} from '../../../../products/maka/workbench/app/ui';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { createComposerPaste } from './composerPaste';
import {
  inputEditor,
  type ComposerEditor,
} from '../../../../products/maka/workbench/app/ComposerEditor';

type Source = 'add' | 'files' | 'skills' | 'commands' | 'slash';
type Pending = NonNullable<ReturnType<NonNullable<ComposerViewInput['pending']>>>;
type Owner = ComposerSession | Pending;
const isSession = (owner: Owner): owner is ComposerSession => 'sessionId' in owner;
const editable = (owner: Owner) => (isSession(owner) ? owner.editable() : !owner.sending());
const sessionId = (owner: Owner) => (isSession(owner) ? owner.sessionId : null);
const ownerId = (owner: Owner) => (isSession(owner) ? owner.sessionId : owner.id);
type Editor = { sessionId: string | null; node: ComposerEditor };
type Read = {
  serial: number;
  owner: Owner;
  editor: ComposerEditor;
  text: string;
  selection: Selection;
  token: CompletionToken | null;
  source: Source;
  explicit: boolean;
  query: string;
  inputQuery: string;
  directory: WorkspacePath | null;
  context: string;
  commands: ComposerCommand[];
};
type Row = {
  id: string;
  title: string;
  detail?: string;
  /** The keys or trigger that reach this row directly, in the row's trailing lane. */
  shortcut?: string;
  /** The section the row belongs to, named above its first row. */
  heading?: string;
  /** A separator above the row, between unnamed groups. */
  divider?: boolean;
  icon: 'paperclip' | 'file' | 'folder' | 'book' | 'code' | 'command' | 'goal';
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
  pending(): Pending | null;
  commands(): ComposerCommand[];
  active(): boolean;
};
type FileRead = { close(): Promise<void>; closing: Promise<void> | null };

const sameSelection = (a: Selection, b: Selection) => a.start === b.start && a.end === b.end;
const contextKey = (owner: Owner) => {
  const backend = owner.backend();
  const details = owner.modelDetails();
  return JSON.stringify([
    isSession(owner) ? null : owner.confirmation(),
    backend,
    details.kind === 'ready' ? details.choice.selection : details.kind,
  ]);
};

/** One resident editor owns its menu, selection and latest outstanding lookup. */
export function createComposerCompletion(options: Options) {
  const owner = () => options.session() ?? options.pending();
  const editor = signal<Editor | null>(null);
  const caret = signal<Bounds | null>(null);
  const selection = signal<Selection>({ start: 0, end: 0 });
  const composing = () => !!editor()?.node.composing();
  const explicit = signal<Source | null>(null);
  const query = signal('');
  const queryInput = signal<ComposerEditor | null>(null);
  const querySelection = signal<Selection>({ start: 0, end: 0 });
  const queryComposing = signal(false);
  const opened = signal<Read | null>(null);
  const rows = signal<Row[]>([]);
  const selected = signal(0);
  const loading = signal(false);
  const error = createText();
  let list: ListRef | undefined;
  let addAnchor: ViewRef | undefined;
  let serial = 0;
  let current: Read | null = null;
  let dismissed: Pick<Read, 'owner' | 'editor' | 'text' | 'selection'> | null = null;
  let wanted: Read | null = null;
  let querying = false;
  let alive = true;
  let fileRead: FileRead | null = null;
  let directoryHint: { prefix: string; path: WorkspacePath } | null = null;
  let textVersion = 0;
  let pendingCommand: {
    owner: Owner;
    text: string;
    version: number;
    confirmation: string | null;
    id: string;
  } | null = null;

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
    return {
      query: value.slice(slash + 1),
      directory: { bytesBase64: btoa(binary) },
    };
  };

  const owns = (read: Read) =>
    alive &&
    options.active() &&
    owner() === read.owner &&
    editable(read.owner) &&
    editor()?.sessionId === sessionId(read.owner) &&
    editor()?.node === read.editor &&
    read.owner.draft() === read.text &&
    sameSelection(selection(), read.selection) &&
    contextKey(read.owner) === read.context &&
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
  const paste = createComposerPaste({
    owner: options.session,
    active: options.active,
    editor: (owner) => {
      const target = editor();
      return target?.sessionId === owner.sessionId ? target.node : null;
    },
    selection,
    composing,
    dismiss: close,
  });
  const row = <T extends Omit<Row, 'action'>>(read: Read, value: T): Row =>
    Object.assign(value, {
      action: { read: read.serial, id: value.id },
    }) as Row;
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
          get heading() {
            return tr('Commands');
          },
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
            return tr('Attach files…');
          },
          shortcut: keymap.label('mod+u'),
          icon: 'paperclip',
          disabled: isSession(read.owner)
            ? read.owner.attachments.restoring()
            : read.owner.completion.files === null,
        }),
        row(read, {
          id: 'add:files',
          kind: 'source',
          source: 'files',
          get title() {
            return tr('Reference a workspace file');
          },
          shortcut: '@',
          icon: 'file',
          disabled: read.owner.completion.files === null,
        }),
        row(read, {
          id: 'add:skills',
          kind: 'source',
          source: 'skills',
          get title() {
            return tr('Use a skill');
          },
          shortcut: '/',
          divider: true,
          icon: 'book',
        }),
        ...options
          .commands()
          .filter((command) => command.trigger === 'goal')
          .map((command) =>
            row(read, {
              id: `command:${command.id}`,
              kind: 'command',
              command,
              title: command.title,
              shortcut: '/goal',
              icon: 'goal',
            }),
          ),
        row(read, {
          id: 'add:commands',
          kind: 'source',
          source: 'commands',
          get title() {
            return tr('Message commands');
          },
          shortcut: '/',
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
    const owner = read.owner;
    if (read.source === 'files') {
      const files = owner.completion.files;
      if (!files) return;
      const stream = await files(read.query, read.directory);
      const active: FileRead = { close: () => stream.close(), closing: null };
      fileRead = active;
      const decoder = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      });
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
                title = owner.completion.pathLabel(entry.path);
              }
              const common = {
                id: `file:${entry.path.bytesBase64}`,
                get heading() {
                  return tr('Files');
                },
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
                : row(read, {
                    ...common,
                    kind: 'insert',
                    insert: insert ?? '',
                    icon: 'file',
                  });
            });
          appendRows(read, matches);
        }
      } finally {
        await releaseFile(active);
        if (fileRead === active) fileRead = null;
      }
      return;
    }
    const backend = owner.backend();
    const details = owner.modelDetails();
    if (!backend || details.kind !== 'ready' || !sameRoute(backend, details.choice.selection))
      return;
    const result = await owner.completion.skills({
      backend,
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
          get heading() {
            return tr('Skills');
          },
          icon: 'book',
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
    const currentOwner = owner();
    const binding = editor();
    if (!options.active()) {
      if (current) dismissed = current;
      explicit.set(null);
      hide();
      return;
    }
    if (
      !currentOwner ||
      !editable(currentOwner) ||
      !binding ||
      binding.sessionId !== sessionId(currentOwner) ||
      composing()
    ) {
      hide();
      return;
    }
    const text = currentOwner.draft();
    const range = selection();
    if (!validSelection(text, range)) {
      hide();
      return;
    }
    const context = { owner: currentOwner, editor: binding.node, text, selection: range };
    const requested = explicit();
    if (dismissed && !sameDismissed(context)) dismissed = null;
    if (sameDismissed(context)) {
      hide();
      return;
    }
    const token = completionToken(text, range);
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
      owner: currentOwner,
      editor: binding.node,
      text,
      selection: { ...range },
      token: requested === null ? token : null,
      source,
      explicit: requested !== null,
      ...location,
      inputQuery,
      context: contextKey(currentOwner),
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
    const model = currentOwner.modelDetails();
    const available =
      source === 'files'
        ? currentOwner.completion.files !== null
        : model.kind === 'ready' && sameRoute(currentOwner.backend(), model.choice.selection);
    loading.set(remote && available);
    wanted = remote && available ? read : null;
    if (wanted) void pump();
  });
  const command = (text: string) => matchComposerCommand(options.commands(), text);
  const runCommand = (
    target: Owner,
    text: string,
    command: ComposerCommand,
    argument: string | undefined,
    consume: boolean,
  ) => {
    const ticket = {
      owner: target,
      text,
      version: textVersion,
      confirmation: isSession(target) ? null : target.confirmation(),
      id: command.id,
    };
    if (
      pendingCommand &&
      pendingCommand.owner === target &&
      pendingCommand.text === text &&
      pendingCommand.version === textVersion &&
      pendingCommand.confirmation === ticket.confirmation &&
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
        owner() === target &&
        textVersion === ticket.version &&
        (isSession(target) || target.confirmation() === ticket.confirmation) &&
        target.draft() === text
      ) {
        textVersion += 1;
        target.changeDraft('');
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
  const submitCommand = (target: Owner, text: string) => {
    const action = command(text);
    if (
      !action ||
      !options.active() ||
      owner() !== target ||
      target.draft() !== text ||
      !editable(target) ||
      composing()
    )
      return false;
    close();
    runCommand(target, text, action.found, action.argument || undefined, true);
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
      if (isSession(read.owner))
        read.owner.attachments.open({ owner: read.owner.sessionId, value: true });
      else read.owner.openPicker(true);
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
      target.bindKey('escape', () => {
        if (valid()) dismiss();
      }),
    ];
    if (loading() || rows().some((item) => !item.disabled)) {
      unbind.push(
        target.bindKey(
          'down',
          () => {
            if (valid()) move(1);
          },
          {
            repeat: true,
          },
        ),
        target.bindKey(
          'up',
          () => {
            if (valid()) move(-1);
          },
          {
            repeat: true,
          },
        ),
        target.bindKey('enter', () => {
          if (!valid()) return;
          const item = rows()[index()];
          if (item) accept(item.action);
        }),
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
    paste: paste.paste,
    drop: paste.drop,
    pasteFocus: paste.focus,
    pasteBlur: paste.blur,
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
    anchor: () => (opened()?.explicit ? addAnchor : (caret() ?? editor()?.node.anchor)),
    addButton(node: ViewRef) {
      addAnchor = node;
    },
    attach(sessionId: string | null, node: ComposerEditor) {
      directoryHint = null;
      editor.set({ sessionId, node });
      selection.set({ start: 0, end: 0 });
      caret.set(null);
      queryComposing.set(false);
      explicit.set(null);
    },
    change(target: Owner, text: string) {
      if (owner() !== target) return;
      textVersion += 1;
      target.changeDraft(text);
    },
    caret(target: Owner, event: CaretEvent) {
      if (owner() === target) caret.set(event.pageBounds);
    },
    selection(target: Owner, event: Selection) {
      if (owner() === target) selection.set({ ...event });
    },
    toggleAdd(target: { owner: string | null }) {
      const currentOwner = owner();
      if (
        !currentOwner ||
        !options.active() ||
        ownerId(currentOwner) !== target.owner ||
        !editable(currentOwner) ||
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
    isCommand: () => {
      const target = owner();
      return !!target && editable(target) && !!command(target.draft());
    },
    submitPending(target: Pending, text: string, expected?: string) {
      if (
        owner() !== target ||
        !options.active() ||
        target.sending() ||
        composing() ||
        target.draft() !== text ||
        (expected !== undefined && target.confirmation() !== expected)
      )
        return;
      if (!submitCommand(target, text)) target.submit(text, expected);
    },
    submit(owner: ComposerSession, event: { text: string }) {
      if (options.session() !== owner || !options.active() || composing()) return;
      if (submitCommand(owner, event.text)) return;
      if (!loading()) owner.submit(event);
    },
    send(action: SendAction) {
      const owner = options.session();
      if (!owner || !options.active() || owner.sessionId !== action.owner || composing()) return;
      if (!submitCommand(owner, action.text)) {
        owner.sendRendered(action);
        editor()?.node.focus();
      }
    },
    list(node: ListRef) {
      list = node;
    },
    queryInput(node: InputRef) {
      queryInput.set(
        inputEditor(node, {
          value: query,
          setValue: (value) => query.set(value),
          selection: querySelection,
          setSelection: (selection) => querySelection.set(selection),
          composing: queryComposing,
        }),
      );
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
            : opened()?.source === 'slash'
              ? tr('Commands and skills')
              : tr('Skills'),
    empty: () =>
      opened()?.source === 'files'
        ? tr('No matching files.')
        : opened()?.source === 'commands'
          ? tr('No matching commands.')
          : owner()?.backend() === null || owner()?.modelDetails().kind !== 'ready'
            ? tr('Choose a model to browse skills.')
            : tr('No matching skills.'),
  };
}

export type ComposerCompletionState = ReturnType<typeof createComposerCompletion>;
export type ComposerCompletionRow = Pick<
  Row,
  'action' | 'detail' | 'disabled' | 'divider' | 'heading' | 'icon' | 'id' | 'shortcut' | 'title'
>;
export type ComposerCompletionView = Pick<
  ComposerCompletionState,
  | 'accept'
  | 'acceptSelected'
  | 'anchor'
  | 'close'
  | 'dismiss'
  | 'empty'
  | 'index'
  | 'list'
  | 'query'
  | 'queryComposition'
  | 'queryInput'
  | 'queryPlaceholder'
  | 'querySelection'
  | 'title'
> & {
  error(): string;
  loading(): boolean;
  opened(): Pick<Read, 'explicit' | 'serial' | 'source'> | null;
  queryComposing(): boolean;
  rows(): readonly ComposerCompletionRow[];
};

export function ComposerCompletion(props: { state: ComposerCompletionView }) {
  const state = props.state;
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
          ...floatingStyle(),
          width: Math.min(480, Math.max(0, windowSize().width - 32)),
          maxHeight: Math.max(0, windowSize().height - 32),
        }}
      >
        <If when={state.opened()?.explicit && state.opened()?.source !== 'add'}>
          <View style={menuRowStyle()}>
            <Icon name="search" color={C.muted} />
            <Input
              ref={state.queryInput}
              value={state.query()}
              onChange={({ value: text }) => state.query.set(text)}
              onSelectionChange={state.querySelection}
              onSubmit={inputAction(state.acceptSelected, {
                read: state.opened()!.serial,
              })}
              onCompositionChange={state.queryComposition}
              placeholder={state.queryPlaceholder()}
              accessibilityLabel={state.queryPlaceholder()}
              style={{
                ...captionTextStyle,
                flex: 1,
                minWidth: 0,
                color: C.text,
                placeholderColor: C.muted,
              }}
            />
          </View>
          <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
        </If>
        <If when={state.loading()}>
          <Text style={noteStyle()}>
            {state.opened()?.source === 'files' ? tr('Searching files…') : tr('Loading skills…')}
          </Text>
        </If>
        <If when={state.error()}>
          <Text style={[{ ...noteStyle(), color: C.danger }, { userSelect: 'text' }]}>
            {state.error()}
          </Text>
        </If>
        <If when={!state.queryComposing()}>
          <List
            each={state.rows()}
            keyExtractor={(row) => row.id}
            ref={state.list}
            estimatedItemSize={ROW}
            style={{
              height: Math.min(Math.max(ROW, listHeight(state.rows())), windowSize().height / 2),
              flexShrink: 1,
              minHeight: 0,
            }}
            empty={
              !state.loading() && !state.error() ? (
                <Text style={noteStyle()}>{state.empty()}</Text>
              ) : (
                <View />
              )
            }
          >
            {(row, index) => (
              <View>
                <If when={opensSection(state.rows(), index())}>
                  <Text style={menuLabelStyle()}>{row().heading}</Text>
                </If>
                <If when={row().divider && index() > 0}>
                  <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
                </If>
                <Button
                  accessibilityLabel={row().title}
                  disabled={row().disabled}
                  onPress={inputAction(state.accept, row().action)}
                  style={{
                    ...menuRowStyle(),
                    height: ROW,
                    backgroundColor: state.index() === index() ? C.floatingRaised : undefined,
                  }}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={menuRowHoverStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name={row().icon} color={C.secondary} />
                  <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: 8 }}>
                    <Text
                      style={[
                        { ...captionTextStyle, color: C.text, flexShrink: 1 },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {row().title}
                    </Text>
                    <If when={row().detail}>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.muted, flexShrink: 10, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {row().detail}
                      </Text>
                    </If>
                  </View>
                  <If when={row().shortcut}>
                    <Text style={{ ...menuDetailTextStyle, color: C.muted }}>{row().shortcut}</Text>
                  </If>
                </Button>
              </View>
            )}
          </List>
        </If>
      </Overlay>
    </If>
  );
}

const ROW = 32;
const HEADING = 28;
const DIVIDER = 9;
const opensSection = (rows: readonly ComposerCompletionRow[], index: number) =>
  !!rows[index]?.heading && rows[index]?.heading !== rows[index - 1]?.heading;
const listHeight = (rows: readonly ComposerCompletionRow[]) =>
  rows.reduce(
    (height, row, index) =>
      height +
      ROW +
      (opensSection(rows, index) ? HEADING : 0) +
      (row.divider && index > 0 ? DIVIDER : 0),
    0,
  );
const noteStyle = () => ({
  ...menuDetailTextStyle,
  color: C.muted,
  paddingHorizontal: 8,
  paddingVertical: 8,
});
