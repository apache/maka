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
import { cleanup, effect, inputAction, Scroll, signal, Text, View, Image } from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import { keymap } from 'nsh';
import { Terminal } from './Terminal';
import { Terminals } from './Terminals';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspaceChanges } from './WorkspaceChanges';
import { CurrentDiff } from './CurrentDiff';
import { CurrentFile } from './CurrentFile';
import type { Resources } from './resources';
import type { ImagePreview } from './ImageThumbnail';
import { Icon } from './Icon';
import { ImageViewerButton, type OpenImageViewer } from './ImageViewer';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
} from './ui';

export function ResourcePane(props: { resources: Resources; docked: boolean }) {
  const resources = props.resources;
  const closeTarget = {
    sessionId: resources.sessionId()!,
    instance: resources.instance(),
  };
  let control: YNode | undefined;
  let unbind = () => {};
  cleanup(() => unbind());
  // Consume only a user-requested focus transfer; a resize/remount alone must
  // leave native dialog restoration and the resident composer caret intact.
  effect(() => {
    if (resources.focusRequest() && control) {
      resources.focusHandled();
      if (props.docked) control.focus();
    }
  });
  return (
    <View
      ref={(node) => {
        resources.attach(node);
        unbind();
        unbind = keymap.bind('escape', () => resources.close(closeTarget), {
          when: 'always',
          within: node,
        });
      }}
      style={{ flex: 1, minHeight: 0, backgroundColor: C.background, padding: 8, gap: 8 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, gap: 4 }}>
        <Scroll horizontal focusable={false} style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Button
              accessibilityLabel={tr('Browse files')}
              selected={resources.active() === 'files'}
              ref={(node) => {
                control = node;
                if (resources.focusRequest()) {
                  resources.focusHandled();
                  if (props.docked) node.focus();
                }
              }}
              onPress={inputAction(resources.inventory, {
                sessionId: resources.sessionId()!,
                kind: 'files',
              })}
              style={{ ...controlStyle, paddingHorizontal: 8 }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: resources.active() === 'files' ? C.text : C.muted,
                }}
              >
                {tr('Files')}
              </Text>
            </Button>
            <Button
              accessibilityLabel={tr('Browse current changes')}
              selected={resources.active() === 'changes'}
              onPress={inputAction(resources.inventory, {
                sessionId: resources.sessionId()!,
                kind: 'changes',
              })}
              style={{ ...controlStyle, paddingHorizontal: 8 }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: resources.active() === 'changes' ? C.text : C.muted,
                }}
              >
                {tr('Changes')}
              </Text>
            </Button>
            <Button
              accessibilityLabel={tr('Show conversation terminals')}
              selected={resources.active() === 'terminals'}
              onPress={inputAction(resources.inventory, {
                sessionId: resources.sessionId()!,
                kind: 'terminals',
              })}
              style={{
                ...controlStyle,
                paddingHorizontal: 8,
              }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: resources.active() === 'terminals' ? C.text : C.muted,
                }}
              >
                {tr('Terminal')}
              </Text>
            </Button>
            <Each of={resources.tabs()} key={(tab) => tab.instance}>
              {(tab) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 8,
                    backgroundColor: resources.active() === tab().instance ? C.raised : C.surface,
                  }}
                >
                  <Button
                    selected={resources.active() === tab().instance}
                    onPress={inputAction(resources.select, {
                      sessionId: tab().sessionId,
                      instance: tab().instance,
                    })}
                    accessibilityLabel={tr('Preview {name}', { name: tab().title })}
                    tooltip={textTooltip(() => tab().title)}
                    style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                  >
                    <Icon
                      name={
                        tab().kind === 'terminal'
                          ? 'terminal'
                          : tab().kind === 'diff'
                            ? 'code'
                            : tab().kind === 'image'
                              ? 'image'
                              : 'file'
                      }
                      color={C.muted}
                    />
                    <Text
                      numberOfLines={1}
                      style={{
                        ...captionTextStyle,
                        color: resources.active() === tab().instance ? C.text : C.muted,
                        maxWidth: 160,
                      }}
                    >
                      {tab().title}
                    </Text>
                  </Button>
                  <Button
                    onPress={inputAction(resources.closeTab, {
                      sessionId: tab().sessionId,
                      instance: tab().instance,
                    })}
                    accessibilityLabel={tr('Close {name}', { name: tab().title })}
                    tooltip={textTooltip(() => tr('Close {name}', { name: tab().title }))}
                    style={{
                      ...controlStyle,
                      width: 28,
                      minHeight: 28,
                      paddingHorizontal: 5,
                      paddingVertical: 5,
                      alignItems: 'center',
                    }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                  >
                    <Icon name="close" color={C.muted} />
                  </Button>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
        <Button
          accessibilityLabel={tr('Close workspace preview')}
          onPress={inputAction(resources.close, closeTarget)}
          tooltip={textTooltip(() => tr('Close workspace preview · Esc'))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="close" color={C.muted} />
        </Button>
      </View>
      <If when={resources.active() === 'terminals'}>
        <Terminals model={resources.terminals} sessionId={resources.sessionId()!} />
      </If>
      <If when={resources.active() === 'files'}>
        <WorkspaceFiles model={resources.files} />
      </If>
      <If when={resources.active() === 'changes' && resources.sessionId()}>
        <WorkspaceChanges sessionId={resources.sessionId()!} openDiff={resources.openDiff} />
      </If>
      <Each of={resources.activeTab() ? [resources.activeTab()!] : []} key={(tab) => tab.instance}>
        {(tab) => {
          const current = tab();
          const openImageViewer: OpenImageViewer = (image, restoreFocus) =>
            resources.openImageViewer(
              { sessionId: current.sessionId, instance: current.instance, image },
              restoreFocus,
            );
          if (current.kind === 'file')
            return <CurrentFile model={current.model} openImageViewer={openImageViewer} />;
          if (current.kind === 'diff') return <CurrentDiff model={current.model} />;
          if (current.kind === 'terminal') return <Terminal model={current.model} />;
          return <OriginalImage image={current.image} openImageViewer={openImageViewer} />;
        }}
      </Each>
    </View>
  );
}

function OriginalImage(props: { image: ImagePreview; openImageViewer: OpenImageViewer }) {
  const error = signal('');
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '500' }}>
        {tr('Image preview')}
      </Text>
      <Image
        src={props.image.uri}
        resizeMode="contain"
        onError={(reason) => {
          if (mounted) error.set(reason.message);
        }}
        style={{ flex: 1, minHeight: 0, width: '100%' }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
          {props.image.width} × {props.image.height} · {tr('Original image')}
        </Text>
        <ImageViewerButton
          open={props.openImageViewer}
          image={{
            uri: props.image.uri,
            width: props.image.width,
            height: props.image.height,
            title: tr('Original image'),
          }}
        />
      </View>
      <If when={error()}>
        <Text style={{ ...bodyTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}
