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
import { tr } from './locale';
import { cleanup, effect, inputAction, Scroll, signal, Text, View, List } from 'nsh';
import { Button } from 'nsh/base';
import { host } from './host';
import type { WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';
import type { WorkspaceFilesModel } from './workspaceFileState';

export function WorkspaceFiles(props: { model: WorkspaceFilesModel }) {
  const model = props.model;
  const viewportHeight = signal(0);
  effect(() => {
    if (
      model.active() &&
      !model.loading() &&
      !model.error() &&
      model.entries().length < Math.ceil(viewportHeight() / 32)
    )
      void model.loadMore();
  });
  const label = (path: WorkspacePath) => {
    const text: string = host.pathLabel(path);
    return text.split('/').at(-1) ?? text;
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Scroll horizontal style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Each of={model.breadcrumbs()} key={(directory) => directory.path?.bytesBase64 ?? ''}>
              {(directory, index) => (
                <Button
                  disabled={!model.active()}
                  accessibilityLabel={tr('Open {name}', { name: directory().title })}
                  onPress={inputAction(model.navigate, {
                    sessionId: model.sessionId()!,
                    path: directory().path,
                  })}
                  style={{
                    ...controlStyle,
                    paddingHorizontal: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <Icon name={index() ? 'right' : 'folder'} color={C.muted} />
                  <Text
                    numberOfLines={1}
                    style={{
                      ...captionTextStyle,
                      color: index() === model.breadcrumbs().length - 1 ? C.text : C.accent,
                    }}
                  >
                    {directory().path ? label(directory().path!) : directory().title}
                  </Text>
                </Button>
              )}
            </Each>
          </View>
        </Scroll>
        <Button
          disabled={!model.active() || model.busy()}
          accessibilityLabel={tr('Refresh workspace files')}
          onPress={inputAction(model.refresh, null)}
          tooltip={textTooltip(() => tr('Refresh workspace files'))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="refresh" color={C.secondary} />
        </Button>
      </View>
      <Each
        of={[
          JSON.stringify([
            model.sessionId(),
            model.breadcrumbs().at(-1)?.path?.bytesBase64 ?? null,
          ]),
        ]}
        key={(key: string) => key}
      >
        {() => {
          const sessionId = model.sessionId();
          const directory = model.breadcrumbs().at(-1)!.path;
          const initialOffset = { ...model.position };
          let mounted = true;
          cleanup(() => {
            mounted = false;
          });
          const ownsView = () =>
            mounted &&
            model.active() &&
            model.sessionId() === sessionId &&
            model.breadcrumbs().at(-1)?.path?.bytesBase64 === directory?.bytesBase64;
          return (
            <List
              each={model.entries()}
              keyExtractor={(entry) => entry.path.bytesBase64}
              estimatedItemSize={32}
              contentOffset={initialOffset}
              onScroll={(event) => {
                if (ownsView()) {
                  model.position.x = event.offset.x;
                  model.position.y = event.offset.y;
                }
              }}
              onLayout={(frame) => {
                if (ownsView()) viewportHeight.set(frame.size.height);
              }}
              onLoadMore={() => {
                if (ownsView()) void model.loadMore();
              }}
              accessibilityLabel={tr('Workspace files')}
              style={{ flex: 1, minHeight: 32 }}
              empty={<DirectoryStatus model={model} />}
              footer={model.entries().length ? <DirectoryStatus model={model} /> : undefined}
            >
              {(entry) => (
                <Button
                  disabled={
                    !model.active() ||
                    !!model.error() ||
                    (entry().kind !== 'directory' && entry().kind !== 'file')
                  }
                  accessibilityLabel={`${entry().kind === 'directory' ? tr('Folder') : entry().kind === 'file' ? tr('File') : entry().kind === 'symlink' ? tr('Symbolic link') : tr('Unsupported')}: ${label(entry().path)}`}
                  onPress={inputAction(model.activate, {
                    sessionId: sessionId!,
                    parent: directory,
                    entry: entry(),
                  })}
                  style={{
                    ...controlStyle,
                    height: 32,
                    paddingHorizontal: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                  activeStyle={{ backgroundColor: C.line }}
                >
                  <Icon name={entry().kind === 'directory' ? 'folder' : 'file'} color={C.muted} />
                  <Text
                    numberOfLines={1}
                    style={{
                      ...captionTextStyle,
                      flex: 1,
                      color:
                        entry().kind === 'file' || entry().kind === 'directory' ? C.text : C.muted,
                    }}
                  >
                    {label(entry().path)}
                  </Text>
                  <If when={entry().kind === 'symlink' || entry().kind === 'other'}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {entry().kind === 'symlink' ? tr('Link') : tr('Unsupported')}
                    </Text>
                  </If>
                </Button>
              )}
            </List>
          );
        }}
      </Each>
    </View>
  );
}

function DirectoryStatus(props: { model: WorkspaceFilesModel }) {
  const model = props.model;
  const message = () => {
    if (model.error()) return model.error();
    if (!model.sessionId()) return tr('Select a conversation to browse its workspace.');
    if (model.loading() || (model.busy() && !model.entries().length)) return tr('Loading files…');
    if (model.busy()) return tr('Updating files…');
    return model.entries().length ? '' : tr('This directory is empty.');
  };
  return (
    <If when={message()}>
      <View style={{ padding: 8, gap: 8, alignItems: 'flex-start' }}>
        <Text
          selectable={!!model.error()}
          style={{ ...bodyTextStyle, color: model.error() ? C.danger : C.muted }}
        >
          {message()}
        </Text>
        <If when={model.error()}>
          <Button
            accessibilityLabel={tr('Retry workspace files')}
            disabled={!model.active() || model.busy()}
            onPress={inputAction(model.refresh, null)}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: C.surface,
            }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="refresh" color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Retry')}</Text>
          </Button>
        </If>
      </View>
    </If>
  );
}
