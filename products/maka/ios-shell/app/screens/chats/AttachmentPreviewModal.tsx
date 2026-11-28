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

import { Image, reduceMotion, Scroll, signal, Text, View, token } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { tr } from '../../locale';
import type { AttachmentPreview } from '../../state/attachmentPreview';
import { spacing, type } from '../../theme/tokens';
import { glassSurfaceStyle, Icon } from '../../ui';
import { sizeLabel } from './AttachmentStrip';

function previewGlass() {
  return {
    ...glassSurfaceStyle(22),
    backgroundColor: token('image-viewer-glass'),
    borderColor: token('image-viewer-border'),
  };
}

export function AttachmentPreviewModal(props: {
  preview: AttachmentPreview;
  onRemove?: () => void;
}) {
  return (
    <Dialog
      presentation="fullScreen"
      animation={reduceMotion() ? 'none' : 'fade'}
      accessibilityLabel={tr('Image preview')}
      statusBar={{ foreground: 'light' }}
      onOpenChange={({ open }) => {
        if (!open) props.preview.close();
      }}
      style={{ flex: 1, backgroundColor: token('image-viewer-bg') }}
    >
      <PreviewBody preview={props.preview} onRemove={props.onRemove} />
    </Dialog>
  );
}

function PreviewBody(props: { preview: AttachmentPreview; onRemove?: () => void }) {
  const info = () => props.preview.state()?.request.info;
  const imageUrl = () => {
    const state = props.preview.state();
    return state?.kind === 'ready' ? state.url : null;
  };
  const size = signal({ width: 0, height: 0 });
  return (
    <View
      testID="chat-image-preview-body"
      style={{
        flex: 1,
        paddingTop: 'calc(env(safe-area-inset-top) + 8px)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
        <View
          style={{
            ...previewGlass(),
            flex: 1,
            minWidth: 0,
            minHeight: spacing.rowMinHeight,
            justifyContent: 'center',
            paddingHorizontal: 14,
            paddingVertical: 4,
          }}
        >
          <Text
            style={{
              ...type.subheadlineMedium,
              color: token('image-viewer-foreground'),
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {info()?.name}
          </Text>
          <Text style={{ ...type.caption, color: token('image-viewer-muted') }}>
            {sizeLabel(info()?.bytes ?? 0)}
          </Text>
        </View>
        <If when={props.onRemove}>
          <PreviewButton
            name="trash"
            label={tr('Remove {name}', { name: info()?.name ?? '' })}
            onPress={() => props.onRemove?.()}
          />
        </If>
        <PreviewButton
          name="close"
          label={tr('Close image preview')}
          onPress={props.preview.close}
        />
      </View>
      <View style={{ flex: 1 }} onLayout={({ bounds }) => size.set(bounds.size)}>
        <If
          when={size().width > 0 && size().height > 0 ? imageUrl() : null}
          else={
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: 16,
              }}
            >
              <If
                when={props.preview.state()?.kind === 'failed'}
                else={
                  <View role="progressbar" accessibilityLabel={tr('Loading image…')}>
                    <Text style={{ ...type.footnote, color: token('image-viewer-muted') }}>
                      {tr('Loading image…')}
                    </Text>
                  </View>
                }
              >
                <Text
                  style={{
                    ...type.body,
                    color: token('image-viewer-foreground'),
                    textAlign: 'center',
                  }}
                >
                  {tr('Could not load image')}
                </Text>
                <Button
                  accessibilityLabel={tr('Retry')}
                  onPress={props.preview.retry}
                  activeStyle={{ backgroundColor: token('image-viewer-pressed') }}
                  style={{
                    ...previewGlass(),
                    minHeight: spacing.rowMinHeight,
                    justifyContent: 'center',
                    paddingHorizontal: 16,
                  }}
                >
                  <Text
                    style={{ ...type.subheadlineMedium, color: token('image-viewer-foreground') }}
                  >
                    {tr('Retry')}
                  </Text>
                </Button>
              </If>
            </View>
          }
        >
          {(url) => (
            <Each of={[url()]} key={(url) => url}>
              {(image) => (
                <Scroll
                  testID="chat-image-preview-zoom"
                  minimumZoomScale={1}
                  maximumZoomScale={4}
                  centerContent
                  bounces={false}
                  scrollbar={false}
                  style={{ flex: 1 }}
                >
                  <Image
                    testID="chat-image-preview"
                    src={image()}
                    accessibilityLabel={info()?.name}
                    style={{ width: size().width, height: size().height, objectFit: 'contain' }}
                    onError={({ message }) => props.preview.imageFailed(image(), message)}
                  />
                </Scroll>
              )}
            </Each>
          )}
        </If>
      </View>
    </View>
  );
}

function PreviewButton(props: { name: 'close' | 'trash'; label: string; onPress: () => void }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      activeStyle={{ backgroundColor: token('image-viewer-pressed') }}
      style={{
        ...previewGlass(),
        width: spacing.rowMinHeight,
        height: spacing.rowMinHeight,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name={props.name}
        size={19}
        color={token(
          props.name === 'trash' ? 'image-viewer-destructive' : 'image-viewer-foreground',
        )}
      />
    </Button>
  );
}
