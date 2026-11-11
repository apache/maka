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
import { cleanup, effect, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { ViewRef } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { windowSize } from 'nsh';
import { useHost } from './host';
import { forkTitle, sessionActionTarget, SessionRevisionConflict } from './sessionLifecycle';
import type { SessionAction, SessionActionTarget } from './sessionLifecycle';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  floatingStyle,
  inputTextStyle,
  inputBorderRadius,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
} from './ui';
import { Icon } from './Icon';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { SessionTree } from './SessionTree';
import { SessionCompactionPrompt } from './SessionCompactionPrompt';

type Page = 'children' | 'actions' | 'rename' | 'fork' | 'remove' | 'compaction_prompt';
export function SessionActions(props: {
  session: SessionActionTarget;
  anchor(): ViewRef | null;
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
  const page = signal<Page>('actions');
  const title = signal('');
  const pending = signal(false);
  const error = signal<UiText>('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const active = () => alive && props.current();
  const sameSession = (original: SessionActionTarget) =>
    original.id === session().id && original.revision === session().revision;
  const back = (from: Page) => {
    if (!active() || pending() || page() !== from) return;
    if (page() === 'actions' || !props.anchor()) props.close();
    else {
      page.set('actions');
      error.set('');
    }
  };
  const menuChanged = ({ open: next }: { open: boolean }) => {
    if (!next) back('actions');
  };
  effect(() => {
    if (!active() || page() !== 'actions' || props.anchor() || pending()) return;
    // A catalog refresh may retire the row before its action settles.
    // Keep the operation owner until then, and retain any real failure.
    if (error()) props.notice(error());
    props.close();
  });
  const edit = ({ to, original }: { to: Page; original: SessionActionTarget }) => {
    if (!active() || pending() || page() !== 'actions' || !sameSession(original)) return;
    error.set('');
    title.set(to === 'fork' ? forkTitle(original.title) : original.title);
    page.set(to);
  };
  const openBeside = () => {
    if (!active() || pending() || page() !== 'actions') return;
    props.close();
    props.openBeside?.();
  };
  const submit = async (action: SessionAction) => {
    if (!active() || pending() || !sameSession(action.session)) return;
    if (action.kind === 'rename' || action.kind === 'fork' || action.kind === 'remove') {
      if (page() !== action.kind) return;
    } else if (
      page() !== 'actions' ||
      (action.kind !== 'pin' &&
        action.kind !== 'unpin' &&
        action.kind !== (session().archived ? 'restore' : 'archive'))
    )
      return;
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
      error.set(errorText(reason));
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
                message: errorText(reason),
                detail: errorText(refreshError),
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
  return (
    <View>
      <If when={page() === 'actions' && !props.anchor() && pending()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Updating conversation…')}</Text>
      </If>
      <If when={page() === 'actions'}>
        <Popover
          open={props.anchor() !== null}
          anchor={props.anchor()}
          onOpenChange={menuChanged}
          closeOnEscape={!pending()}
          closeOnPressOutside={!pending()}
          placement="bottom"
          align="end"
          offset={4}
          margin={8}
          popupStyle={{
            ...floatingStyle(),
            width: 220,
            maxHeight: Math.max(0, windowSize().height - 16),
          }}
        >
          <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
            <View role="menu" accessibilityLabel={tr('Conversation actions')}>
              <If when={props.openSession}>
                <Button
                  disabled={pending()}
                  accessibilityLabel={tr('Child conversations')}
                  role="menuitem"
                  style={menuRowStyle()}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={menuRowHoverStyle()}
                  disabledStyle={controlDisabledStyle}
                  onPress={inputAction(edit, { to: 'children', original: session() })}
                >
                  <Icon name="children" color={C.secondary} />
                  <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                    {tr('Child conversations')}
                  </Text>
                </Button>
              </If>
              <If when={props.openBeside}>
                <Button
                  disabled={pending()}
                  accessibilityLabel={tr('Open to the side')}
                  role="menuitem"
                  style={menuRowStyle()}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={menuRowHoverStyle()}
                  disabledStyle={controlDisabledStyle}
                  onPress={inputAction(openBeside, null)}
                >
                  <Icon name="split" color={C.secondary} />
                  <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                    {tr('Open to the side')}
                  </Text>
                </Button>
              </If>
              <If when={props.openSession || props.openBeside}>
                <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
              </If>
              <Button
                disabled={pending() || session().archived}
                accessibilityLabel={
                  session().pinned ? tr('Unpin conversation') : tr('Pin conversation')
                }
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(submit, {
                  kind: session().pinned ? 'unpin' : 'pin',
                  session: session(),
                })}
              >
                <Icon name="pin" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                  {session().pinned ? tr('Unpin') : tr('Pin')}
                </Text>
              </Button>
              <Button
                disabled={pending() || session().archived}
                accessibilityLabel={tr('Rename conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'rename', original: session() })}
              >
                <Icon name="edit" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Rename…')}
                </Text>
              </Button>
              <Button
                disabled={pending()}
                accessibilityLabel={
                  session().archived ? tr('Restore conversation') : tr('Archive conversation')
                }
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(submit, {
                  kind: session().archived ? 'restore' : 'archive',
                  session: session(),
                })}
              >
                <Icon name={session().archived ? 'latest' : 'archive'} color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                  {session().archived ? tr('Restore') : tr('Archive')}
                </Text>
              </Button>
              <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Fork conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'fork', original: session() })}
              >
                <Icon name="fork" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Fork…')}
                </Text>
              </Button>
              <Button
                disabled={pending() || session().archived}
                accessibilityLabel={tr('Edit conversation compaction prompt')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'compaction_prompt', original: session() })}
              >
                <Icon name="compaction" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Compaction prompt…')}
                </Text>
              </Button>
              <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Delete conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={menuRowHoverStyle()}
                focusStyle={menuRowHoverStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'remove', original: session() })}
              >
                <Icon name="trash" color={C.danger} />
                <Text accessibilityElementsHidden style={{ ...captionTextStyle, color: C.danger }}>
                  {tr('Delete…')}
                </Text>
              </Button>
              <If when={renderText(error())}>
                <Text
                  style={[
                    { ...bodyTextStyle, color: C.danger, padding: 8 },
                    { userSelect: 'text' },
                  ]}
                >
                  {renderText(error())}
                </Text>
              </If>
              <If when={pending()}>
                <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
                  {tr('Updating conversation…')}
                </Text>
              </If>
            </View>
          </Scroll>
        </Popover>
      </If>
      <If when={page() === 'children'}>
        <SessionTree
          session={session()}
          current={() => active() && page() === 'children'}
          close={props.close}
          renderActions={(target) => (
            <SessionActions
              session={target.session}
              anchor={target.anchor}
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
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: inputBorderRadius,
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
