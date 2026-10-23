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

import { ProjectMcp } from './ProjectMcpConsent';
import type { ProjectMcp as ProjectMcpOwner } from './projectMcp';
import { tr } from './locale';
import { cleanup, effect, Input, inputAction, signal, Text, View } from 'nsh';
import type { JSX, YNode } from 'nsh';
import { Image } from 'nsh/image';
import { Button } from 'nsh/base';
import { platform, windowSize } from 'nsh/device';
import { keymap } from 'nsh/keymap';
import { DraftAttachments } from './Attachments';
import type { AttachmentDraft } from './attachmentDraft';
import type { ImagePreview } from './ImageThumbnail';
import { Checklist } from './Checklist';
import { QueueDock, type QueueSession } from './QueueDock';
import { SessionPermissionsSelect } from './SessionPermissionsSelect';
import type { SessionPermissions } from './sessionPermissions';
import type { BackendIdentity, ModelDetails } from './modelSelection';
import { C, bodyTextStyle, compact, controlStyle, shortcut } from './ui';
import { Icon } from './Icon';
import logo from './assets/maka.png';

export type SendAction = {
  owner: string;
  text: string;
  backend: BackendIdentity;
  attachments: string[];
};

// These are the immutable session controller's original reads and actions.
// The resident composer owns no second draft or model selection.
export type ComposerSession = {
  sessionId: string;
  queue: QueueSession;
  draft(): string;
  attachments: AttachmentDraft;
  previewImage(image: ImagePreview): void;
  editable(): boolean;
  blockedReason(): string;
  backend(): BackendIdentity;
  modelDetails(): ModelDetails;
  refreshModel(): Promise<void>;
  permissions: SessionPermissions;
  projectMcp: ProjectMcpOwner;
  workspace(): string;
  empty(): boolean;
  error(): string;
  notice(): string;
  recoverable(): boolean;
  recovering(): boolean;
  unconfirmed(): string[];
  invocation(): string | null;
  stopping(): boolean;
  metrics(): string;
  changeDraft(text: string): void;
  submit(event: { text: string }): void;
  sendRendered(action: SendAction): void;
  recover(): Promise<void>;
  abandon(id: string): Promise<void>;
  stop(invocationId: string | null): Promise<void>;
};

export function Composer(props: {
  session(): ComposerSession | null;
  attach(node: YNode): void;
  commands(target: { sessionId: string | null }): void;
  models: JSX.Element;
  request: JSX.Element;
  stopAction(): () => void;
  chooseWorkspace(): void;
  settings(): void;
}) {
  const hero = () => props.session() === null || props.session()!.empty();
  const blocked = () => props.session()?.blockedReason() ?? '';
  const cannotSend = () =>
    props.session() === null ||
    !!blocked() ||
    (!props.session()?.draft().trim() && !props.session()?.attachments.files().length);
  const sendLabel = () =>
    props.session()?.invocation() != null ? tr('Queue message') : tr('Send message');
  const primaryStops = () => props.session()?.invocation() != null && cannotSend();
  let unbind = () => {};
  cleanup(() => unbind());
  const cardRoot = signal<YNode | null>(null);
  effect(() => {
    const stop = props.stopAction();
    const node = cardRoot();
    if (node) return keymap.bind('escape', stop, { when: 'always', within: node });
  });
  const workspaceLabel = () => {
    const path = props.session()?.workspace();
    return path
      ? (path
          .split(path.startsWith('/') ? '/' : /[\\/]/)
          .filter(Boolean)
          .at(-1) ?? path)
      : tr('Choose workspace');
  };
  return (
    <View
      style={{
        flex: hero() ? 1 : 0,
        flexShrink: 1,
        minHeight: 0,
        justifyContent: 'center',
        width: '100%',
        maxWidth: 832,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingBottom: hero() ? 16 : 8,
      }}
    >
      {props.request}
      <View style={{ flexShrink: 0 }}>
        <If when={hero()}>
          <View style={{ gap: compact() ? 8 : 16, paddingBottom: 12 }}>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                paddingVertical: compact() ? 8 : 16,
              }}
            >
              <If when={windowSize().height >= 336}>
                <Image src={logo} resizeMode="contain" style={{ width: 32, height: 32 }} />
              </If>
              <Text
                style={{
                  color: C.text,
                  fontSize: compact() ? 20 : 26,
                  lineHeight: 32,
                  fontWeight: '500',
                }}
              >
                {tr('Make something remarkable.')}
              </Text>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <Button
                accessibilityLabel={tr('Choose composer workspace')}
                tooltip={props.session()?.workspace() || tr('Choose workspace')}
                onPress={props.chooseWorkspace}
                style={{
                  ...controlStyle,
                  flexDirection: 'row',
                  alignItems: 'center',
                  maxWidth: '100%',
                  minWidth: 0,
                  flexShrink: 1,
                  gap: 8,
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={{ backgroundColor: C.raised }}
              >
                <Icon name="folder" color={C.secondary} />
                <Text numberOfLines={1} style={{ color: C.secondary, fontSize: 13, flexShrink: 1 }}>
                  {workspaceLabel()}
                </Text>
                <Icon name="down" color={C.secondary} />
              </Button>
              <Button
                accessibilityLabel={tr('Connections & models')}
                onPress={props.settings}
                style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ color: C.muted, fontSize: 13 }}>{tr('Connections & models')}</Text>
              </Button>
            </View>
          </View>
        </If>
        <If when={props.session()?.error()}>
          <Text selectable style={{ color: C.danger }}>
            {props.session()?.error()}
          </Text>
        </If>
        <If when={props.session()?.notice()}>
          <Text
            style={{
              color: C.muted,
              fontSize: 12,
              // A single line occupies 32 points: 16 of text, 8 above and 8 below.
              // This keeps the next card's outward cell paint clear of the notice.
              ...(platform.isTerminal ? { lineHeight: 16, paddingVertical: 8 } : { paddingTop: 4 }),
            }}
          >
            {props.session()?.notice()}
          </Text>
        </If>
        <Each of={props.session() ? [props.session()!] : []} key={(session) => session.sessionId}>
          {(session) => {
            const owner = session();
            return (
              <View>
                <ProjectMcp owner={owner.projectMcp} />
                <Checklist sessionId={owner.sessionId} />
                <QueueDock session={owner.queue} />
                <If when={owner.recoverable()}>
                  <Button
                    disabled={owner.recovering()}
                    onPress={inputAction(owner.recover, null)}
                    style={controlStyle}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.line }}
                  >
                    <Text style={{ color: C.warning }}>
                      {owner.recovering()
                        ? tr('Reading original receipts…')
                        : tr('Recover original send receipt')}
                    </Text>
                  </Button>
                </If>
                <Each of={owner.unconfirmed()} key={(id: string) => id}>
                  {(id) => (
                    <Button
                      disabled={owner.recovering()}
                      onPress={inputAction(owner.abandon, id())}
                      style={controlStyle}
                      hoverStyle={{ backgroundColor: C.raised }}
                      focusStyle={{ backgroundColor: C.line }}
                    >
                      <Text style={{ color: C.warning }}>
                        {tr('Abandon unconfirmed send')} · {id().slice(0, 8)}
                      </Text>
                    </Button>
                  )}
                </Each>
              </View>
            );
          }}
        </Each>
        <View
          ref={(node) => {
            cardRoot.set(node);
            unbind();
            unbind = keymap.bind(
              'mod+u',
              () => {
                const owner = props.session();
                if (owner && owner.editable())
                  owner.attachments.open({
                    owner: owner.sessionId,
                    value: !owner.attachments.picker(),
                  });
              },
              { when: 'always', within: node },
            );
          }}
          accessibilityLabel={tr('Conversation composer')}
          style={{
            flexShrink: 0,
            backgroundColor: C.raised,
            borderRadius: compact() ? 16 : 24,
            borderWidth: 1,
            borderColor: C.line,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
            minHeight: hero() && !compact() ? 120 : undefined,
          }}
        >
          <Each
            of={props.session() ? [props.session()!] : [null]}
            key={(owner) => owner?.sessionId ?? 'no-session'}
          >
            {(session) => {
              const owner = session();
              let editor: YNode | undefined;
              const focusEditor = () => {
                if (owner?.editable()) editor?.focus();
              };
              // Undo, selection and queued native events belong to this session.
              // Hero/history and responsive layout never replace this editor.
              return (
                <>
                  {/* A sibling backdrop leaves the Input and toolbar's native
                      pointer owners intact. Native focus retains its selection. */}
                  <View
                    role="button"
                    accessibilityLabel={
                      owner
                        ? tr('Focus message composer')
                        : tr('Choose workspace from composer card')
                    }
                    focusable={owner === null}
                    disabled={owner !== null && !owner.editable()}
                    onPress={owner ? inputAction(focusEditor, null) : props.chooseWorkspace}
                    style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
                    focusStyle={{
                      borderWidth: 1,
                      borderColor: C.accent,
                      borderRadius: compact() ? 16 : 24,
                    }}
                  />
                  <View pointerEvents="box-none" style={{ gap: 8 }}>
                    <If when={owner !== null}>
                      <DraftAttachments draft={owner!.attachments} preview={owner!.previewImage} />
                    </If>
                    <Input
                      ref={(node) => {
                        editor = node;
                        props.attach(node);
                      }}
                      testID="message"
                      accessibilityLabel={tr('Message composer')}
                      autoFocus={owner !== null}
                      pointerEvents={owner ? 'auto' : 'none'}
                      multiline
                      submitBehavior="submit"
                      value={owner?.draft() ?? ''}
                      readonly={!owner?.editable()}
                      onChange={owner?.changeDraft}
                      onSubmit={owner?.submit}
                      placeholder={
                        owner ? tr('Message or run a task…') : tr('Choose a workspace to begin…')
                      }
                      style={{
                        minHeight: hero() && !compact() ? 40 : 24,
                        maxHeight: compact() ? 64 : 144,
                        color: C.text,
                        placeholderColor: C.muted,
                        ...bodyTextStyle,
                      }}
                    />
                  </View>
                </>
              );
            }}
          </Each>
          <View
            pointerEvents="box-none"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <Button
              onPress={inputAction(props.commands, {
                sessionId: props.session()?.sessionId ?? null,
              })}
              accessibilityLabel={tr('Open commands')}
              tooltip={shortcut(tr('Commands'), 'mod+p')}
              style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 16,
              }}
              hoverStyle={{ backgroundColor: C.line }}
              focusStyle={{ backgroundColor: C.line }}
              activeStyle={{ backgroundColor: C.surface }}
            >
              <Icon name="plus" color={C.secondary} />
            </Button>
            <If when={props.session() !== null}>
              <Button
                accessibilityLabel={tr('Attach files')}
                tooltip={shortcut(tr('Attach files'), 'mod+u')}
                disabled={props.session()!.attachments.restoring()}
                onPress={inputAction(props.session()!.attachments.open, {
                  owner: props.session()!.sessionId,
                  value: !props.session()!.attachments.picker(),
                })}
                style={{
                  width: 32,
                  height: 32,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                }}
                hoverStyle={{ backgroundColor: C.line }}
                focusStyle={{ backgroundColor: C.line }}
                activeStyle={{ backgroundColor: C.surface }}
              >
                <Icon name="paperclip" color={C.secondary} />
              </Button>
            </If>
            <SessionPermissionsSelect owner={props.session()?.permissions ?? null} />
            <If when={props.session() !== null}>
              <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0 }}>
                {props.models}
              </View>
            </If>
            <If when={props.session() === null}>
              <View pointerEvents="none" style={{ flex: 1 }} />
            </If>
            <Button
              accessibilityLabel={primaryStops() ? tr('Stop response') : sendLabel()}
              tooltip={primaryStops() ? tr('Stop response · Esc') : `${sendLabel()} · Enter`}
              disabled={primaryStops() ? props.session()!.stopping() : cannotSend()}
              onPress={
                primaryStops()
                  ? inputAction(props.session()!.stop, props.session()!.invocation())
                  : props.session()
                    ? inputAction(props.session()!.sendRendered, {
                        owner: props.session()!.sessionId,
                        text: props.session()!.draft(),
                        backend: props.session()!.backend(),
                        attachments: props.session()!.attachments.ids(),
                      })
                    : undefined
              }
              style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: C.accent,
                borderRadius: 16,
              }}
              hoverStyle={{ backgroundColor: C.accentHover }}
              focusStyle={{ backgroundColor: C.accentHover }}
              activeStyle={{ backgroundColor: C.accent }}
              disabledStyle={{ backgroundColor: C.line }}
            >
              <Icon
                name={primaryStops() ? 'stop' : 'send'}
                color={
                  (primaryStops() ? props.session()!.stopping() : cannotSend())
                    ? C.muted
                    : C.background
                }
              />
            </Button>
          </View>
        </View>
        <View style={{ minHeight: 24, paddingTop: 8 }}>
          <If when={blocked()}>
            <Text style={{ color: C.warning, fontSize: 12, lineHeight: 16 }}>{blocked()}</Text>
          </If>
        </View>
        <If when={props.session()?.metrics()}>
          <Text numberOfLines={1} style={{ color: C.muted, fontSize: 12, paddingTop: 4 }}>
            {props.session()?.metrics()}
          </Text>
        </If>
      </View>
    </View>
  );
}
