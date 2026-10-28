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

import { cleanup, inputAction, signal, Text, View } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type { ConversationHandle } from '../../../../plugins/agent/conversations/ui/Conversation';
import { useHost } from './host';
import { tr } from './locale';
import { SettingsEditor } from './SettingsField';
import { createText, errorText } from './text';
import { C, bodyTextStyle, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';

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
      error.set(errorText(reason));
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
      error.set(errorText(reason));
      state.set('ready');
    }
  };
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={close}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 720,
          height: '100%',
          maxHeight: 560,
          minHeight: 0,
          padding: 16,
          gap: 12,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
        }}
      >
        <Text style={{ color: C.text, ...bodyTextStyle }}>{tr('Compact conversation')}</Text>
        <Text style={{ color: C.muted, ...bodyTextStyle }}>
          {tr('Instructions for this compaction only')}
        </Text>
        <If when={state() === 'loading'}>
          <Text style={{ color: C.muted }}>{tr('Loading…')}</Text>
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
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            accessibilityLabel={tr('Cancel compaction')}
            disabled={state() === 'submitting'}
            onPress={inputAction(close, null)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ color: C.text }}>{tr('Cancel compaction')}</Text>
          </Button>
          <If when={state() === 'failed'}>
            <Button
              accessibilityLabel={tr('Retry compaction prompt')}
              onPress={inputAction(load, null)}
              style={controlStyle}
            >
              <Text style={{ color: C.text }}>{tr('Retry compaction prompt')}</Text>
            </Button>
          </If>
          <Button
            accessibilityLabel={tr('Compact now')}
            disabled={state() !== 'ready'}
            onPress={inputAction(submit, draft())}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ color: C.accent }}>{tr('Compact now')}</Text>
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
