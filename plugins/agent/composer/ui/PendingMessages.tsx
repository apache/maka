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

import { inputAction, List, Text, View, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { LoadingIndicator } from '../../../../products/maka/workbench/app/Loading';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';

export function PendingMessages(props: { session: ComposerSession }) {
  const session = props.session;
  return (
    <If when={session.sends().length > 0}>
      <List
        accessibilityLabel={tr('Outgoing messages')}
        each={session.sends()}
        keyExtractor={(item) => item.id}
        estimatedItemSize={96}
        style={{
          height: Math.min(session.sends().length * 96, windowSize().height / 3),
          minHeight: 0,
          flexShrink: 1,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
          backgroundColor: C.surface,
        }}
      >
        {(item) => (
          <View style={{ padding: 12, gap: 6 }}>
            <If when={item().text !== ''}>
              <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
                {item().text}
              </Text>
            </If>
            <If when={item().attachments.length > 0}>
              <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
                {item()
                  .attachments.map((file) => file.name)
                  .join(', ')}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <If when={item().busy}>
                <LoadingIndicator color={C.muted} />
              </If>
              <Text
                style={{
                  ...captionTextStyle,
                  flex: 1,
                  color: item().state === 'failed' ? C.warning : C.muted,
                }}
              >
                {item().detail}
              </Text>
              <If when={item().retryable}>
                <Button
                  accessibilityLabel={tr('Retry message')}
                  onPress={inputAction(session.retrySend, item().id)}
                  disabled={!session.connected() || item().busy}
                  style={controlStyle}
                  hoverStyle={{ backgroundColor: C.raised }}
                  focusStyle={controlFocusStyle()}
                >
                  <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
                </Button>
              </If>
              <If when={item().state === 'unknown'}>
                <Button
                  accessibilityLabel={tr('Check message status')}
                  onPress={inputAction(session.checkSend, item().id)}
                  disabled={!session.connected() || item().busy}
                  style={controlStyle}
                  hoverStyle={{ backgroundColor: C.raised }}
                  focusStyle={controlFocusStyle()}
                >
                  <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Check status')}</Text>
                </Button>
              </If>
              <If when={!item().busy}>
                <Button
                  accessibilityLabel={tr('Dismiss message status')}
                  tooltip={textTooltip(() => tr('Dismiss message status'))}
                  onPress={inputAction(session.dismissSend, item().id)}
                  style={{
                    width: 32,
                    height: 32,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 16,
                  }}
                  hoverStyle={{ backgroundColor: C.raised }}
                  focusStyle={controlFocusStyle()}
                >
                  <Icon name="close" color={C.muted} />
                </Button>
              </If>
            </View>
          </View>
        )}
      </List>
    </If>
  );
}
