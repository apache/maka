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

import { fontScale, Image, Scroll, Text, View, token } from 'nsh';
import { Button, MenuButton, type MenuButtonItem } from 'nsh/base';
import { formatCount, tr } from '../../locale';
import {
  type AttachmentComposer,
  type AttachmentInfo,
  type DraftAttachment,
  type PickerKind,
} from '../../state/attachments';
import { spacing, type } from '../../theme/tokens';
import { glassSurfaceStyle, Icon } from '../../ui';

const attachmentStripHeight = 56;
const attachmentStripGap = 8;

export function attachmentStripReserve() {
  const textHeight = fontScale() * (type.footnote.lineHeight + type.caption.lineHeight);
  return Math.max(attachmentStripHeight, textHeight + 2 * spacing.hairline) + attachmentStripGap;
}

function sizeLabel(bytes: number) {
  const rounded = (unit: number) => formatCount(Math.round((bytes / unit) * 10) / 10);
  if (bytes >= 1024 ** 2) return tr('{size} MiB', { size: rounded(1024 ** 2) });
  if (bytes >= 1024) return tr('{size} KiB', { size: rounded(1024) });
  return tr('{size} B', { size: formatCount(bytes) });
}

function status(item: DraftAttachment): string {
  if (item.kind === 'ready') return tr('Uploaded');
  if (item.kind === 'uploading') {
    switch (item.phase) {
      case 'confirming':
        return tr('Confirming upload…');
      case 'uploading':
        return tr('Uploading…');
      case 'waiting':
        return tr('Waiting to upload');
    }
  }
  switch (item.reason) {
    case 'unconfirmed':
      return tr('Could not confirm upload');
    case 'invalid_file':
      return tr('Invalid file');
    case 'closed':
      return tr('Upload closed');
    case 'archived':
      return tr('Conversation archived');
    case 'not_submitted':
      return tr('Upload did not start');
  }
}

export function attachmentPickerItems(disabled: boolean): MenuButtonItem[] {
  return [
    { id: 'photos', label: tr('Photo Library'), icon: 'photo.on.rectangle', disabled },
    { id: 'files', label: tr('Choose Files'), icon: 'doc', disabled },
  ];
}

export function AttachmentMenu(props: { composer: AttachmentComposer; failed: boolean }) {
  return (
    <MenuButton
      testID="chat-add-attachments"
      accessibilityLabel={tr('Add attachments')}
      items={attachmentPickerItems(!props.composer.canPick())}
      onSelect={({ id }) => void props.composer.pick(id as PickerKind)}
      activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
      style={{
        ...glassSurfaceStyle(22),
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AttachmentMenuGlyph failed={props.failed} />
    </MenuButton>
  );
}

export function AttachmentMenuGlyph(props: { compact?: boolean; failed?: boolean }) {
  return (
    <Icon
      name={props.compact ? (props.failed ? 'warning' : 'more') : 'plus'}
      size={20}
      color={token(props.failed ? 'glass-destructive' : 'glass-foreground')}
    />
  );
}

function AttachmentGlyph(props: { mimeType: string; failed?: boolean }) {
  return (
    <Icon
      name={props.failed ? 'warning' : props.mimeType.startsWith('image/') ? 'photo' : 'file'}
      color={token(props.failed ? 'glass-destructive' : 'glass-foreground')}
      size={18}
    />
  );
}

function AttachmentRow(props: {
  item: DraftAttachment;
  composer: AttachmentComposer;
  sheet?: boolean;
}) {
  const item = () => props.item;
  const label = () => item().info.name;
  const size = () => sizeLabel(item().info.bytes);
  const detail = () => status(item());
  const preview = () => (item().info.mimeType.startsWith('image/') ? item().local?.url : undefined);
  const action = () => {
    const entry = item();
    return entry.kind === 'failed' && entry.action !== 'remove' ? entry.action : null;
  };
  const buttonStyle = {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 4,
  } as const;
  return (
    <View
      testID="chat-draft-attachment"
      style={{
        ...glassSurfaceStyle(16),
        width: props.sheet ? '100%' : 292,
        minHeight: attachmentStripHeight,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 6,
        gap: 6,
      }}
    >
      <If
        when={preview()}
        else={<AttachmentGlyph mimeType={item().info.mimeType} failed={item().kind === 'failed'} />}
      >
        {(url) => (
          <Image
            src={url()}
            style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }}
          />
        )}
      </If>
      <View
        role="text"
        accessibilityLabel={tr('{name}, {size}, {status}', {
          name: label(),
          size: size(),
          status: detail(),
        })}
        style={{ flex: 1, minWidth: 0 }}
      >
        <Text
          style={{
            ...type.footnote,
            color: token('glass-foreground'),
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {label()}
        </Text>
        <Text style={{ ...type.caption, color: token('glass-foreground'), numberOfLines: 1 }}>
          {size()} · {detail()}
        </Text>
      </View>
      <If when={action()}>
        {(action) => (
          <Button
            accessibilityLabel={tr(
              action() === 'retry' ? 'Retry upload of {name}' : 'Choose a replacement for {name}',
              { name: label() },
            )}
            onPress={() => props.composer.recover(item().key)}
            style={{ ...buttonStyle, maxWidth: 104 }}
            activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
          >
            <Text style={{ ...type.caption, color: token('glass-foreground') }}>
              {action() === 'retry' ? tr('Retry') : tr('Choose again')}
            </Text>
          </Button>
        )}
      </If>
      <Button
        accessibilityLabel={tr('Remove {name}', { name: label() })}
        onPress={() => props.composer.remove(item().key)}
        hitSlop={5}
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
      >
        <Icon name="close" color={token('glass-muted')} size={14} />
      </Button>
    </View>
  );
}

export function AttachmentStrip(props: { composer: AttachmentComposer; sheet?: boolean }) {
  const rows = () => (
    <Each of={props.composer.items()} key={(item) => item.key}>
      {(item) => <AttachmentRow item={item()} composer={props.composer} sheet={props.sheet} />}
    </Each>
  );
  return (
    <If
      when={props.sheet}
      else={
        <Scroll
          testID="chat-attachment-strip"
          horizontal
          scrollbar={false}
          keyboardShouldPersistTaps="handled"
          style={{
            minHeight: attachmentStripHeight,
            flexGrow: 0,
            marginBottom: attachmentStripGap,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 8 }}>{rows()}</View>
        </Scroll>
      }
    >
      <View style={{ gap: 8 }}>{rows()}</View>
    </If>
  );
}

export function HistoryAttachments(props: { items: readonly AttachmentInfo[] }) {
  return (
    <If when={props.items.length}>
      <View style={{ gap: 4 }}>
        <Each of={props.items}>
          {(item) => (
            <View
              testID="chat-history-attachment"
              role="text"
              accessibilityLabel={tr('{name}, {size}', {
                name: item().name,
                size: sizeLabel(item().bytes),
              })}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'flex-start',
                maxWidth: '100%',
                gap: 6,
                backgroundColor: token('inline-card'),
                borderRadius: 8,
                padding: 6,
              }}
            >
              <AttachmentGlyph mimeType={item().mimeType} />
              <Text
                style={{
                  ...type.footnote,
                  color: token('glass-foreground'),
                  flexShrink: 1,
                  numberOfLines: 1,
                  textOverflow: 'ellipsis',
                }}
              >
                {item().name}
              </Text>
              <Text style={{ ...type.caption, color: token('glass-muted') }}>
                {sizeLabel(item().bytes)}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
