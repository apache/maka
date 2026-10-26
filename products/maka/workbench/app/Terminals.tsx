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

import { tr } from './locale';
import { inputAction, Text, View, List } from 'nsh';
import { Button } from 'nsh/base';
import { terminalStatus, type TerminalsModel } from './terminalState';
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

export function Terminals(props: { model: TerminalsModel; sessionId: string }) {
  const model = props.model;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Button
          onPress={inputAction(model.start, null)}
          disabled={model.starting() || !model.known() || !!model.pending().length}
          accessibilityLabel={tr('Start interactive terminal')}
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
          <Icon name="plus" color={C.secondary} />
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {model.starting() ? tr('Starting shell…') : tr('New terminal')}
          </Text>
        </Button>
        <Button
          onPress={inputAction(model.refresh, null)}
          accessibilityLabel={tr('Refresh terminals')}
          tooltip={tr('Refresh terminals')}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="refresh" color={C.secondary} />
        </Button>
      </View>
      <If when={model.error()}>
        <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
          {model.error()}
        </Text>
      </If>
      <Each of={model.pending()} key={(operation) => operation.id}>
        {(operation) => (
          <View style={{ gap: 8, padding: 12, borderRadius: 8, backgroundColor: C.surface }}>
            <Text style={{ ...bodyTextStyle, color: C.warning }}>
              {tr('Unresolved {method} · input has not been repeated.', {
                method: operation().method,
              })}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button
                disabled={model.recovering()}
                onPress={inputAction(model.recover, {
                  sessionId: props.sessionId,
                  id: operation().id,
                  abandon: false,
                })}
                style={controlStyle}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Recover original')}</Text>
              </Button>
              <If when={!operation().reference}>
                <Button
                  disabled={model.recovering()}
                  onPress={inputAction(model.recover, {
                    sessionId: props.sessionId,
                    id: operation().id,
                    abandon: true,
                  })}
                  style={controlStyle}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {tr('Cancel undispatched action')}
                  </Text>
                </Button>
              </If>
            </View>
          </View>
        )}
      </Each>
      <If when={model.loading() && !model.entries().length}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading terminals…')}</Text>
      </If>
      <If when={!model.loading() && !model.error() && !model.entries().length}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>
          {tr('Start a shell in this conversation’s workspace. Agent terminals also appear here.')}
        </Text>
      </If>
      <List
        each={model.entries()}
        keyExtractor={(entry) => entry.value().result.ref}
        estimatedItemSize={64}
        accessibilityLabel={tr('Conversation terminals')}
        style={{ flex: 1, minHeight: 0 }}
      >
        {(entry) => (
          <Button
            onPress={inputAction(model.open, {
              sessionId: entry().value().sessionId,
              ref: entry().value().result.ref,
            })}
            accessibilityLabel={tr('Open terminal {name}', { name: entry().value().result.cmd })}
            style={{
              ...controlStyle,
              paddingHorizontal: 12,
              minHeight: 64,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Icon name="terminal" color={C.muted} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text
                numberOfLines={1}
                style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}
              >
                {entry().value().result.cmd || tr('Interactive shell')}
              </Text>
              <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
                {terminalStatus(entry().value().result.status)} · {entry().value().result.mode} ·{' '}
                {entry().value().ownership.kind === 'local'
                  ? entry().value().result.cwd
                  : tr('shared · view only')}
              </Text>
            </View>
          </Button>
        )}
      </List>
    </View>
  );
}
