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
import { renderText } from './text';
import { tr } from './locale';
import { inputAction, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { AttachmentPicker } from 'maka/host';
import type { AgentHistoryAttachment } from '../../../../packages/plugin-sdk/src/index.js';
import type { AttachmentDraft } from './attachmentDraft';
import type { Position } from './history';
import { ImageThumbnail, type ImagePreview } from './ImageThumbnail';
import { C, captionTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';

const image = (mime: string) =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime);
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const fileTileStyle = () =>
  ({
    width: 240,
    height: 64,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 8,
    backgroundColor: C.surface,
  }) as const;
const removeStyle = () =>
  ({
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: C.raised,
    borderWidth: 1,
    borderColor: C.line,
  }) as const;

export function DraftAttachments(props: {
  draft: AttachmentDraft;
  preview(image: ImagePreview): void;
}) {
  const owner = props.draft;
  return (
    <View style={{ gap: 8 }}>
      <If when={owner.picker()}>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button
            accessibilityLabel={tr('Close attachment picker')}
            onPress={inputAction(owner.open, { owner: owner.sessionId, value: false })}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={{ backgroundColor: C.line }}
            focusStyle={{ backgroundColor: C.line }}
          >
            <Icon name="close" color={C.secondary} />
            <Text style={{ color: C.secondary }}>{tr('Close picker')}</Text>
          </Button>
        </View>
      </If>
      {/* Keep this native owner mounted. Hiding only closes its private picker;
        the original selected path and in-flight resource retain their owner. */}
      <AttachmentPicker
        client={owner.client}
        pathLabel={tr('Attachment path')}
        pathPlaceholder={tr('Absolute file path…')}
        uploadLabel={tr('Upload selected file')}
        uploadingLabel={tr('Uploading…')}
        visible={owner.picker()}
        disabled={owner.restoring()}
        onStatus={owner.status}
      />
      <If when={owner.files().length > 0}>
        <Scroll horizontal accessibilityLabel={tr('Draft attachments')} style={{ flexShrink: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Each of={owner.files()} key={(file) => file.id}>
              {(file) => {
                const original = file();
                return (
                  <View style={{ flexShrink: 0 }}>
                    <If
                      when={image(original.mimeType)}
                      else={
                        <View
                          tooltip={textTooltip(() => `${original.name}\n${size(original.bytes)}`)}
                          style={fileTileStyle()}
                        >
                          <Icon name="file" color={C.secondary} />
                          <View style={{ flex: 1, minWidth: 0, paddingRight: 24, gap: 4 }}>
                            <Text
                              style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}
                            >
                              {original.name}
                            </Text>
                            <Text style={{ ...captionTextStyle, color: C.muted }}>
                              {size(original.bytes)}
                            </Text>
                          </View>
                        </View>
                      }
                    >
                      <ImageThumbnail
                        compact
                        source={{
                          kind: 'attachment-image',
                          read: {
                            sessionId: owner.sessionId,
                            source: { kind: 'uploaded', id: original.id },
                            offset: 0,
                          },
                        }}
                        label={tr('Open attachment {name}', { name: original.name })}
                        tooltip={`${original.name}\n${size(original.bytes)}`}
                        preview={props.preview}
                      />
                    </If>
                    <Button
                      accessibilityLabel={tr('Remove attachment {name}', { name: original.name })}
                      tooltip={textTooltip(() => tr('Remove {name}', { name: original.name }))}
                      onPress={inputAction(owner.remove, {
                        owner: owner.sessionId,
                        id: original.id,
                      })}
                      style={{
                        ...removeStyle(),
                        ...(image(original.mimeType) ? { right: undefined, left: 36 } : {}),
                      }}
                      hoverStyle={{ backgroundColor: C.line }}
                      focusStyle={{ borderColor: C.accent }}
                    >
                      <Icon name="close" color={C.secondary} />
                    </Button>
                  </View>
                );
              }}
            </Each>
          </View>
        </Scroll>
      </If>
      <Each of={owner.rows()} key={(row) => row.id}>
        {(row) => (
          <View style={{ backgroundColor: C.surface, borderRadius: 8, padding: 8, gap: 8 }}>
            <Text style={[{ color: C.text }, { userSelect: 'text' }]}>{row().name}</Text>
            <Text
              style={{
                color:
                  row().kind === 'failed'
                    ? C.danger
                    : row().kind === 'unknown'
                      ? C.warning
                      : C.muted,
              }}
            >
              {row().kind === 'reading'
                ? tr('Reading selected file…')
                : row().kind === 'uploading'
                  ? tr('Confirming upload…')
                  : row().kind === 'unknown'
                    ? tr('Original upload needs confirmation')
                    : tr('Upload failed')}
            </Text>
            <If when={row().error}>
              <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
                {renderText(row().error!)}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <If when={row().kind === 'unknown'}>
                <Button
                  disabled={owner.recovering() !== null}
                  accessibilityLabel={
                    row().original ? tr('Recover original upload') : tr('Check original upload')
                  }
                  onPress={inputAction(row().original ? owner.recover : owner.inspect, {
                    owner: owner.sessionId,
                    id: row().id,
                  })}
                  style={controlStyle}
                  hoverStyle={{ backgroundColor: C.line }}
                  focusStyle={{ backgroundColor: C.line }}
                >
                  <Text style={{ color: C.accent }}>
                    {row().original ? tr('Recover original upload') : tr('Check original upload')}
                  </Text>
                </Button>
                <If when={row().original && !row().original.reference}>
                  <Button
                    disabled={owner.recovering() !== null}
                    onPress={inputAction(owner.abandon, {
                      owner: owner.sessionId,
                      id: row().id,
                    })}
                    style={controlStyle}
                    hoverStyle={{ backgroundColor: C.line }}
                    focusStyle={{ backgroundColor: C.line }}
                  >
                    <Text style={{ color: C.warning }}>{tr('Abandon unconfirmed upload')}</Text>
                  </Button>
                </If>
              </If>
              <If when={row().kind === 'failed'}>
                <Button
                  accessibilityLabel={tr('Remove failed attachment {name}', { name: row().name })}
                  onPress={inputAction(owner.remove, {
                    owner: owner.sessionId,
                    id: row().id,
                  })}
                  style={controlStyle}
                  hoverStyle={{ backgroundColor: C.line }}
                  focusStyle={{ backgroundColor: C.line }}
                >
                  <Text style={{ color: C.muted }}>{tr('Remove')}</Text>
                </Button>
              </If>
            </View>
          </View>
        )}
      </Each>
      <If when={owner.notice()}>
        <Text style={{ ...captionTextStyle, color: C.warning }}>{owner.notice()}</Text>
      </If>
      <If when={owner.error()}>
        <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>{owner.error()}</Text>
        <Button
          onPress={inputAction(owner.retry, owner.sessionId)}
          style={controlStyle}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
        >
          <Text style={{ color: C.accent }}>{tr('Retry attachment updates')}</Text>
        </Button>
      </If>
    </View>
  );
}

export function HistoryAttachments(props: {
  sessionId: string;
  through: number;
  position?: Position;
  attachments: AgentHistoryAttachment[];
  preview(image: ImagePreview): void;
  userScroll(): void;
}) {
  return (
    <Scroll
      horizontal
      onScrollIntent={props.userScroll}
      accessibilityLabel={tr('Message attachments')}
      style={{ flexShrink: 0 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Each
          of={props.attachments.map((attachment, index) => ({ ...attachment, index }))}
          key={(attachment) => attachment.index}
        >
          {(attachment) => {
            const original = attachment();
            return (
              <If
                when={image(original.mimeType) && props.position !== undefined}
                else={
                  <View
                    tooltip={textTooltip(
                      () => `${original.name}\n${size(original.bytes)} · ${original.kind}`,
                    )}
                    style={fileTileStyle()}
                  >
                    <Icon name={image(original.mimeType) ? 'image' : 'file'} color={C.secondary} />
                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                      <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}>
                        {original.name}
                      </Text>
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {size(original.bytes)} · {original.kind}
                      </Text>
                    </View>
                  </View>
                }
              >
                <ImageThumbnail
                  compact
                  source={{
                    kind: 'attachment-image',
                    read: {
                      sessionId: props.sessionId,
                      offset: 0,
                      source: {
                        kind: 'history',
                        through: props.through,
                        position: { ...props.position! },
                        attachmentIndex: original.index,
                      },
                    },
                  }}
                  label={tr('Open attachment {name}', { name: original.name })}
                  tooltip={`${original.name}\n${size(original.bytes)} · ${original.kind}`}
                  preview={props.preview}
                />
              </If>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );
}
