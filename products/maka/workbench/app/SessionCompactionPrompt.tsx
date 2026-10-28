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
import { useHost } from './host';
import { tr } from './locale';
import { SettingsEditor } from './SettingsField';
import { SessionRevisionConflict } from './sessionLifecycle';
import type { SessionAction, SessionActionTarget } from './sessionLifecycle';
import { createText, errorText } from './text';
import { Icon } from './Icon';
import { dialogTop } from './chrome';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
} from './ui';

type PromptChoice = { kind: 'inherited' } | { kind: 'custom'; text: string };
type Form = {
  revision: number;
  original: string | null;
  inherited: string;
  choice: PromptChoice;
};
type State =
  | { kind: 'unloaded' | 'loading' | 'failed' }
  | { kind: 'editing' | 'saving' | 'conflict' | 'reloading'; form: Form };

export function SessionCompactionPrompt(props: {
  session: SessionActionTarget;
  current(): boolean;
  close(): void;
  change(action: SessionAction): Promise<void>;
}) {
  const host = useHost();
  const target = props.session;
  const state = signal<State>({ kind: 'unloaded' });
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const current = () => alive && props.current();
  const form = () => {
    const value = state();
    return 'form' in value ? value.form : null;
  };
  const forms = () => {
    const value = state();
    return 'form' in value ? [value.form] : [];
  };
  const pending = () => state().kind === 'saving' || state().kind === 'reloading';
  const editorText = (value: Form) =>
    value.choice.kind === 'inherited' ? value.inherited : value.choice.text;
  const prompt = (value: Form) => (value.choice.kind === 'inherited' ? null : value.choice.text);
  const dirty = () => {
    const value = form();
    return value !== null && prompt(value) !== value.original;
  };
  const load = async () => {
    const previous = state();
    if (
      !current() ||
      (previous.kind !== 'unloaded' && previous.kind !== 'failed' && previous.kind !== 'conflict')
    )
      return;
    const draft = form();
    state.set(draft ? { kind: 'reloading', form: draft } : { kind: 'loading' });
    error.set('');
    try {
      const result = await host.query('agent', 'compactionPrompt', { sessionId: target.id });
      if (!current()) return;
      state.set({
        kind: 'editing',
        form: {
          revision: result.revision,
          original: result.prompt,
          inherited: result.defaultCompactionPrompt,
          choice:
            result.prompt === null
              ? { kind: 'inherited' }
              : { kind: 'custom', text: result.compactionPrompt },
        },
      });
    } catch (reason) {
      if (!current()) return;
      error.set(errorText(reason));
      state.set(draft ? previous : { kind: 'failed' });
    }
  };
  const edit = (text: string) => {
    const value = state();
    if (!current() || (value.kind !== 'editing' && value.kind !== 'conflict')) return;
    if (text === editorText(value.form)) return;
    state.set({ ...value, form: { ...value.form, choice: { kind: 'custom', text } } });
  };
  const inherit = () => {
    const value = state();
    if (!current() || (value.kind !== 'editing' && value.kind !== 'conflict')) return;
    state.set({
      ...value,
      form: { ...value.form, choice: { kind: 'inherited' } },
    });
  };
  const close = () => {
    if (current() && !pending()) props.close();
  };
  const save = async () => {
    const value = state();
    if (!current() || value.kind !== 'editing' || !dirty()) return;
    state.set({ kind: 'saving', form: value.form });
    error.set('');
    try {
      await props.change({
        kind: 'compaction_prompt',
        session: { ...target, revision: value.form.revision },
        prompt: prompt(value.form),
      });
      if (current()) props.close();
    } catch (reason) {
      if (!current()) return;
      error.set(errorText(reason));
      state.set({
        kind: reason instanceof SessionRevisionConflict ? 'conflict' : 'editing',
        form: value.form,
      });
    }
  };
  void load();
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
        paddingTop: dialogTop(16),
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 880,
          height: '100%',
          maxHeight: 800,
          minHeight: 0,
          padding: 16,
          gap: 12,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 16,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...bodyTextStyle, flex: 1, color: C.text, fontWeight: '600' }}>
            {tr('Conversation compaction prompt')}
          </Text>
          <Button
            disabled={pending()}
            accessibilityLabel={tr('Close conversation compaction prompt')}
            onPress={inputAction(close, null)}
            style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </View>
        <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
          {target.title || tr('Untitled conversation')}
        </Text>
        <If when={state().kind === 'loading'}>
          <Text style={{ color: C.muted }}>{tr('Loading…')}</Text>
        </If>
        <Each of={forms()} key={() => target.id}>
          {(value) => (
            <SettingsEditor
              label={tr('Conversation compaction prompt')}
              value={editorText(value())}
              change={edit}
              disabled={pending()}
              autoFocus
            />
          )}
        </Each>
        <If when={error()}>
          <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
            {error()}
          </Text>
        </If>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Each of={forms()} key={() => target.id}>
            {(value) => (
              <Button
                disabled={pending()}
                selected={value().choice.kind === 'inherited'}
                accessibilityLabel={tr('Use global compaction prompt')}
                onPress={inputAction(inherit, null)}
                style={controlStyle}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Use global settings')}
                </Text>
              </Button>
            )}
          </Each>
          <View style={{ flex: 1 }} />
          <If when={state().kind === 'failed' || state().kind === 'conflict'}>
            <Button
              accessibilityLabel={
                state().kind === 'conflict' ? tr('Reload (discard edits)') : tr('Retry')
              }
              onPress={inputAction(load, null)}
              style={controlStyle}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.text }}>
                {state().kind === 'conflict' ? tr('Reload (discard edits)') : tr('Retry')}
              </Text>
            </Button>
          </If>
          <Button
            disabled={pending()}
            accessibilityLabel={tr('Cancel conversation compaction prompt')}
            onPress={inputAction(close, null)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Cancel')}</Text>
          </Button>
          <Button
            disabled={state().kind !== 'editing' || !dirty()}
            accessibilityLabel={tr('Save conversation compaction prompt')}
            onPress={inputAction(save, null)}
            style={{ ...controlStyle, backgroundColor: C.accent }}
            hoverStyle={{ backgroundColor: C.accentHover }}
            focusStyle={{ backgroundColor: C.accentHover }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.background }}>
              {state().kind === 'saving' ? tr('Saving…') : tr('Save')}
            </Text>
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
