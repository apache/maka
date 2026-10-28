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
import { createText, errorText, renderText, UiError, type UiText } from './text';
import { tr } from './locale';
import { cleanup, computed, inputAction, Scroll, signal, Text, View, Image, List } from 'nsh';
import { Button } from 'nsh/base';
import { Clipboard } from 'nsh';
import { host, type FileView } from './host';
import type { AgentFileChange } from '../../../../packages/plugin-sdk/src/index.js';
import type { WorkspaceFileTarget } from './workspaceFileState';
import { Icon } from './Icon';
import { ImageViewerButton, type OpenImageViewer } from './ImageViewer';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

type FileState =
  | FileView
  | { kind: 'idle' }
  | { kind: 'loading'; previous: FileView | null }
  | { kind: 'error'; message: UiText; previous: FileView | null };
export type CurrentFileModel = {
  target: WorkspaceFileTarget;
  state(): FileState;
  position: { x: number; y: number };
  stale(): boolean;
  activate(): void;
  suspend(): void;
  refresh(): void;
  dispose(): void;
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

export function createCurrentFile(target: WorkspaceFileTarget): CurrentFileModel {
  const state = signal<FileState>({ kind: 'idle' });
  const stale = signal(false);
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
      message: errorText(reason),
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
        // Native drains Begin/Chunk/End through successful completion and cleanup,
        // verifies bytes/digest, and returns an indexed capture or an image asset.
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
            message: errorText(reason),
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
      const opened: WatchSubscription = await host.subscribe('agent', 'watchFiles', {
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
        if (change.kind === 'unavailable')
          throw new UiError('The parent directory changed or is unavailable. Retry to reopen it.');
        if (change.kind === 'ready') {
          watch.ready = true;
          read(watch);
        } else {
          watch.changes += 1;
          stale.set(true);
        }
      }
    })().catch((reason) => failWatch(watch, reason));
  };
  const suspend = () => {
    active = false;
    stop();
    const previous = captured(state());
    if (state().kind === 'loading') state.set(previous ?? { kind: 'idle' });
    if (previous) stale.set(true);
  };
  const model: CurrentFileModel = {
    target,
    state,
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

export function CurrentFile(props: { model: CurrentFileModel; openImageViewer: OpenImageViewer }) {
  const model = props.model;
  const view = () => captured(model.state());
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
        await Clipboard.writeText(original.rows.originalText());
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
            message: errorText(reason),
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
    return value?.kind === 'image' || (value?.kind === 'text' && value.bytes > 0);
  };
  const emptyHeight = signal(0);
  const version = () => {
    const value = view();
    return value && 'version' in value ? value.version : '';
  };
  const error = () => {
    const value = model.state();
    return value.kind === 'error' ? renderText(value.message) : '';
  };
  const failed = () => model.state().kind === 'error';
  const notice = () => {
    const value = view();
    switch (value?.kind) {
      case 'text':
        return value.bytes === 0 ? tr('Empty file.') : '';
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
    if (model.state().kind === 'idle') return tr('File preview is inactive.');
    return notice();
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="file" color={C.muted} />
        <Text
          style={[
            { ...captionTextStyle, flex: 1, color: C.text, fontWeight: '500' },
            { numberOfLines: 1 },
          ]}
        >
          {model.target.title}
        </Text>
        <Button
          accessibilityLabel={tr('Copy captured file')}
          disabled={textCapture() === null}
          onPress={copyAction()}
          tooltip={textTooltip(() =>
            copying()
              ? tr('Copying captured file…')
              : copied()
                ? copied()!.failed
                  ? renderText(copied()!.message)
                  : tr('File copied')
                : tr('Copy captured file'),
          )}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon
            name={copied() && !copied()!.failed ? 'check' : 'copy'}
            color={copied()?.failed ? C.danger : C.secondary}
          />
        </Button>
        <Button
          disabled={model.state().kind === 'loading'}
          accessibilityLabel={tr('Refresh current file')}
          onPress={inputAction(model.refresh, null)}
          tooltip={textTooltip(() =>
            model.state().kind === 'error' ? tr('Retry current file') : tr('Refresh current file'),
          )}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="refresh" color={C.secondary} />
        </Button>
      </View>
      <If when={view()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: 8 }}>
          <If
            when={version()}
            else={
              <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
                {tr('Captured contents')}
              </Text>
            }
          >
            <Text
              accessibilityLabel={tr('Captured version {version}', { version: version() })}
              tooltip={textTooltip(() => tr('Captured version {version}', { version: version() }))}
              style={[
                { ...captionTextStyle, flex: 1, minWidth: 0, color: C.muted },
                { userSelect: 'text', numberOfLines: 1 },
              ]}
            >
              {tr('Captured version {version}', { version: version() })}
            </Text>
          </If>
          <If when={copied()}>
            <Text
              accessibilityLabel={
                copied()!.failed ? renderText(copied()!.message) : tr('File copied')
              }
              tooltip={textTooltip(() =>
                copied()!.failed ? renderText(copied()!.message) : tr('File copied'),
              )}
              style={{
                ...captionTextStyle,
                flexShrink: 0,
                color: copied()!.failed ? C.danger : C.muted,
              }}
            >
              {copied()!.failed ? tr('Copy failed') : tr('File copied')}
            </Text>
          </If>
        </View>
      </If>
      <If when={!readable()}>
        <Scroll
          accessibilityLabel={tr('File preview status')}
          onLayout={(frame) => emptyHeight.set(frame.size.height)}
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
                  backgroundColor: C.surface,
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
            <If when={model.stale()}>
              <Text
                style={{ ...bodyTextStyle, width: '100%', color: C.warning, textAlign: 'center' }}
              >
                {tr('The workspace may have changed. Refresh for current contents.')}
              </Text>
            </If>
            <If when={failed() || view()?.kind === 'changed'}>
              <RetryCurrentFile model={model} />
            </If>
          </View>
        </Scroll>
      </If>
      <Each of={readable() ? [view()!] : []} key={(value) => value}>
        {(value) => {
          const snapshot = value();
          if (snapshot.kind === 'text') return <FileRows model={model} view={snapshot} />;
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
        backgroundColor: C.surface,
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
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
      <View style={{ padding: 8, gap: 8, alignItems: 'flex-start' }}>
        <If when={model.stale()}>
          <Text style={[{ ...bodyTextStyle, color: C.warning }, { userSelect: 'none' }]}>
            {tr('The workspace may have changed. Refresh for current contents.')}
          </Text>
        </If>
        <If when={model.state().kind === 'loading'}>
          <Text style={[{ ...bodyTextStyle, color: C.muted }, { userSelect: 'none' }]}>
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

function FileRows(props: { model: CurrentFileModel; view: Extract<FileView, { kind: 'text' }> }) {
  const initialOffset = { ...props.model.position };
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  return (
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
        style={{ flex: 1, minHeight: 0, backgroundColor: C.surface }}
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
              {/* Soft-wrapped visual lines retain their original source line number. */}
              {row().text.replace(/\r?\n$/, '')}
            </Text>
          </View>
        )}
      </List>
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
      onLayout={(frame) => viewportHeight.set(frame.size.height)}
      style={{ flex: 1, minHeight: 0 }}
    >
      <CapturedFileStatus model={props.model} />
      <View style={{ height: Math.max(0, viewportHeight() - footerHeight() - 8), marginBottom: 8 }}>
        <Image
          src={props.view.uri}
          onLoad={(value) => {
            if (mounted) dimensions.set(value);
          }}
          onError={(reason) => {
            if (mounted) error.set(reason.message);
          }}
          accessibilityLabel={tr('Captured workspace image')}
          style={[{ flex: 1, minHeight: 0, width: '100%' }, { objectFit: 'contain' }]}
        />
      </View>
      <View onLayout={(frame) => footerHeight.set(frame.size.height)} style={{ gap: 8 }}>
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
