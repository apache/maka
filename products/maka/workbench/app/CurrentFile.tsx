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
  type Bounds,
  Clipboard,
  cleanup,
  computed,
  effect,
  Image,
  type InputRef,
  inputAction,
  keymap,
  List,
  Overlay,
  platform,
  Scroll,
  signal,
  Text,
  View,
  type ViewRef,
} from 'nsh';
import {
  Button,
  ContextMenu,
  Editor,
  type EditorDecoration,
  type EditorPosition,
  type EditorRange,
  type EditorRef,
  type EditorSearchResult,
  type EditorSelection,
  Input,
  MenuItem,
  Popover,
  TextView,
} from 'nsh/base';
import { currentWindow, isAvailable as desktopAvailable } from 'nsh/desktop';
import { MarkdownFileEditor } from 'maka/host';
import { settingsValue } from './settingsOperations';
import type { AgentFileChange } from '../../../../packages/plugin-sdk/src/index.js';
import type { FileView, Host, Output } from './host';
import { MermaidView } from './MermaidView';
import { Icon } from './Icon';
import { ImageViewerButton, type OpenImageViewer } from './ImageViewer';
import { tr } from './locale';
import { formatReviewNote, InlineReviewComposer, InlineReviewNoteCard } from './ReviewComposer';
import type {
  CodeDefinitionResult as AgentCodeDefinitionResult,
  CodeHoverResult as AgentCodeHoverResult,
  ReviewNote,
  ReviewStore,
} from './reviewState';
import {
  createText,
  errorText,
  isObservationCancelled,
  message,
  renderText,
  UiError,
  type UiText,
} from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  cardFocusStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';
import type { WorkspaceFileAnchor, WorkspaceFileTarget } from './workspaceFileState';

const MAX_EDITOR_TEXT_BYTES = 2 * 1024 * 1024;

type TextFile = Extract<FileView, { kind: 'text' }>;
type FileBuffer = { view: TextFile; version: string; original: string; text: string };
type FileState =
  | FileView
  | { kind: 'idle' }
  | { kind: 'loading'; previous: FileView | null }
  | { kind: 'error'; message: UiText; previous: FileView | null };

export type CurrentFileModel = {
  target: WorkspaceFileTarget;
  anchor(): WorkspaceFileAnchor | undefined;
  setAnchor(anchor?: WorkspaceFileAnchor): void;
  state(): FileState;
  buffer(): FileBuffer | null;
  dirty(): boolean;
  saving(): boolean;
  saveError(): string;
  revision(): number;
  edit(text: string): void;
  save(): Promise<boolean>;
  discard(): void;
  position: { x: number; y: number };
  stale(): boolean;
  activate(): void;
  suspend(): void;
  refresh(): void;
  dispose(): void;
};

export type FileCodeNavigation = {
  store: ReviewStore;
  canPrompt: boolean;
  deliverPrompt(text: string, mode: 'insert' | 'send'): boolean;
  checkDefinition(position: EditorPosition): Promise<AgentCodeDefinitionResult | null>;
  goToDefinition(position: EditorPosition): Promise<void>;
  findReferences(position: EditorPosition): Promise<void>;
  hover(position: EditorPosition): Promise<AgentCodeHoverResult | null>;
};

type FileSubscription = {
  readFile(): Promise<FileView>;
  close(): Promise<void>;
};
type WatchSubscription = {
  next(): Promise<AgentFileChange | null>;
  close(): Promise<void>;
};
type Watching = {
  stream: WatchSubscription | null;
  ready: boolean;
  changes: number;
};
type Reading = { stream: FileSubscription | null };

const captured = (state: FileState): FileView | null =>
  state.kind === 'idle'
    ? null
    : state.kind === 'loading' || state.kind === 'error'
      ? state.previous
      : state;

const close = async (resource: { stream: { close(): Promise<void> } | null } | null) => {
  const stream = resource?.stream;
  if (resource) resource.stream = null;
  if (stream) await stream.close();
};

export function createCurrentFile(host: Host, target: WorkspaceFileTarget): CurrentFileModel {
  const state = signal<FileState>({ kind: 'idle' });
  const buffer = signal<FileBuffer | null>(null);
  const saving = signal(false);
  const revision = signal(0);
  const saveError = createText();
  let pendingSave: Promise<boolean> | undefined;
  const dirty = () => {
    const b = buffer();
    return b !== null && b.original !== b.text;
  };
  const stale = signal(false);
  const anchor = signal<WorkspaceFileAnchor | undefined>(target.anchor);
  let alive = true;
  let active = false;
  let watching: Watching | null = null;
  let reading: Reading | null = null;
  const ownsWatch = (watch: Watching) => alive && active && watching === watch;
  const ownsRead = (read: Reading, watch: Watching) => ownsWatch(watch) && reading === read;
  const stopRead = () => {
    const previous = reading;
    reading = null;
    return close(previous);
  };
  const stop = () => {
    const previous = watching;
    watching = null;
    void close(previous).catch(() => {});
    void stopRead().catch(() => {});
  };
  const failWatch = (watch: Watching, reason: unknown) => {
    if (!ownsWatch(watch)) return;
    stop();
    stale.set(true);
    state.set({
      kind: 'error',
      message: errorText(reason, 'Could not read the file.'),
      previous: captured(state()),
    });
  };
  const read = (watch: Watching) => {
    if (!ownsWatch(watch) || !watch.ready) return;
    const previous = reading;
    const request: Reading = { stream: null };
    const changes = watch.changes;
    reading = request;
    state.set({ kind: 'loading', previous: captured(state()) });
    void (async () => {
      await close(previous);
      if (!ownsRead(request, watch)) return;
      const opened: FileSubscription = await host.readFile({
        sessionId: target.sessionId,
        path: target.path,
      });
      if (!ownsRead(request, watch)) {
        await opened.close();
        return;
      }
      request.stream = opened;
      try {
        const result = await opened.readFile();
        await close(request);
        if (!ownsRead(request, watch)) return;
        const previous = captured(state());
        if (
          !previous ||
          !('version' in previous) ||
          !('version' in result) ||
          previous.version !== result.version
        )
          model.position = { x: 0, y: 0 };
        const b = buffer();
        if (!dirty() && !saving()) {
          if (
            result.kind !== 'text' ||
            (b
              ? result.version !== b.version
              : previous?.kind !== 'text' || previous.version !== result.version)
          )
            revision.set(revision() + 1);
          buffer.set(null);
        } else if (b && !saving() && (result.kind !== 'text' || result.version !== b.version)) {
          saveError.set(message('File changed on disk.'));
        }
        stale.set(watch.changes !== changes || result.kind === 'changed');
        state.set(result);
      } finally {
        await close(request);
      }
    })()
      .catch((reason) => {
        if (ownsRead(request, watch))
          state.set({
            kind: 'error',
            message: errorText(reason, 'Could not read the file.'),
            previous: captured(state()),
          });
      })
      .finally(() => {
        if (reading === request) reading = null;
      });
  };
  const startWatch = () => {
    if (!alive || !active) return;
    stop();
    const watch: Watching = { stream: null, ready: false, changes: 0 };
    watching = watch;
    state.set({ kind: 'loading', previous: captured(state()) });
    void (async () => {
      for (let reconnects = 0; ownsWatch(watch); ) {
        let opened: WatchSubscription | null = null;
        try {
          opened = await host.subscribe('agent', 'watchFiles', {
            sessionId: target.sessionId,
            path: target.parent,
          });
          if (!ownsWatch(watch)) {
            await opened.close();
            return;
          }
          watch.stream = opened;
          for (;;) {
            const change = await opened.next();
            if (!ownsWatch(watch)) return;
            if (change === null) throw new UiError('File updates ended. Retry to reconnect.');
            reconnects = 0;
            if (change.kind === 'unavailable')
              throw new UiError(
                'The parent directory changed or is unavailable. Retry to reopen it.',
              );
            if (change.kind === 'ready') {
              watch.ready = true;
              read(watch);
            } else {
              watch.changes += 1;
              stale.set(true);
            }
          }
        } catch (reason) {
          if (!ownsWatch(watch)) return;
          if (isObservationCancelled(reason) && reconnects < 3) {
            reconnects += 1;
            if (reconnects > 1)
              await new Promise((resolve) => setTimeout(resolve, 250 * reconnects));
            continue;
          }
          throw reason;
        } finally {
          if (opened && watch.stream === opened) {
            watch.stream = null;
            await opened.close().catch(() => {});
          }
        }
      }
    })().catch((reason) => failWatch(watch, reason));
  };
  const write = async (b: FileBuffer) => {
    try {
      const { reply } = await host.control('saveFile', {
        sessionId: target.sessionId,
        path: target.path,
        expectedVersion: b.version,
        text: b.text,
      });
      const result = settingsValue(reply) as Output<'agent', 'saveFile'>;
      if (result.kind === 'conflict') {
        saveError.set(message('File changed on disk.'));
        return false;
      }
      buffer.set({ ...b, version: result.version, original: b.text, text: buffer()!.text });
      model.refresh();
      return true;
    } catch (reason) {
      saveError.set(errorText(reason, 'Could not save the file.'));
      return false;
    }
  };
  const suspend = () => {
    if (!active) return;
    active = false;
    if (alive) void model.save();
    stop();
    const previous = captured(state());
    if (state().kind === 'loading') state.set(previous ?? { kind: 'idle' });
    if (previous) stale.set(true);
  };
  const model: CurrentFileModel = {
    target,
    anchor,
    setAnchor(next) {
      anchor.set(next);
    },
    state,
    buffer,
    dirty,
    saving,
    saveError,
    revision,
    edit(text) {
      let b = buffer();
      if (!b) {
        const view = captured(state());
        if (view?.kind !== 'text') return;
        const original = view.rows.originalText();
        if (text === original) return;
        b = { view, version: view.version, original, text: original };
      }
      buffer.set({ ...b, text });
    },
    async save() {
      if (pendingSave) return (await pendingSave) && model.save();
      const b = buffer();
      if (!b || !dirty()) return true;
      saving.set(true);
      saveError.set('');
      pendingSave = write(b).finally(() => {
        pendingSave = undefined;
        saving.set(false);
      });
      return pendingSave;
    },
    discard() {
      if (saving()) return;
      buffer.set(null);
      saveError.set('');
      revision.set(revision() + 1);
      model.refresh();
    },
    stale,
    position: { x: 0, y: 0 },
    activate() {
      if (!alive || active) return;
      active = true;
      startWatch();
    },
    suspend,
    refresh() {
      if (!alive || !active) return;
      if (watching?.ready) read(watching);
      else startWatch();
    },
    dispose() {
      alive = false;
      suspend();
    },
  };
  return model;
}

export function CurrentFile(props: {
  model: CurrentFileModel;
  openImageViewer: OpenImageViewer;
  navigation?: FileCodeNavigation;
}) {
  const model = props.model;
  const view = () => model.buffer()?.view ?? captured(model.state());
  const textCapture = computed(
    () => {
      const value = view();
      return value?.kind === 'text' ? value : null;
    },
    { equals: (left, right) => left === right },
  );
  const copying = signal(false);
  const copyReceipt = signal<{
    version: string;
    digest: string;
    failed: boolean;
    message: UiText;
  } | null>(null);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const copyAction = computed(() => {
    const original = textCapture();
    if (original === null) return undefined;
    const owns = () => mounted && textCapture() === original;
    const copy = async () => {
      if (!owns() || copying()) return;
      copying.set(true);
      copyReceipt.set(null);
      try {
        await Clipboard.writeText(model.buffer()?.text ?? original.rows.originalText());
        if (owns())
          copyReceipt.set({
            version: original.version,
            digest: original.digest,
            failed: false,
            message: '',
          });
      } catch (reason) {
        if (owns())
          copyReceipt.set({
            version: original.version,
            digest: original.digest,
            failed: true,
            message: errorText(reason, 'Could not copy to the clipboard.'),
          });
      } finally {
        if (mounted) copying.set(false);
      }
    };
    return inputAction(copy, null);
  });
  const copied = () => {
    const receipt = copyReceipt();
    const original = textCapture();
    return receipt &&
      original &&
      receipt.version === original.version &&
      receipt.digest === original.digest
      ? receipt
      : null;
  };
  const readable = () => {
    const value = view();
    return value?.kind === 'image' || value?.kind === 'text';
  };
  const emptyHeight = signal(0);
  const error = () => {
    const value = model.state();
    return value.kind === 'error' ? renderText(value.message) : '';
  };
  const failed = () => model.state().kind === 'error';
  const notice = () => {
    const value = view();
    switch (value?.kind) {
      case 'absent':
        return tr('This file no longer exists.');
      case 'changed':
        return tr('This file changed while it was being read. Refresh to capture it again.');
      case 'binary':
        return tr('Binary file · {bytes} bytes. A text preview is unavailable.', {
          bytes: value.bytes,
        });
      case 'unsupported':
        return tr('This {kind} cannot be previewed.', {
          kind:
            value.fileKind === 'symlink'
              ? tr('symbolic link')
              : value.fileKind === 'directory'
                ? tr('directory')
                : value.fileKind === 'file'
                  ? tr('file')
                  : tr('other'),
        });
      default:
        return '';
    }
  };
  const emptyMessage = () => {
    if (failed()) return error();
    if (model.state().kind === 'loading') return tr('Reading current file…');
    return notice();
  };

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
      <If when={!readable()}>
        <Scroll
          accessibilityLabel={tr('File preview status')}
          onLayout={({ bounds: frame }) => emptyHeight.set(frame.size.height)}
          style={{ flex: 1, minHeight: 0 }}
        >
          <View
            style={{
              minHeight: emptyHeight(),
              padding: 16,
              gap: 16,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <View
              accessibilityElementsHidden
              style={[
                {
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  backgroundColor: C.card,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                { pointerEvents: 'none' },
              ]}
            >
              <Icon name="file" color={C.muted} />
            </View>
            <Text
              style={[
                {
                  ...bodyTextStyle,
                  width: '100%',
                  color: failed() ? C.danger : C.secondary,
                  textAlign: 'center',
                },
                { userSelect: failed() ? 'text' : 'none' },
              ]}
            >
              {emptyMessage()}
            </Text>
            <If when={(failed() || view()?.kind === 'changed') && model.state().kind !== 'loading'}>
              <RetryCurrentFile model={model} />
            </If>
          </View>
        </Scroll>
      </If>
      <Each
        of={readable() && view() ? [view()!] : []}
        key={(value) =>
          value.kind === 'text' && value.bytes <= MAX_EDITOR_TEXT_BYTES ? 'editor' : value
        }
      >
        {(value) => {
          const snapshot = value();
          if (snapshot.kind === 'text') {
            if (snapshot.bytes <= MAX_EDITOR_TEXT_BYTES) {
              return (
                <SourceEditorView
                  model={model}
                  view={() => value() as Extract<FileView, { kind: 'text' }>}
                  copyAction={copyAction}
                  copied={copied}
                  navigation={props.navigation}
                />
              );
            }
            return (
              <LargeFileRows
                model={model}
                view={snapshot}
                copyAction={copyAction}
                copied={copied}
              />
            );
          }
          if (snapshot.kind === 'image')
            return (
              <FileImage model={model} view={snapshot} openImageViewer={props.openImageViewer} />
            );
          return <View />;
        }}
      </Each>
    </View>
  );
}

type HoverCardState = {
  anchor: Bounds;
  position: EditorPosition;
  symbol: string;
  backendLabel: string;
  markdown: string;
};

type FileDraftNote = {
  editId?: string;
  startLine: number;
  endLine: number;
  initialComment?: string;
};

// NSH's code editor returns LF. Keep the separators of existing lines, including mixed-EOL files.
function sourceLineEndings(previous: string, edited: string): string {
  if (!previous.includes('\r')) return edited;
  const endings = previous.match(/\r\n|[\r\n]/g)!;
  const before = previous.split(/\r\n|[\r\n]/);
  const after = edited.split('\n');
  let tail = 0;
  while (
    tail < Math.min(before.length, after.length) &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const delta = after.length - before.length;
  const changedEnd = after.length - tail;
  return after
    .map((line, i) => {
      if (i === after.length - 1) return line;
      const old = i >= changedEnd - 1 ? i - delta : i;
      return line + (endings[old] ?? endings[Math.max(0, changedEnd - delta - 1)] ?? endings[0]);
    })
    .join('');
}

function FileAction(props: {
  label: string;
  icon?: Parameters<typeof Icon>[0]['name'];
  iconInMenu?: Parameters<typeof Icon>[0]['name'];
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      tooltip={props.icon ? textTooltip(() => props.label) : undefined}
      onPress={props.onPress}
      disabled={props.disabled}
      style={
        props.iconInMenu
          ? { ...menuRowStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }
          : {
              ...controlStyle,
              minHeight: 28,
              paddingHorizontal: 7,
              alignItems: 'center',
              justifyContent: 'center',
            }
      }
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <If when={props.icon || props.iconInMenu}>
        <Icon name={(props.icon ?? props.iconInMenu)!} size={14} color={C.secondary} />
      </If>
      <If when={!props.icon}>
        <Text style={{ ...captionTextStyle, color: C.text }}>{props.label}</Text>
      </If>
    </Button>
  );
}

function SourceEditorView(props: {
  model: CurrentFileModel;
  view: () => Extract<FileView, { kind: 'text' }>;
  copyAction: () => (() => void) | undefined;
  copied: () => { failed: boolean; message: UiText } | null;
  navigation?: FileCodeNavigation;
}) {
  const model = props.model;
  const fileMenu = signal(false);
  const markdown = /\.(?:md|markdown|mdown|mkd)$/i.test(model.target.title);
  const formatted = signal(markdown && !model.anchor());
  const softWrap = signal(false);
  const finding = signal(false);
  const findQuery = signal('');
  const caseSensitive = signal(false);
  const wholeWord = signal(false);
  const searchResult = signal<EditorSearchResult>({ count: 0 });
  const selections = signal<EditorSelection[]>([]);
  const flashRange = signal<EditorRange | null>(null);
  const hoverCard = signal<HoverCardState | null>(null);
  const draftNote = signal<FileDraftNote | null>(null);

  let editorRef: EditorRef | undefined;
  let containerNode: ViewRef | undefined;
  let unbindKeys: (() => void)[] = [];
  let unbindFindEsc: (() => void) | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverSeq = 0;
  let pointerInHover = false;

  cleanup(() => {
    for (const fn of unbindKeys) fn();
    unbindFindEsc?.();
    clearTimeout(flashTimer);
    clearTimeout(hoverTimer);
  });

  if (desktopAvailable && platform.idiom !== 'terminal') {
    cleanup(
      currentWindow().on('focusChange', ({ focused }) => {
        if (!focused) void model.save();
      }),
    );
  }

  const originalText = computed(() => props.view().rows.originalText());
  const fullText = () => model.buffer()?.text ?? originalText();

  const primaryPosition = (): EditorPosition => {
    const primary = selections().at(-1);
    return primary ? primary.head : { line: 0, column: 0 };
  };

  const selectedLineSpan = (): { startLine: number; endLine: number } => {
    const primary = selections().at(-1);
    if (!primary) return { startLine: 0, endLine: 0 };
    const startLine = Math.min(primary.anchor.line, primary.head.line);
    let endLine = Math.max(primary.anchor.line, primary.head.line);
    if (endLine > startLine && primary.head.column === 0 && primary.head.line === endLine) {
      endLine -= 1;
    }
    return { startLine, endLine };
  };

  const fileNotes = computed<ReviewNote[]>(() => {
    const store = props.navigation?.store;
    if (!store) return [];
    return store
      .notes(model.target.sessionId)
      .filter((n) => n.path.bytesBase64 === model.target.path.bytesBase64 && n.area === undefined);
  });

  const decorations = computed<EditorDecoration[]>(() => {
    const out: EditorDecoration[] = [];
    const flash = flashRange();
    if (flash) {
      out.push({
        range: flash,
        lineStyle: { backgroundColor: C.raised },
        gutter: { style: { backgroundColor: C.accent } },
      });
    }
    for (const note of fileNotes()) {
      out.push({
        range: {
          start: { line: note.startLine, column: 0 },
          end: { line: note.endLine, column: 0 },
        },
        lineStyle: { backgroundColor: C.panel },
        gutter: { style: { backgroundColor: C.accent } },
      });
    }
    return out;
  });

  const applyAnchor = (anchor: WorkspaceFileAnchor | undefined) => {
    if (!anchor || !editorRef) return;
    const line = Math.max(0, anchor.line);
    const endLine = Math.max(line, anchor.endLine ?? line);
    const column = Math.max(0, anchor.column ?? 0);
    const range: EditorRange = {
      start: { line, column },
      end: { line: endLine, column },
    };
    editorRef.setSelections([{ anchor: range.start, head: range.end }]);
    editorRef.revealPosition(range.start, true);
    flashRange.set(range);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashRange.set(null), 2200);
  };

  effect(() => {
    const currentAnchor = model.anchor();
    const _ver = props.view().version;
    void _ver;
    if (currentAnchor) {
      formatted.set(false);
      setTimeout(() => applyAnchor(currentAnchor), 0);
    }
  });

  const extractExcerpt = (startLine: number, endLine: number): string => {
    const lines = fullText().split(/\r?\n/);
    return lines.slice(startLine, endLine + 1).join('\n');
  };

  const startCommentSelection = (range?: { startLine: number; endLine: number }) => {
    const span = range ?? selectedLineSpan();
    draftNote.set({ startLine: span.startLine, endLine: span.endLine });
  };

  const openFind = async () => {
    formatted.set(false);
    const raw = editorRef ? await editorRef.selectedText() : '';
    const selected = raw.trim();
    if (selected && !selected.includes('\n')) findQuery.set(selected);
    finding.set(true);
  };

  const closeFind = () => {
    finding.set(false);
    findQuery.set('');
    editorRef?.focus();
  };

  const scheduleCloseHover = () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!pointerInHover) hoverCard.set(null);
    }, 180);
  };

  const bindShortcuts = (node: ViewRef | null) => {
    containerNode = node ?? undefined;
    for (const fn of unbindKeys) fn();
    unbindKeys = [];
    if (!node) return;
    unbindKeys.push(
      keymap.bind('mod+s', () => void model.save(), { within: node, when: 'always' }),
      keymap.bind('mod+f', () => void openFind(), { within: node, when: 'always' }),
      keymap.bind(
        'shift+f12',
        () => {
          if (props.navigation) void props.navigation.findReferences(primaryPosition());
        },
        { within: node },
      ),
    );
  };

  const buildNoteInput = (draft: FileDraftNote, comment: string) => ({
    ...(draft.editId ? { id: draft.editId } : {}),
    sessionId: model.target.sessionId,
    path: model.target.path,
    pathLabel: model.target.title,
    side: 'new' as const,
    startLine: draft.startLine,
    endLine: draft.endLine,
    excerpt: extractExcerpt(draft.startLine, draft.endLine),
    comment,
  });

  const statusNotice = () =>
    props.navigation ? props.navigation.store.statusMessage(model.target.sessionId) : '';

  return (
    <View ref={bindShortcuts} style={{ flex: 1, minHeight: 0, gap: 6 }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}
      >
        <If when={markdown}>
          <FileAction
            icon={formatted() ? 'code' : 'markdown'}
            label={formatted() ? tr('Show Markdown source') : tr('Show formatted Markdown')}
            onPress={() => formatted.set(!formatted())}
          />
        </If>
        <FileAction
          icon="search"
          label={tr('Find in file')}
          onPress={() => (finding() ? closeFind() : void openFind())}
        />
        <Popover
          placement="bottom"
          align="end"
          offset={4}
          margin={8}
          open={fileMenu()}
          onOpenChange={({ open }) => fileMenu.set(open)}
          popupStyle={{ ...floatingStyle(), minWidth: 166 }}
          trigger={
            <Button
              accessibilityLabel={tr('File actions')}
              tooltip={textTooltip(() => tr('File actions'))}
              style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="more" size={15} color={C.secondary} />
            </Button>
          }
        >
          <View style={{ gap: 2 }}>
            <If when={!formatted()}>
              <FileAction
                iconInMenu={softWrap() ? 'check' : 'wrap'}
                label={tr('Wrap lines')}
                onPress={() => {
                  fileMenu.set(false);
                  softWrap.set(!softWrap());
                }}
              />
            </If>
            <FileAction
              iconInMenu="copy"
              label={tr('Copy file contents')}
              onPress={() => {
                fileMenu.set(false);
                props.copyAction()?.();
              }}
            />
            <FileAction
              iconInMenu="refresh"
              label={tr('Refresh current file')}
              onPress={() => {
                fileMenu.set(false);
                model.refresh();
              }}
            />
          </View>
        </Popover>
      </View>

      <If when={props.copied()?.failed}>
        <Text style={{ ...captionTextStyle, color: C.warning }}>
          {renderText(props.copied()!.message)}
        </Text>
      </If>
      <If when={!!model.saveError()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ ...captionTextStyle, color: C.warning }}>{model.saveError()}</Text>
          <FileAction
            label={tr('Discard edits')}
            disabled={model.saving()}
            onPress={model.discard}
          />
        </View>
      </If>
      <If when={statusNotice().length > 0}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{statusNotice()}</Text>
      </If>

      <If when={finding()}>
        <View
          ref={(node) => {
            unbindFindEsc?.();
            unbindFindEsc = node
              ? keymap.bind('escape', () => closeFind(), { when: 'always', within: node })
              : undefined;
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            padding: 4,
            borderRadius: 8,
            backgroundColor: C.card,
          }}
        >
          <Input
            ref={(node: InputRef | null) => node?.focus()}
            value={findQuery()}
            onChange={({ value }) => findQuery.set(value)}
            onSubmit={() => editorRef?.run('findNext')}
            submitBehavior="submit"
            placeholder={tr('Find in file…')}
            accessibilityLabel={tr('Find in file')}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              ...bodyTextStyle,
              flex: 1,
              minWidth: 80,
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 6,
              backgroundColor: C.panel,
              color: C.text,
            }}
          />
          <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 4 }}>
            {findQuery().length > 0 ? String(searchResult().count) : ''}
          </Text>
          <Button
            accessibilityLabel={tr('Match case')}
            selected={caseSensitive()}
            onPress={() => caseSensitive.set(!caseSensitive())}
            style={{
              ...controlStyle,
              minHeight: 24,
              height: 24,
              paddingHorizontal: 6,
              backgroundColor: caseSensitive() ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text style={{ ...codeTextStyle, fontSize: 11, color: C.secondary }}>Aa</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Whole word')}
            selected={wholeWord()}
            onPress={() => wholeWord.set(!wholeWord())}
            style={{
              ...controlStyle,
              minHeight: 24,
              height: 24,
              paddingHorizontal: 6,
              backgroundColor: wholeWord() ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text style={{ ...codeTextStyle, fontSize: 11, color: C.secondary }}>W</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Previous match')}
            onPress={() => editorRef?.run('findPrevious')}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="up" size={13} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Next match')}
            onPress={() => editorRef?.run('findNext')}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="down" size={13} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Close find')}
            onPress={closeFind}
            style={{
              ...controlStyle,
              width: 24,
              minHeight: 24,
              paddingHorizontal: 4,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="close" size={13} color={C.muted} />
          </Button>
        </View>
      </If>

      <If when={model.state().kind === 'error'}>
        <CapturedFileStatus model={model} />
      </If>

      <If when={draftNote() !== null && props.navigation !== undefined}>
        <InlineReviewComposer
          startLine={draftNote()!.startLine}
          endLine={draftNote()!.endLine}
          initialComment={draftNote()!.initialComment}
          canPrompt={props.navigation!.canPrompt}
          onSave={(comment) => {
            const cur = draftNote()!;
            props.navigation!.store.upsertNote(buildNoteInput(cur, comment));
            draftNote.set(null);
          }}
          onInsertPrompt={(comment) => {
            const cur = draftNote()!;
            const text = formatReviewNote(buildNoteInput(cur, comment));
            if (props.navigation!.deliverPrompt(text, 'insert')) {
              if (cur.editId)
                props.navigation!.store.removeNote(model.target.sessionId, cur.editId);
              draftNote.set(null);
            }
          }}
          onSendNow={(comment) => {
            const cur = draftNote()!;
            const text = formatReviewNote(buildNoteInput(cur, comment));
            if (props.navigation!.deliverPrompt(text, 'send')) {
              if (cur.editId)
                props.navigation!.store.removeNote(model.target.sessionId, cur.editId);
              draftNote.set(null);
            }
          }}
          onCancel={() => draftNote.set(null)}
        />
      </If>

      <If when={fileNotes().length > 0 && draftNote() === null && props.navigation !== undefined}>
        <Scroll style={{ maxHeight: 132, flexShrink: 0 }}>
          <Each of={fileNotes()} key={(n) => n.id}>
            {(note) => (
              <InlineReviewNoteCard
                note={note()}
                canPrompt={props.navigation!.canPrompt}
                onEdit={() =>
                  draftNote.set({
                    editId: note().id,
                    startLine: note().startLine,
                    endLine: note().endLine,
                    initialComment: note().comment,
                  })
                }
                onRemove={() => props.navigation!.store.removeNote(note().sessionId, note().id)}
                onSendNow={() => {
                  const text = formatReviewNote(note());
                  if (props.navigation!.deliverPrompt(text, 'send')) {
                    props.navigation!.store.removeNote(note().sessionId, note().id);
                  }
                }}
              />
            )}
          </Each>
        </Scroll>
      </If>

      <Each of={formatted() ? [model.revision()] : []} key={(revision) => revision}>
        {() => (
          <MarkdownFileEditor
            renderDiagram={(source) => <MermaidView editable source={() => source} />}
            initialValue={fullText()}
            linkColor={C.accent}
            accessibilityLabel={tr('Markdown document')}
            styles={{
              root: { ...bodyTextStyle, color: C.text },
              content: { padding: 12 },
              caret: { backgroundColor: C.text },
              nodes: { paragraph: bodyTextStyle },
            }}
            style={{ flex: 1, minHeight: 0 }}
            onChange={({ value }) => model.edit(value)}
            onSave={() => void model.save()}
            onFind={() => void openFind()}
          />
        )}
      </Each>
      <If when={!formatted()}>
        <ContextMenu
          offset={4}
          margin={8}
          style={{ flex: 1, minHeight: 0 }}
          popupStyle={{ ...floatingStyle(), minWidth: 188 }}
          trigger={
            <View
              style={{
                flex: 1,
                minHeight: 0,
                borderRadius: 8,
                overflow: 'hidden',
                backgroundColor: C.card,
              }}
            >
              <Editor
                ref={(node) => {
                  editorRef = node;
                  if (node && model.anchor()) applyAnchor(model.anchor());
                }}
                value={fullText().replace(/\r\n?/g, '\n')}
                onChange={({ value }) => model.edit(sourceLineEndings(fullText(), value))}
                onBlur={() => void model.save()}
                language={model.target.title}
                lineNumbers
                folding
                softWrap={softWrap()}
                scrollBeyondLastLine={false}
                fontSize={codeTextStyle.fontSize}
                lineHeight={codeTextStyle.lineHeight}
                decorations={decorations()}
                search={{
                  query: finding() ? findQuery() : '',
                  caseSensitive: caseSensitive(),
                  wholeWord: wholeWord(),
                }}
                accessibilityLabel={tr('Captured file text')}
                onSelectionChange={({ selections: next }) => selections.set(next)}
                onSearchChange={({ result }) => searchResult.set(result)}
                onFindWithSelection={({ query }) => {
                  findQuery.set(query);
                  finding.set(true);
                }}
                onLineNumberPress={({ line }) => {
                  if (props.navigation && !model.dirty())
                    startCommentSelection({ startLine: line, endLine: line });
                }}
                onDefinitionRequest={async (event) => {
                  if (!props.navigation || model.dirty()) return;
                  if (event.trigger === 'hover') {
                    const res = await props.navigation.checkDefinition(event.position);
                    if (res && res.locations.length > 0) {
                      editorRef?.presentDefinitionLink(event.id, res.originRange ?? event.range);
                    }
                  } else {
                    hoverCard.set(null);
                    await props.navigation.goToDefinition(event.position);
                  }
                }}
                onHover={async (event) => {
                  if (!props.navigation || platform.idiom === 'terminal') return;
                  clearTimeout(hoverTimer);
                  const seq = ++hoverSeq;
                  const info = await props.navigation.hover(event.position);
                  if (seq !== hoverSeq) return;
                  if (!info) {
                    hoverCard.set(null);
                    return;
                  }
                  hoverCard.set({
                    anchor: event.pageBounds,
                    position: event.position,
                    symbol: info.symbol,
                    backendLabel:
                      info.backend.kind === 'lsp' ? info.backend.server : tr('Indexed fallback'),
                    markdown: info.markdown,
                  });
                }}
                onHoverEnd={() => {
                  hoverSeq += 1;
                  scheduleCloseHover();
                }}
                style={{ flex: 1, minHeight: 0 }}
              />
            </View>
          }
        >
          <If when={props.navigation !== undefined && !model.dirty()}>
            <MenuItem
              onSelect={() => void props.navigation!.goToDefinition(primaryPosition())}
              style={{ ...menuRowStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={menuRowHoverStyle()}
              focusStyle={menuRowHoverStyle()}
            >
              <Icon name="arrow" size={14} color={C.accent} />
              <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
                {tr('Go to definition')}
              </Text>
              <Text style={{ ...captionTextStyle, color: C.muted }}>F12</Text>
            </MenuItem>
            <MenuItem
              onSelect={() => void props.navigation!.findReferences(primaryPosition())}
              style={{ ...menuRowStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={menuRowHoverStyle()}
              focusStyle={menuRowHoverStyle()}
            >
              <Icon name="symbol" size={14} color={C.secondary} />
              <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
                {tr('Find references')}
              </Text>
              <Text style={{ ...captionTextStyle, color: C.muted }}>⇧F12</Text>
            </MenuItem>
            <MenuItem
              onSelect={() => startCommentSelection()}
              style={{ ...menuRowStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }}
              hoverStyle={menuRowHoverStyle()}
              focusStyle={menuRowHoverStyle()}
            >
              <Icon name="plus" size={14} color={C.accent} />
              <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
                {tr('Add review note')}
              </Text>
            </MenuItem>
          </If>
          <MenuItem
            onSelect={() => {
              void (async () => {
                const selected = editorRef ? await editorRef.selectedText() : '';
                await Clipboard.writeText(selected || fullText());
              })();
            }}
            style={{ ...menuRowStyle(), flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={menuRowHoverStyle()}
            focusStyle={menuRowHoverStyle()}
          >
            <Icon name="copy" size={14} color={C.secondary} />
            <Text style={{ ...captionTextStyle, flex: 1, color: C.text }}>
              {tr('Copy captured file')}
            </Text>
          </MenuItem>
        </ContextMenu>
      </If>

      <If when={hoverCard() !== null && props.navigation !== undefined}>
        <Overlay
          anchor={hoverCard()!.anchor}
          placement="top"
          align="start"
          offset={6}
          margin={8}
          onCancel={() => hoverCard.set(null)}
        >
          <View
            onMouseEnter={() => {
              pointerInHover = true;
              clearTimeout(hoverTimer);
            }}
            onMouseLeave={() => {
              pointerInHover = false;
              scheduleCloseHover();
            }}
            style={{
              ...floatingStyle(),
              maxWidth: 420,
              padding: 8,
              gap: 6,
              backgroundColor: C.card,
            }}
          >
            <Scroll style={{ maxHeight: 180 }}>
              <TextView markdown={hoverCard()!.markdown} />
            </Scroll>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                borderTopWidth: 1,
                borderTopColor: C.line,
                paddingTop: 6,
              }}
            >
              <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
                {hoverCard()!.backendLabel}
              </Text>
              <Button
                onPress={() => {
                  const pos = hoverCard()!.position;
                  hoverCard.set(null);
                  void props.navigation!.goToDefinition(pos);
                }}
                style={{
                  ...controlStyle,
                  minHeight: 24,
                  height: 24,
                  paddingHorizontal: 8,
                  backgroundColor: C.cardRaised,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Definition')}</Text>
              </Button>
              <Button
                onPress={() => {
                  const pos = hoverCard()!.position;
                  hoverCard.set(null);
                  void props.navigation!.findReferences(pos);
                }}
                style={{
                  ...controlStyle,
                  minHeight: 24,
                  height: 24,
                  paddingHorizontal: 8,
                  backgroundColor: C.cardRaised,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('References')}</Text>
              </Button>
            </View>
          </View>
        </Overlay>
      </If>
    </View>
  );
}

function RetryCurrentFile(props: { model: CurrentFileModel }) {
  return (
    <Button
      accessibilityLabel={tr('Retry current file')}
      disabled={props.model.state().kind === 'loading'}
      onPress={inputAction(props.model.refresh, null)}
      style={{
        ...controlStyle,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.card,
      }}
      hoverStyle={{ backgroundColor: C.cardRaised }}
      focusStyle={cardFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Icon name="refresh" color={C.secondary} />
      <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Retry')}</Text>
    </Button>
  );
}

function CapturedFileStatus(props: { model: CurrentFileModel; selectable?: boolean }) {
  const model = props.model;
  return (
    <If when={model.stale() || model.state().kind === 'loading' || model.state().kind === 'error'}>
      <View style={{ padding: 6, gap: 6, alignItems: 'flex-start' }}>
        <If when={model.stale() && model.state().kind !== 'error'}>
          <Text style={[{ ...captionTextStyle, color: C.warning }, { userSelect: 'none' }]}>
            {tr('The workspace may have changed. Refresh for current contents.')}
          </Text>
        </If>
        <If when={model.state().kind === 'loading'}>
          <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
            {tr('Reading current file…')}
          </Text>
        </If>
        <If when={model.state().kind === 'error'}>
          <Text
            style={[
              { ...bodyTextStyle, color: C.danger },
              { userSelect: props.selectable !== false ? 'text' : 'none' },
            ]}
          >
            {renderText((model.state() as Extract<FileState, { kind: 'error' }>).message)}
          </Text>
          <RetryCurrentFile model={model} />
        </If>
      </View>
    </If>
  );
}

function LargeFileRows(props: {
  model: CurrentFileModel;
  view: Extract<FileView, { kind: 'text' }>;
  copyAction: () => (() => void) | undefined;
  copied: () => { failed: boolean; message: UiText } | null;
}) {
  const initialOffset = { ...props.model.position };
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="file" size={14} color={C.muted} />
        <Text
          style={[
            { ...captionTextStyle, flex: 1, color: C.text, fontWeight: '500' },
            { numberOfLines: 1 },
          ]}
        >
          {props.model.target.title}
        </Text>
        <Button
          accessibilityLabel={tr('Copy captured file')}
          onPress={props.copyAction()}
          style={{
            ...controlStyle,
            width: 28,
            minHeight: 28,
            paddingHorizontal: 6,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon
            name={props.copied() && !props.copied()!.failed ? 'check' : 'copy'}
            size={14}
            color={C.secondary}
          />
        </Button>
        <Button
          accessibilityLabel={tr('Refresh current file')}
          onPress={inputAction(props.model.refresh, null)}
          style={{
            ...controlStyle,
            width: 28,
            minHeight: 28,
            paddingHorizontal: 6,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="refresh" size={14} color={C.secondary} />
        </Button>
      </View>
      <View selectable style={{ flex: 1, minHeight: 0 }}>
        <List
          each={props.view.rows}
          keyExtractor={(row) => String(row.offset)}
          estimatedItemSize={codeTextStyle.lineHeight}
          contentOffset={initialOffset}
          onScroll={(event) => {
            if (mounted) props.model.position = { x: event.offset.x, y: event.offset.y };
          }}
          accessibilityLabel={tr('Captured file text')}
          style={{ flex: 1, minHeight: 0, backgroundColor: C.card }}
          header={<CapturedFileStatus model={props.model} selectable={false} />}
        >
          {(row) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                minHeight: codeTextStyle.lineHeight,
                gap: 8,
              }}
            >
              <Text
                style={[
                  {
                    ...codeTextStyle,
                    width: Math.max(24, String(props.view.rows.length).length * 8),
                    color: C.muted,
                  },
                  { userSelect: 'none' },
                ]}
              >
                {row().line}
              </Text>
              <Text
                style={[
                  {
                    ...codeTextStyle,
                    flex: 1,
                    minWidth: 0,
                    color: C.text,
                  },
                  { userSelect: 'text' },
                ]}
              >
                {row().text.replace(/\r?\n$/, '')}
              </Text>
            </View>
          )}
        </List>
      </View>
    </View>
  );
}

function FileImage(props: {
  model: CurrentFileModel;
  view: Extract<FileView, { kind: 'image' }>;
  openImageViewer: OpenImageViewer;
}) {
  const error = createText();
  const dimensions = signal<{ width: number; height: number } | null>(null);
  const viewportHeight = signal(0);
  const footerHeight = signal(0);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  return (
    <Scroll
      onLayout={({ bounds: frame }) => viewportHeight.set(frame.size.height)}
      style={{ flex: 1, minHeight: 0 }}
    >
      <CapturedFileStatus model={props.model} />
      <View style={{ height: Math.max(0, viewportHeight() - footerHeight() - 8), marginBottom: 8 }}>
        <Image
          src={props.view.uri}
          onLoad={({ size: value }) => {
            if (mounted) dimensions.set(value);
          }}
          onError={(reason) => {
            if (mounted) error.set(reason.message);
          }}
          accessibilityLabel={tr('Captured workspace image')}
          style={[{ flex: 1, minHeight: 0, width: '100%' }, { objectFit: 'contain' }]}
        />
      </View>
      <View
        onLayout={({ bounds: frame }) => footerHeight.set(frame.size.height)}
        style={{ gap: 8 }}
      >
        <If when={dimensions()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
              {tr('{width} × {height} · Captured image', {
                width: dimensions()!.width,
                height: dimensions()!.height,
              })}
            </Text>
            <ImageViewerButton
              open={props.openImageViewer}
              image={{ uri: props.view.uri, ...dimensions()!, title: props.model.target.title }}
            />
          </View>
        </If>
        <If when={error()}>
          <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
            {error()}
          </Text>
          <Button
            disabled={props.model.state().kind === 'loading'}
            onPress={inputAction(props.model.refresh, null)}
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
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Retry image')}</Text>
          </Button>
        </If>
      </View>
    </Scroll>
  );
}
