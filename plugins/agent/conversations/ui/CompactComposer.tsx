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

import { signal, Text, View, type InputRef, type JSX } from 'nsh';
import { Button, Input } from 'nsh/base';
import type { ClientDraftAttachment } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  MakaMark,
  QUICK_BAR_SLOT,
  quickBarStyle,
  quickInputStyle,
} from '../../../../products/maka/workbench/app/QuickBar';
import {
  bodyTextStyle,
  C,
  controlFocusStyle,
  controlHoverStyle,
  IconButton,
} from '../../../../products/maka/workbench/app/ui';

const MAX_INPUT_HEIGHT = 96;

/** The conversation's input in the popup's top bar, where the launcher's input was. */
export function CompactComposer(props: {
  session(): ComposerSession<JSX.Element> | null;
  stop(): void;
  expand(): void;
  chooseModel(): void;
  attach(node: InputRef): void;
}) {
  const refused = signal('');
  const inputHeight = signal<number>(quickInputStyle().lineHeight);
  const running = () => (props.session()?.run() ?? null) !== null;
  const unavailable = () => props.session()?.modelDetails().kind === 'unavailable';
  const failure = () => {
    const session = props.session();
    if (!session) return '';
    return (
      session.error() ||
      session.sends().find((send) => send.state === 'failed')?.detail ||
      refused()
    );
  };
  const send = () => {
    const session = props.session();
    if (!session || unavailable()) return;
    const text = session.draft();
    if (text.trim() === '' && session.attachments.files().length === 0) return;
    // Commands and their arguments need the full composer.
    if (text.startsWith('/')) {
      props.expand();
      return;
    }
    const reason = session.blockedReason();
    refused.set(reason);
    if (!reason) session.submit({ text });
  };
  return (
    <View>
      <View style={quickBarStyle}>
        <View style={{ height: QUICK_BAR_SLOT, justifyContent: 'center' }}>
          <MakaMark />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 8, paddingVertical: 8 }}>
          <Input
            ref={props.attach}
            autoFocus
            multiline
            submitBehavior="submit"
            accessibilityLabel={tr('Ask Maka')}
            placeholder={
              props.session()?.empty() === false ? tr('Ask a follow-up') : tr('Ask Maka')
            }
            value={props.session()?.draft() ?? ''}
            readonly={!(props.session()?.editable() ?? false)}
            onChange={({ value }) => {
              refused.set('');
              props.session()?.changeDraft(value);
            }}
            onSubmit={send}
            onContentSizeChange={({ size }) =>
              inputHeight.set(Math.min(size.height, MAX_INPUT_HEIGHT))
            }
            style={{ ...quickInputStyle(), height: inputHeight() }}
          />
          <If when={(props.session()?.attachments.files().length ?? 0) > 0}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Each
                of={props.session()?.attachments.files() ?? []}
                key={(file: ClientDraftAttachment) => file.id}
              >
                {(file) => (
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: C.raised,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        lineHeight: 18,
                        color: C.secondary,
                        numberOfLines: 1,
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {file().name}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
        <View
          style={{ height: QUICK_BAR_SLOT, flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <If when={running()}>
            <IconButton label={tr('Stop')} icon="stop" onPress={props.stop} />
          </If>
          <If when={props.session()?.empty() === false}>
            <IconButton label={tr('Open in Main Window')} icon="expand" onPress={props.expand} />
          </If>
        </View>
      </View>
      <If when={unavailable()}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 8,
            paddingLeft: 42,
            paddingRight: 12,
            borderTopWidth: 1,
            borderTopColor: C.line,
          }}
        >
          <Text style={{ ...bodyTextStyle, flex: 1, color: C.warning }}>
            {tr('No model is available')}
          </Text>
          <Button
            accessibilityLabel={tr('Choose Model')}
            onPress={props.chooseModel}
            style={{
              paddingHorizontal: 10,
              height: 32,
              justifyContent: 'center',
              borderRadius: 6,
              backgroundColor: C.raised,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ fontSize: 13, color: C.text }}>{tr('Choose Model')}</Text>
          </Button>
        </View>
      </If>
      <If when={failure() !== ''}>
        <Text
          style={[
            { ...bodyTextStyle, paddingVertical: 8, paddingLeft: 42, paddingRight: 12 },
            { color: C.warning, userSelect: 'text' },
          ]}
        >
          {failure()}
        </Text>
      </If>
    </View>
  );
}
