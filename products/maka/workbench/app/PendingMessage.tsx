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

import { inputAction, platform, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type {
  ComposerSendStatus,
  ComposerSession,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  textTooltip,
} from './ui';

export function PendingMessage(props: {
  session: Pick<ComposerSession, 'connected' | 'retrySend' | 'checkSend' | 'dismissSend'>;
  message: ComposerSendStatus;
}) {
  const session = props.session;
  return (
    <View style={{ padding: platform.isTerminal ? 16 : 12, gap: platform.isTerminal ? 8 : 6 }}>
      <If when={props.message.text !== ''}>
        <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
          {props.message.text}
        </Text>
      </If>
      <If when={props.message.attachments.length > 0}>
        <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
          {props.message.attachments.map((file) => file.name).join(', ')}
        </Text>
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <If when={props.message.busy}>
          <LoadingIndicator color={C.muted} />
        </If>
        <Text
          style={{
            ...captionTextStyle,
            flex: 1,
            color:
              props.message.state === 'failed' || props.message.state === 'unknown'
                ? C.warning
                : C.muted,
          }}
        >
          {props.message.detail}
        </Text>
        <If when={props.message.retryable}>
          <Button
            accessibilityLabel={tr('Retry message')}
            onPress={inputAction(session.retrySend, props.message.id)}
            disabled={!session.connected() || props.message.busy}
            style={controlStyle}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
          </Button>
        </If>
        <If when={props.message.state === 'unknown'}>
          <Button
            accessibilityLabel={tr('Check message status')}
            onPress={inputAction(session.checkSend, props.message.id)}
            disabled={!session.connected() || props.message.busy}
            style={controlStyle}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Check status')}</Text>
          </Button>
        </If>
        <If when={!props.message.busy}>
          <Button
            accessibilityLabel={tr('Dismiss message status')}
            tooltip={textTooltip(() => tr('Dismiss message status'))}
            onPress={inputAction(session.dismissSend, props.message.id)}
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
  );
}
