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

import { Clipboard, signal, computed, Text, View, type JSX } from 'nsh';
import { formatDuration } from './duration';
import { tr, messageDateTime, messageTime } from './locale';
import { createTransientText, errorText, message as uiMessage } from './text';
import type { replyMetrics } from './replyDetails';
import { C, IconButton, captionTextStyle, textTooltip } from './ui';

// The 16 pt copy glyph is centered in a 24 pt target and inset within its icon.
export const compactCopyInset = -3;

export function CompactReplyFooter(props: {
  copy: JSX.Element;
  at?: number;
  metrics(): ReturnType<typeof replyMetrics>;
}) {
  const details = computed(() => {
    const { elapsed, name } = props.metrics();
    return [
      props.at != null && Number.isFinite(props.at) ? messageTime(props.at) : '',
      elapsed == null ? '' : formatDuration(elapsed, 'tenths'),
      name,
    ]
      .filter(Boolean)
      .join(' · ');
  });
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 24,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {props.copy}
      <If when={details()}>
        <Text
          tooltip={textTooltip(() =>
            props.at != null && Number.isFinite(props.at) ? messageDateTime(props.at) : undefined,
          )}
          style={{ ...captionTextStyle, color: C.muted, flexShrink: 1 }}
        >
          {details()}
        </Text>
      </If>
    </View>
  );
}

export function LocalMessageCopy(props: { text(): string; user?: boolean }) {
  const notice = createTransientText();
  const failed = signal(false);
  const copy = async () => {
    try {
      await Clipboard.writeText(props.text());
      failed.set(false);
      notice.set(uiMessage('Message copied'));
    } catch (reason) {
      failed.set(true);
      notice.set(errorText(reason, 'Could not copy to the clipboard.'));
    }
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <IconButton
        compact
        label={props.user ? tr('Copy user message') : tr('Copy message')}
        icon={notice() && !failed() ? 'check' : 'copy'}
        onPress={() => void copy()}
      />
      <If when={notice() && failed()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{notice()}</Text>
      </If>
    </View>
  );
}
