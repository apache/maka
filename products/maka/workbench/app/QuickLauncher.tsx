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

import { host } from 'maka/host';
import { cleanup, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { GlobalShortcut, Window, currentWindow } from 'nsh/desktop';
import type { OperationReply } from '../../../../packages/plugin-sdk/src/index.js';
import { loadDraft, saveDraft } from './host';
import { tr } from './locale';
import { renderText } from './text';
import { C, bodyTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

const SHORTCUT = 'alt+space';

type Navigation = {
  /** Takes the conversation out of the panes showing it, which saves their draft. */
  vacate(sessionId: string): Promise<boolean>;
  open(sessionId: string): Promise<boolean>;
};

async function openBot(): Promise<string> {
  const { reply } = (await host.mutation('agent', 'openBot', {})) as { reply: OperationReply };
  const value =
    reply.receipt.kind === 'recorded' && reply.receipt.outcome.kind === 'returned'
      ? (reply.receipt.outcome.value as { kind: string; sessionId?: string })
      : null;
  if (value?.kind !== 'opened' || !value.sessionId)
    throw new Error(tr('Maka Bot could not be opened'));
  return value.sessionId;
}

async function draftInSession(sessionId: string, text: string) {
  const session = host.session(sessionId);
  const draft = await loadDraft(session);
  await saveDraft(session, draft.revision, {
    text: draft.text.trim() ? `${draft.text}\n\n${text}` : text,
    attachments: draft.attachments,
  });
}

function Launcher(props: Navigation & { close(): void }) {
  // A window that does not activate leaves the keyboard with the app in use until focused.
  currentWindow()?.focus();
  const query = signal('');
  const failure = signal('');
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    failure.set('');
    try {
      const sessionId = await openBot();
      if (!(await props.vacate(sessionId))) return;
      const text = query().trim();
      if (text) await draftInSession(sessionId, text);
      if (await props.open(sessionId)) props.close();
    } catch (reason) {
      failure.set(reason instanceof Error ? reason.message : String(reason));
    } finally {
      running = false;
    }
  };
  const action = () => (query().trim() ? tr('Draft in Maka Bot') : tr('Open Maka Bot'));
  return (
    <View
      style={{
        backgroundColor: C.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.line,
        padding: 8,
        gap: 4,
      }}
    >
      <Input
        autoFocus
        accessibilityLabel={tr('Ask Maka')}
        placeholder={tr('Ask Maka')}
        value={query()}
        onChange={({ value }) => query.set(value)}
        onSubmit={() => void run()}
        style={{
          fontSize: 18,
          lineHeight: 28,
          padding: 8,
          color: C.text,
          placeholderColor: C.muted,
        }}
      />
      <Button
        accessibilityLabel={action()}
        onPress={() => void run()}
        style={{ padding: 8, borderRadius: 8 }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
      >
        <Text style={{ ...bodyTextStyle, color: C.text }}>{action()}</Text>
      </Button>
      <If when={failure()}>
        <Text style={{ ...bodyTextStyle, padding: 8, color: C.warning, userSelect: 'text' }}>
          {renderText(failure())}
        </Text>
      </If>
    </View>
  );
}

/** A popup from the app's one engine; it never activates Maka over the app in use. */
export function QuickLauncher(props: Navigation & { report(reason: unknown): void }) {
  const opened = signal(false);
  void GlobalShortcut.register(SHORTCUT, () => opened.set(!opened())).then((registered) => {
    if (!registered) props.report(new Error(tr('Another app is using Alt+Space')));
  }, props.report);
  cleanup(() => GlobalShortcut.unregister(SHORTCUT));
  return (
    <Window
      id="quick-launcher"
      kind="popup"
      title={tr('Ask Maka')}
      activate={false}
      level="aboveDock"
      transparent
      defaultPosition="center"
      defaultSize={{ width: 640, height: 112 }}
      sizeToContent="height"
      open={opened()}
      onOpenChange={({ open }) => opened.set(open)}
    >
      <Launcher vacate={props.vacate} open={props.open} close={() => opened.set(false)} />
    </Window>
  );
}
