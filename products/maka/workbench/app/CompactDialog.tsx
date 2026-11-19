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

import { LoadingState } from './Loading';
import { cleanup, signal, Text } from 'nsh';
import type { ConversationHandle } from '../../../../plugins/agent/conversations/ui/Conversation';
import { useHost } from './host';
import { tr } from './locale';
import { SettingsEditor } from './SettingsField';
import { createText, errorText } from './text';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { C, bodyTextStyle } from './ui';

export function CompactDialog(props: {
  owner: ConversationHandle;
  prompt?: string;
  close(): void;
}) {
  const host = useHost();
  const draft = signal('');
  const state = signal<'loading' | 'ready' | 'failed' | 'submitting'>('loading');
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const load = async () => {
    state.set('loading');
    error.set('');
    try {
      const result = await host.query('agent', 'compactionPrompt', {
        sessionId: props.owner.sessionId,
      });
      if (!alive) return;
      draft.set(props.prompt ?? result.compactionPrompt);
      state.set('ready');
    } catch (reason) {
      if (!alive) return;
      error.set(errorText(reason, 'Could not load compaction instructions.'));
      state.set('failed');
    }
  };
  void load();
  const close = () => {
    if (alive && state() !== 'submitting') props.close();
  };
  const submit = async (prompt: string) => {
    if (!alive || state() !== 'ready') return;
    state.set('submitting');
    error.set('');
    try {
      await props.owner.compact(prompt);
      if (alive) props.close();
    } catch (reason) {
      if (!alive) return;
      error.set(errorText(reason, 'Could not compact the conversation.'));
      state.set('ready');
    }
  };
  return (
    <ModalDialog size="editor" height={560} onCancel={close}>
      <DialogHeader
        title={tr('Compact conversation')}
        detail={tr('Instructions for this compaction only')}
      />
      <If when={state() === 'loading'}>
        <LoadingState />
      </If>
      <If when={state() === 'ready' || state() === 'submitting'}>
        <SettingsEditor
          label={tr('One-time compaction prompt')}
          value={draft()}
          change={(value) => draft.set(value)}
          disabled={state() === 'submitting'}
          autoFocus
        />
      </If>
      <If when={error()}>
        <Text style={{ color: C.danger, ...bodyTextStyle }}>{error()}</Text>
      </If>
      <DialogFooter>
        <If when={state() === 'failed'}>
          <SettingsButton label={tr('Retry compaction prompt')} onPress={() => void load()} />
        </If>
        <SettingsButton
          label={tr('Cancel')}
          accessibilityLabel={tr('Cancel compaction')}
          tone="quiet"
          disabled={state() === 'submitting'}
          onPress={close}
        />
        <SettingsButton
          label={tr('Compact now')}
          tone="primary"
          disabled={state() !== 'ready'}
          onPress={() => void submit(draft())}
        />
      </DialogFooter>
    </ModalDialog>
  );
}
