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

import { effect, inputAction, signal, Text, View } from 'nsh';
import type { InputRef, JSX } from 'nsh';
import { Button, Input } from 'nsh/base';
import type { ComposerViewInput, UiActivation, UiEmbeddedViewProps } from '@maka-agent/plugin-sdk';

function Composer(props: UiEmbeddedViewProps<ComposerViewInput<JSX.Element>, JSX.Element>) {
  const input = props.input;
  const editor = signal<InputRef | null>(null);
  const selection = signal({ start: 0, end: 0 });
  const focused = signal(false);
  const composing = signal(false);
  effect(() => {
    input.session();
    editor.set(null);
    selection.set({ start: 0, end: 0 });
    focused.set(false);
    composing.set(false);
  });
  const blocked = () => input.blocked?.() || !input.active() || !input.session()?.editable();
  const sendDisabled = () =>
    blocked() ||
    composing() ||
    !!input.session()?.blockedReason() ||
    (!input.session()?.draft().trim() && !input.session()?.attachments.files().length);
  const intake = (uris: string[] | null) => {
    const session = input.session();
    const node = editor();
    if (!session || !node || blocked() || composing()) return;
    const text = session.draft();
    const range = { ...selection() };
    const insert = (value: string) => {
      if (!value) return;
      if (
        input.session() !== session ||
        editor() !== node ||
        !focused() ||
        composing() ||
        session.draft() !== text ||
        selection().start !== range.start ||
        selection().end !== range.end
      ) {
        session.attachments.notify(new Error('The input changed. Paste again.'));
        return;
      }
      node.replaceRange({
        start: range.start,
        end: range.end,
        text: value,
        expectedText: text,
        expectedSelection: range,
      });
    };
    try {
      if (uris) session.attachments.dropFiles(uris, insert);
      else session.attachments.pasteClipboard(insert);
    } catch (error) {
      session.attachments.reportError(error);
    }
  };
  const drop = (event: { uris: string[] }) => intake(event.uris);
  input.dropFiles?.(drop);
  return (
    <View style={{ padding: 16, gap: 8, flexShrink: 0 }}>
      {input.request}
      <If when={input.session() === null}>
        <Button onPress={input.chooseWorkspace}>
          <Text>Choose workspace</Text>
        </Button>
      </If>
      <Each of={input.session() ? [input.session()!] : []} key={(session) => session.sessionId}>
        {(readSession) => {
          const session = readSession();
          const Picker = session.attachments.renderPicker;
          return (
            <View style={{ gap: 8 }}>
              <Text>{session.workspace()}</Text>
              <If when={session.error()}>
                <Text>{session.error()}</Text>
              </If>
              <If when={session.notice()}>
                <Text>{session.notice()}</Text>
              </If>
              <Input
                ref={(node) => {
                  editor.set(node);
                  input.attach(node);
                }}
                value={session.draft()}
                readonly={blocked()}
                multiline
                autoFocus
                submitBehavior="submit"
                accessibilityLabel="Message composer"
                placeholder="Message…"
                onChange={({ value }) => {
                  if (input.session() === session) session.changeDraft(value);
                }}
                onCompositionChange={(event) => {
                  if (input.session() === session) composing.set(event.composing);
                }}
                onSelectionChange={(event) => {
                  if (input.session() === session) selection.set({ ...event });
                }}
                onFocus={() => {
                  if (input.session() === session) focused.set(true);
                }}
                onBlur={() => {
                  if (input.session() === session) focused.set(false);
                }}
                onPaste={(event) => {
                  if (input.session() !== session) return;
                  if (event.uris.length) drop(event);
                  else if (!event.text && !event.files.length) intake(null);
                }}
                onFileDrop={(event) => {
                  if (input.session() === session) drop(event);
                }}
                onSubmit={(event) => {
                  if (input.session() === session && !sendDisabled()) session.submit(event);
                }}
                style={{ minHeight: 64, maxHeight: 160 }}
              />
              <Picker
                visible={session.attachments.picker()}
                disabled={session.attachments.restoring()}
                pathLabel="Attachment path"
                pathPlaceholder="Absolute file path…"
                uploadLabel="Upload selected file"
                uploadingLabel="Uploading…"
              />
              <Each of={session.attachments.files()} key={(file) => file.id}>
                {(file) => (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Text>{file().name}</Text>
                    <Button
                      onPress={inputAction(session.attachments.remove, {
                        owner: session.sessionId,
                        id: file().id,
                      })}
                    >
                      <Text>Remove</Text>
                    </Button>
                  </View>
                )}
              </Each>
              <Each of={session.attachments.rows()} key={(row) => row.id}>
                {(row) => (
                  <View style={{ gap: 4 }}>
                    <Text>
                      {row().name} · {row().kind}
                    </Text>
                    <If when={row().error}>
                      <Text>{row().error}</Text>
                    </If>
                    <If when={row().kind === 'unknown'}>
                      <Button
                        disabled={session.attachments.recovering() !== null}
                        onPress={inputAction(
                          row().recovery === 'inspect'
                            ? session.attachments.inspect
                            : session.attachments.recover,
                          { owner: session.sessionId, id: row().id },
                        )}
                      >
                        <Text>Recover original upload</Text>
                      </Button>
                    </If>
                    <If when={row().recovery === 'recover_or_abandon' && row().kind === 'unknown'}>
                      <Button
                        disabled={session.attachments.recovering() !== null}
                        onPress={inputAction(session.attachments.abandon, {
                          owner: session.sessionId,
                          id: row().id,
                        })}
                      >
                        <Text>Abandon unconfirmed upload</Text>
                      </Button>
                    </If>
                    <If when={row().kind === 'failed'}>
                      <Button
                        onPress={inputAction(session.attachments.remove, {
                          owner: session.sessionId,
                          id: row().id,
                        })}
                      >
                        <Text>Remove failed upload</Text>
                      </Button>
                    </If>
                  </View>
                )}
              </Each>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {input.models}
                <Button
                  disabled={blocked()}
                  onPress={inputAction(session.attachments.open, {
                    owner: session.sessionId,
                    value: !session.attachments.picker(),
                  })}
                >
                  <Text>Attach</Text>
                </Button>
                <Button
                  disabled={sendDisabled()}
                  onPress={inputAction(session.sendRendered, {
                    owner: session.sessionId,
                    text: session.draft(),
                    backend: session.backend(),
                    attachments: session.attachments.ids(),
                  })}
                >
                  <Text>{session.invocation() ? 'Queue message' : 'Send message'}</Text>
                </Button>
                <If when={session.invocation() !== null}>
                  <Button
                    disabled={session.stopping()}
                    onPress={inputAction(session.stop, session.invocation())}
                  >
                    <Text>Stop</Text>
                  </Button>
                </If>
              </View>
              <If when={session.blockedReason()}>
                <Text>{session.blockedReason()}</Text>
              </If>
              <If when={session.attachments.error() || session.attachments.notice()}>
                <Text>{session.attachments.error() || session.attachments.notice()}</Text>
              </If>
              <If when={session.recoverable()}>
                <Button
                  disabled={session.recovering()}
                  onPress={inputAction(session.recover, null)}
                >
                  <Text>Recover original send receipt</Text>
                </Button>
              </If>
              <Each of={session.unconfirmed()} key={(id) => id}>
                {(id) => (
                  <Button
                    disabled={session.recovering()}
                    onPress={inputAction(session.abandon, id())}
                  >
                    <Text>Abandon unconfirmed send · {id()}</Text>
                  </Button>
                )}
              </Each>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

export function activate(): UiActivation<JSX.Element> {
  return {
    exports: {
      composer: { kind: 'view', contract: 'maka.composer', render: Composer },
    },
  };
}
