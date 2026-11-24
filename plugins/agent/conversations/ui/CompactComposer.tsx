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
import type { ClientDraftAttachment } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { hasComposerContent } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { DraftQuotes } from '../../composer/ui/DraftQuotes';
import { InlineCallout } from '../../../../products/maka/workbench/app/Feedback';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { CompactInputBar } from '../../../../products/maka/workbench/app/QuickBar';
import { C, IconButton } from '../../../../products/maka/workbench/app/ui';

/** The conversation's input in the popup's top bar, where the launcher's input was. */
export function CompactComposer(props: {
  session(): ComposerSession<JSX.Element> | null;
  stop(): void;
  expand(): void;
  chooseModel(): void;
  attach(node: InputRef): void;
}) {
  const refused = signal('');
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
    if (!hasComposerContent(text.trim(), session.attachments.files(), session.quotes())) return;
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
      <CompactInputBar
        attach={props.attach}
        label={tr('Ask Maka')}
        placeholder={props.session()?.empty() === false ? tr('Ask a follow-up') : tr('Ask Maka')}
        value={props.session()?.draft() ?? ''}
        readonly={!(props.session()?.editable() ?? false)}
        change={(value) => {
          refused.set('');
          props.session()?.changeDraft(value);
        }}
        submit={send}
        extra={
          <>
            <If when={props.session() !== null}>
              <DraftQuotes owner={props.session()!} />
            </If>
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
          </>
        }
        actions={
          <>
            <If when={running()}>
              <IconButton label={tr('Stop')} icon="stop" onPress={props.stop} />
            </If>
            <If when={props.session()?.empty() === false}>
              <IconButton label={tr('Open in Main Window')} icon="expand" onPress={props.expand} />
            </If>
          </>
        }
      />
      <If when={unavailable() || failure() !== ''}>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <If
            when={unavailable()}
            else={
              <InlineCallout
                tone="danger"
                message={failure()}
                onDismiss={() => {
                  const session = props.session();
                  if (session?.error()) {
                    session.dismissError();
                    return;
                  }
                  const failedSend = session?.sends().find((item) => item.state === 'failed');
                  if (session && failedSend) {
                    void session.dismissSend(failedSend.id);
                    return;
                  }
                  refused.set('');
                }}
              />
            }
          >
            <InlineCallout
              tone="warning"
              message={tr('No model is available')}
              action={{ label: tr('Choose Model'), primary: true, onPress: props.chooseModel }}
            />
          </If>
        </View>
      </If>
    </View>
  );
}
