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

import { textTooltip } from './ui';
import { errorText, message, renderText, type UiText } from './text';
import { tr } from './locale';
import { cleanup, effect, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { YNode } from 'nsh';
import { Button, Dialog, Popover } from 'nsh/base';
import { windowSize } from 'nsh';
import { host } from './host';
import { forkTitle, sessionActionTarget, SessionRevisionConflict } from './sessionLifecycle';
import type { SessionAction, SessionActionTarget } from './sessionLifecycle';
import {
  C,
  compact,
  bodyTextStyle,
  captionTextStyle,
  secondaryTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  inputTextStyle,
  inputBorderRadius,
} from './ui';
import { Icon } from './Icon';
import { dialogTop } from './chrome';

type Page = 'actions' | 'rename' | 'fork' | 'remove';
export function SessionActions(props: {
  session: SessionActionTarget;
  anchor(): YNode | null;
  current(): boolean;
  close(): void;
  notice(message: UiText): void;
  change(action: SessionAction): Promise<void>;
}) {
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
  const dismiss = (from: Page) => {
    if (active() && !pending() && page() === from) props.close();
  };
  const menuChanged = (next: boolean) => {
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
  const submit = async (action: SessionAction) => {
    if (!active() || pending() || !sameSession(action.session)) return;
    if (action.kind === 'rename' || action.kind === 'fork' || action.kind === 'remove') {
      if (page() !== action.kind) return;
    } else if (page() !== 'actions' || action.kind !== (session().archived ? 'restore' : 'archive'))
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
            width: 280,
            maxWidth: Math.max(0, windowSize().width - 16),
            maxHeight: Math.max(0, windowSize().height - 16),
            minHeight: 0,
            padding: 6,
            backgroundColor: C.surface,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 12,
          }}
        >
          <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
            <View role="menu" accessibilityLabel={tr('Conversation actions')} style={{ gap: 2 }}>
              <Text
                style={{
                  ...captionTextStyle,
                  color: C.muted,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                }}
              >
                {tr('Conversation actions')}
              </Text>
              <Button
                disabled={pending() || session().archived}
                accessibilityLabel={tr('Rename conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'rename', original: session() })}
              >
                <Icon name="edit" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...secondaryTextStyle, color: C.text }}>
                  {tr('Rename')}
                </Text>
              </Button>
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Fork conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'fork', original: session() })}
              >
                <Icon name="fork" color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...secondaryTextStyle, color: C.text }}>
                  {tr('Fork conversation')}
                </Text>
              </Button>
              <Button
                disabled={pending()}
                accessibilityLabel={
                  session().archived ? tr('Restore conversation') : tr('Archive conversation')
                }
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(submit, {
                  kind: session().archived ? 'restore' : 'archive',
                  session: session(),
                })}
              >
                <Icon name={session().archived ? 'latest' : 'archive'} color={C.secondary} />
                <Text accessibilityElementsHidden style={{ ...secondaryTextStyle, color: C.text }}>
                  {session().archived ? tr('Restore') : tr('Archive')}
                </Text>
              </Button>
              <View
                style={[
                  { height: 1, backgroundColor: C.line, margin: 4 },
                  { pointerEvents: 'none' },
                ]}
              />
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Delete conversation')}
                role="menuitem"
                style={menuRowStyle()}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
                onPress={inputAction(edit, { to: 'remove', original: session() })}
              >
                <Icon name="trash" color={C.danger} />
                <Text
                  accessibilityElementsHidden
                  style={{ ...secondaryTextStyle, color: C.danger }}
                >
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
      <If when={page() !== 'actions'}>
        <Dialog
          animation="none"
          closeOnEscape={false}
          closeOnBackdropPress={false}
          closeOnSwipe={false}
          onCancel={() => back(page())}
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
            paddingTop: dialogTop(16),
            backgroundColor: '#00000099',
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 560,
              maxHeight: '100%',
              padding: 16,
              gap: 16,
              backgroundColor: C.surface,
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Back from conversation actions')}
                tooltip={textTooltip(() => tr('Back · Esc'))}
                onPress={inputAction(back, page())}
                style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Icon name="back" color={C.secondary} />
              </Button>
              <Text
                style={[
                  { flex: 1, color: C.text, fontSize: 18, lineHeight: 24, fontWeight: '600' },
                  { numberOfLines: 2 },
                ]}
              >
                {page() === 'rename'
                  ? tr('Rename conversation')
                  : page() === 'fork'
                    ? tr('Fork conversation')
                    : page() === 'remove'
                      ? tr('Delete conversation?')
                      : tr('Conversation actions')}
              </Text>
              <Button
                disabled={pending()}
                accessibilityLabel={tr('Close conversation actions')}
                tooltip={textTooltip(() => tr('Close'))}
                onPress={inputAction(dismiss, page())}
                style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                disabledStyle={controlDisabledStyle}
              >
                <Icon name="close" color={C.secondary} />
              </Button>
            </View>
            <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
              <View style={{ gap: 8 }}>
                <Text style={[{ color: C.text }, { userSelect: 'text' }]}>
                  {session().title || tr('Untitled conversation')}
                </Text>
                <Text style={[{ color: C.muted }, { numberOfLines: 2 }]}>
                  {session().workspace.path}
                </Text>
                <If when={session().archived}>
                  <Text style={{ color: C.warning }}>{tr('Archived conversation')}</Text>
                </If>
                <If when={renderText(error())}>
                  <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
                    {renderText(error())}
                  </Text>
                </If>
                <If when={pending()}>
                  <Text style={{ color: C.muted }}>{tr('Confirming the original action…')}</Text>
                </If>
                <If when={page() === 'rename' || page() === 'fork'}>
                  <Input
                    ref={(node) => {
                      node.focus();
                      node.setSelection(0, title().length);
                    }}
                    autoFocus
                    accessibilityLabel={tr('Conversation title')}
                    value={title()}
                    readonly={pending()}
                    onChange={(value) => title.set(value)}
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
                  <If when={page() === 'fork'}>
                    <Text style={{ color: C.muted }}>
                      {tr(
                        'Copy the current history into an independent conversation. This draft stays with its original conversation.',
                      )}
                    </Text>
                  </If>
                  <Button
                    disabled={pending() || !title().trim()}
                    accessibilityLabel={
                      page() === 'fork'
                        ? tr('Create conversation fork')
                        : tr('Save conversation title')
                    }
                    style={{ ...controlStyle, alignSelf: 'flex-start', backgroundColor: C.accent }}
                    hoverStyle={{ backgroundColor: C.accentHover }}
                    focusStyle={{ backgroundColor: C.accentHover }}
                    disabledStyle={controlDisabledStyle}
                    onPress={inputAction(
                      submit,
                      page() === 'fork'
                        ? { kind: 'fork', session: session(), title: title(), turnId: null }
                        : { kind: 'rename', session: session(), title: title() },
                    )}
                  >
                    <Text style={{ color: C.background }}>
                      {page() === 'fork' ? tr('Create fork') : tr('Save title')}
                    </Text>
                  </Button>
                </If>
                <If when={page() === 'remove'}>
                  <Text style={{ color: C.warning }}>
                    {tr(
                      'Permanently delete this conversation and its history. Workspace files and independent forks are kept.',
                    )}
                  </Text>
                  <Button
                    disabled={pending()}
                    accessibilityLabel={tr('Confirm delete conversation')}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                    onPress={inputAction(submit, { kind: 'remove', session: session() })}
                  >
                    <Text style={{ color: C.danger }}>{tr('Delete permanently')}</Text>
                  </Button>
                  <Button
                    disabled={pending()}
                    onPress={inputAction(back, 'remove')}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ color: C.text }}>{tr('Keep conversation')}</Text>
                  </Button>
                </If>
              </View>
            </Scroll>
          </View>
        </Dialog>
      </If>
    </View>
  );
}

const menuRowStyle = () => ({
  ...controlStyle,
  height: compact() ? 32 : 40,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  paddingHorizontal: 8,
  paddingVertical: 6,
  gap: 8,
});
