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

import { errorText, message, renderText, type UiText } from './text';
import { tr } from './locale';
import { cleanup, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { SessionMenuAction } from './SessionMenu';
import { useHost } from './host';
import { forkTitle, sessionActionTarget, SessionRevisionConflict } from './sessionLifecycle';
import type { SessionAction, SessionActionTarget } from './sessionLifecycle';
import { C, inputBorderRadius, inputTextStyle, lineWidth } from './ui';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { AppliedPresetDialog } from './AppliedPresetDetails';
import { SessionTree } from './SessionTree';
import { SessionCompactionPrompt } from './SessionCompactionPrompt';

export function SessionActions(props: {
  session: SessionActionTarget;
  action: SessionMenuAction;
  current(): boolean;
  close(): void;
  notice(message: UiText): void;
  change(action: SessionAction): Promise<void>;
  /** Opens the conversation in a pane beside the current one, where there can be one. */
  openBeside?(): void;
  openSession?(id: string): void;
}) {
  const host = useHost();
  const session = signal(props.session);
  const action = props.action;
  const page = () => action;
  const title = signal(
    props.action === 'fork' ? forkTitle(props.session.title) : props.session.title,
  );
  const pending = signal(false);
  const error = signal<UiText>('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const active = () => alive && props.current();
  const sameSession = (original: SessionActionTarget) =>
    original.id === session().id && original.revision === session().revision;
  const back = (from: SessionMenuAction) => {
    if (active() && !pending() && page() === from) props.close();
  };
  const direct =
    action === 'pin' || action === 'unpin' || action === 'archive' || action === 'restore';
  const submit = async (action: SessionAction) => {
    if (!active() || pending() || !sameSession(action.session)) return;
    if (action.kind !== page()) return;
    if (
      (action.kind === 'rename' || action.kind === 'fork') &&
      (action.title !== title() || !action.title.trim())
    )
      return;
    pending.set(true);
    error.set('');
    try {
      await props.change(action);
      if (active()) props.close();
    } catch (reason) {
      if (!active()) return;
      error.set(errorText(reason, 'Could not update the conversation.'));
      if (direct) {
        props.notice(error());
        props.close();
        return;
      }
      if (reason instanceof SessionRevisionConflict) {
        // Keep the typed title. The refreshed snapshot supplies the next
        // explicitly requested action, never an automatic mutation retry.
        try {
          const observed = await host.query('agent', 'observe', { sessionId: action.session.id });
          if (active()) session.set(sessionActionTarget(observed.session));
        } catch (refreshError) {
          if (active())
            error.set(
              message('{message} {detail}', {
                message: errorText(reason, 'Could not update the conversation.'),
                detail: errorText(refreshError, 'Could not load conversation history.'),
              }),
            );
        }
      }
    } finally {
      if (alive) pending.set(false);
    }
  };
  const titleAction = (): SessionAction =>
    page() === 'fork'
      ? { kind: 'fork', session: session(), title: title(), position: { kind: 'end' } }
      : { kind: 'rename', session: session(), title: title() };
  const Status = () => (
    <>
      <If when={renderText(error())}>
        <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>{renderText(error())}</Text>
      </If>
      <If when={pending()}>
        <Text style={{ color: C.muted }}>{tr('Confirming the original action…')}</Text>
      </If>
    </>
  );
  if (direct)
    void submit({
      kind: action,
      session: props.session,
    });
  if (props.action === 'open_beside') {
    props.close();
    props.openBeside?.();
  }
  return (
    <View>
      <If when={page() === 'children'}>
        <SessionTree
          session={session()}
          current={() => active() && page() === 'children'}
          close={props.close}
          renderActions={(target) => (
            <SessionActions
              session={target.session}
              action={target.action}
              current={target.current}
              close={target.close}
              notice={props.notice}
              change={(action) => target.run(() => props.change(action))}
            />
          )}
          openSession={(id) => {
            props.close();
            props.openSession?.(id);
          }}
        />
      </If>
      <If when={page() === 'preset' && !!session().appliedPreset}>
        <AppliedPresetDialog
          preset={session().appliedPreset!}
          backend={session().backend}
          close={() => back('preset')}
        />
      </If>
      <If when={page() === 'compaction_prompt'}>
        <SessionCompactionPrompt
          session={session()}
          current={() => active() && page() === 'compaction_prompt'}
          close={props.close}
          change={props.change}
        />
      </If>
      <If when={page() === 'rename' || page() === 'fork'}>
        <ModalDialog size="form" onCancel={() => back(page())}>
          <DialogHeader
            title={page() === 'fork' ? tr('Fork conversation') : tr('Rename conversation')}
            detail={
              page() === 'fork'
                ? tr(
                    'Copy the current history into an independent conversation. This draft stays with its original conversation.',
                  )
                : undefined
            }
          />
          <Input
            ref={(node) => {
              node.focus();
              node.setSelection(0, title().length);
            }}
            autoFocus
            accessibilityLabel={tr('Conversation title')}
            value={title()}
            readonly={pending()}
            onChange={({ value }) => title.set(value)}
            // Enter saves, as the button below does.
            onSubmit={() => void submit(titleAction())}
            placeholder={tr('Conversation title')}
            style={{
              height: 32,
              color: C.text,
              backgroundColor: C.background,
              paddingHorizontal: 8,
              borderWidth: lineWidth(),
              borderColor: C.line,
              borderRadius: inputBorderRadius(),
              ...inputTextStyle,
            }}
            focusStyle={{ borderColor: C.accent }}
          />
          <Status />
          <DialogFooter>
            <SettingsButton
              label={tr('Cancel')}
              tone="quiet"
              disabled={pending()}
              onPress={() => back(page())}
            />
            <SettingsButton
              label={page() === 'fork' ? tr('Create fork') : tr('Save')}
              accessibilityLabel={
                page() === 'fork' ? tr('Create conversation fork') : tr('Save conversation title')
              }
              tone="primary"
              disabled={pending() || !title().trim()}
              onPress={() => void submit(titleAction())}
            />
          </DialogFooter>
        </ModalDialog>
      </If>
      <If when={page() === 'remove'}>
        <ModalDialog size="alert" onCancel={() => back('remove')}>
          <DialogHeader
            title={tr('Delete “{title}”?', {
              title: session().title || tr('Untitled conversation'),
            })}
            detail={tr(
              'Permanently delete this conversation and its history. Workspace files and independent forks are kept.',
            )}
          />
          <Status />
          <DialogFooter>
            <SettingsButton
              label={tr('Cancel')}
              tone="quiet"
              autoFocus
              disabled={pending()}
              onPress={() => back('remove')}
            />
            <SettingsButton
              label={tr('Delete')}
              accessibilityLabel={tr('Confirm delete conversation')}
              tone="danger"
              disabled={pending()}
              onPress={() => void submit({ kind: 'remove', session: session() })}
            />
          </DialogFooter>
        </ModalDialog>
      </If>
    </View>
  );
}
