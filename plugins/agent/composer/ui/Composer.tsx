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

import { textTooltip } from '../../../../products/maka/workbench/app/ui';
import { ProjectMcp } from '../../../../products/maka/workbench/app/ProjectMcpConsent';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { cleanup, effect, inputAction, signal, Text, View, Image } from 'nsh';
import { Input } from 'nsh/base';
import type { InputRef, JSX, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { platform, windowSize } from 'nsh';
import { keymap } from 'nsh';
import { DraftAttachments } from '../../../../products/maka/workbench/app/Attachments';
import { ComposerDetails } from '../../../../products/maka/workbench/app/ComposerDetails';
import { SessionPermissionsSelect } from '../../../../products/maka/workbench/app/SessionPermissionsSelect';
import { PlanModeToggle } from '../../../../products/maka/workbench/app/PlanModeToggle';
import type { AgentExecution } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type {
  ComposerBackend,
  ComposerViewInput,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import {
  C,
  bodyTextStyle,
  compact,
  controlStyle,
} from '../../../../products/maka/workbench/app/ui';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { ContextGauge } from '../../../../products/maka/workbench/app/ContextGauge';
import { FileDropHint } from '../../../../products/maka/workbench/app/FileDropHint';
import { matchComposerCommand } from '../../../../products/maka/workbench/app/composerCommands';
import { ComposerCompletion, createComposerCompletion } from './ComposerCompletion';
import { createComposerPaste } from './composerPaste';
import logo from '../../../../products/maka/workbench/app/assets/maka.png';

// Match the skill invocation grammar; the surrounding whitespace is not part of the chip.
const skillTokens = () => [
  {
    pattern: String.raw`(?:^|[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])(?P<token>/skill:[A-Za-z0-9._-]+)`,
    style: { color: C.accent, backgroundColor: `${C.accent}20`, borderRadius: 4 },
    atomic: true,
  },
];

export function Composer(props: ComposerViewInput<JSX.Element>) {
  const completion = createComposerCompletion({
    session: props.session,
    commands: props.commands,
    active: props.active,
  });
  // Files dropped on the conversation attach as they do on the field.
  props.dropFiles?.((event) => {
    const owner = props.session();
    if (owner) completion.drop(owner, event);
    else pending()?.selectFiles(event.uris);
  });
  const hero = () => props.session() === null || props.session()!.empty();
  // On the desktop the card's 8-point inset makes its corners concentric with the 32-point round buttons.
  const cardRadius = () => (platform.isTerminal && compact() ? 16 : 24);
  // Desktop only: the terminal keeps its start pane as it is.
  const noConnections = () => !platform.isTerminal && (props.needsConnection?.() ?? false);
  const pending = () => props.pending?.() ?? null;
  type Pending = NonNullable<ReturnType<NonNullable<ComposerViewInput<JSX.Element>['pending']>>>;
  let pendingCommand: { owner: Pending; text: string; confirmation: string; id: string } | null =
    null;
  const submitPending = (owner: Pending, text: string, expected?: string) => {
    if (
      pending() !== owner ||
      !props.active() ||
      owner.sending() ||
      completion.composing() ||
      owner.draft() !== text ||
      (expected !== undefined && owner.confirmation() !== expected)
    )
      return;
    const command = matchComposerCommand(props.commands(), text);
    if (!command) {
      owner.submit(text, expected);
      return;
    }
    const confirmation = owner.confirmation();
    if (
      pendingCommand?.owner === owner &&
      pendingCommand.text === text &&
      pendingCommand.confirmation === confirmation &&
      pendingCommand.id === command.found.id
    )
      return;
    const ticket = { owner, text, confirmation, id: command.found.id };
    pendingCommand = ticket;
    const finish = (accepted: void | boolean) => {
      if (pendingCommand === ticket) pendingCommand = null;
      if (accepted !== false && pending() === owner && owner.confirmation() === confirmation)
        owner.changeDraft('');
    };
    try {
      const result = command.found.run(command.argument || undefined);
      if (result instanceof Promise)
        void result.then(finish, (reason) => {
          if (pendingCommand === ticket) pendingCommand = null;
          throw reason;
        });
      else finish(result);
    } catch (reason) {
      if (pendingCommand === ticket) pendingCommand = null;
      throw reason;
    }
  };
  const sendPending = ({
    owner,
    text,
    expected,
  }: {
    owner: Pending;
    text: string;
    expected: string;
  }) => {
    submitPending(owner, text, expected);
  };
  const togglePendingPicker = ({ owner, open }: { owner: Pending; open: boolean }) => {
    if (pending() === owner && owner.picking() === open) owner.openPicker(!open);
  };
  const blocked = () => props.session()?.blockedReason() ?? '';
  const cannotSend = () =>
    props.blocked?.() ||
    (props.session() === null &&
      (pending() === null ||
        pending()!.sending() ||
        !pending()!.ready() ||
        (!pending()!.draft().trim() && !pending()!.files().length))) ||
    (props.session() !== null && !props.session()!.editable()) ||
    (!completion.isCommand() &&
      (!!blocked() ||
        (!props.session()?.draft().trim() &&
          !props.session()?.attachments.files().length &&
          !pending()?.draft().trim() &&
          !pending()?.files().length)));
  const sendLabel = () =>
    props.session()?.invocation() != null ? tr('Queue message') : tr('Send message');
  const hasContent = () =>
    !!props.session()?.draft().trim() || !!props.session()?.attachments.files().length;
  const primaryStops = () =>
    props.session()?.connected() === true && props.session()?.invocation() != null && !hasContent();
  const resumeSource = () => {
    const value = props.session()?.resumable();
    return !props.session()?.invocation() && !hasContent() && value?.kind === 'ready'
      ? value.source
      : null;
  };
  const primaryLabel = () =>
    primaryStops() ? tr('Pause response') : resumeSource() ? tr('Continue response') : sendLabel();
  const primaryDisabled = () =>
    primaryStops()
      ? props.session()!.stopping()
      : !!props.blocked?.() ||
        !!props.session()?.resuming() ||
        (resumeSource() ? !!blocked() || !props.session()!.editable() : cannotSend());
  const continueRendered = ({
    owner,
    source,
    backend,
  }: {
    owner: string;
    source: AgentExecution;
    backend: ComposerBackend;
  }) => {
    const session = props.session();
    if (session?.sessionId === owner && props.active() && !primaryDisabled())
      void session.resume(source, backend);
  };
  let unbind = () => {};
  cleanup(() => unbind());
  const cardRoot = signal<ViewRef | null>(null);
  // A file drag over the editor leaves the conversation's own drop target.
  const draggingOverEditor = signal(false);
  const fileDragging = () =>
    !platform.isTerminal &&
    (props.session() !== null || pending() !== null) &&
    (draggingOverEditor() || (props.fileDragging?.() ?? false));
  effect(() => {
    const owner = props.session();
    const node = cardRoot();
    if (node && props.active() && owner?.editable() && owner.invocation() === null && owner.draft())
      return keymap.bind('ctrl+c', completion.clearDraft, {
        when: 'always',
        within: node,
        fallback: true,
      });
  });
  effect(() => {
    const stop = props.stopAction();
    const node = cardRoot();
    if (node) return keymap.bind('escape', stop, { when: 'always', within: node });
  });
  const workspaceLabel = () => {
    const path = props.session()?.workspace() ?? pending()?.workspace();
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
        flex: hero() ? 1 : 'initial',
        flexShrink: 1,
        minHeight: 0,
        justifyContent: 'center',
        width: '100%',
        // The conversation column's width: the box lines up with the
        // messages and the turn navigation beside them.
        maxWidth: 800,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingTop: hero() || platform.isTerminal ? 0 : 12,
        paddingBottom: hero() || !platform.isTerminal ? 16 : 8,
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
                <Image src={logo} style={[{ width: 32, height: 32 }, { objectFit: 'contain' }]} />
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
                tooltip={textTooltip(() => props.session()?.workspace() || tr('Choose workspace'))}
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
                <Text
                  style={[
                    { color: C.secondary, fontSize: 13, flexShrink: 1 },
                    { numberOfLines: 1 },
                  ]}
                >
                  {workspaceLabel()}
                </Text>
                <Icon name="down" color={C.secondary} />
              </Button>
              <If
                when={noConnections()}
                else={
                  <Button
                    accessibilityLabel={tr('Connections & models')}
                    onPress={props.settings}
                    style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={{ backgroundColor: C.raised }}
                  >
                    <Text style={{ color: C.muted, fontSize: 13 }}>
                      {tr('Connections & models')}
                    </Text>
                  </Button>
                }
              >
                <Button
                  accessibilityLabel={tr('Add a model connection')}
                  onPress={props.settings}
                  style={{
                    ...controlStyle,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    backgroundColor: C.accent,
                  }}
                  hoverStyle={{ backgroundColor: C.accentHover }}
                  focusStyle={{ backgroundColor: C.accentHover }}
                >
                  <Text style={{ color: C.background, fontSize: 13, fontWeight: '600' }}>
                    {tr('Add a model connection')}
                  </Text>
                </Button>
              </If>
            </View>
            <If when={noConnections()}>
              <Text style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>
                {tr(
                  'Conversations need a model. Add a connection with your API key or account first.',
                )}
              </Text>
            </If>
          </View>
        </If>
        <If when={props.session()?.error()}>
          <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
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
                <ComposerDetails session={owner} />
                <If when={owner.recoverable()}>
                  <Button
                    disabled={!owner.connected() || owner.recovering()}
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
                      disabled={!owner.connected() || owner.recovering()}
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
                else if (pending()) pending()!.openPicker(!pending()!.picking());
              },
              { when: 'always', within: node },
            );
          }}
          accessibilityLabel={tr('Conversation composer')}
          style={{
            flexShrink: 0,
            backgroundColor: C.raised,
            borderRadius: cardRadius(),
            borderWidth: 1,
            borderColor: fileDragging() ? C.accent : C.line,
            ...(platform.isTerminal
              ? { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 12 }
              : { padding: 8, gap: 8 }),
            minHeight: hero() && !compact() ? 120 : undefined,
          }}
        >
          <Each
            of={props.session() ? [props.session()!] : (pending(), [null])}
            key={(owner) => owner?.sessionId ?? pending()?.id ?? 'no-session'}
          >
            {(session) => {
              const owner = session();
              const local = owner === null ? pending() : null;
              const path = signal('');
              const editor = signal<InputRef | null>(null);
              const selection = signal({ start: 0, end: 0 });
              const paste = local
                ? createComposerPaste({
                    owner: pending,
                    active: props.active,
                    editor: (target) => (target === local ? editor() : null),
                    selection,
                    composing: completion.composing,
                    dismiss: completion.close,
                  })
                : null;
              const focusEditor = () => {
                if (owner?.editable() || local) editor()?.focus();
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
                      owner || local
                        ? tr('Focus message composer')
                        : tr('Choose workspace from composer card')
                    }
                    focusable={owner === null && local === null}
                    disabled={owner !== null && !owner.editable()}
                    onPress={
                      owner || local ? inputAction(focusEditor, null) : props.chooseWorkspace
                    }
                    style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
                    focusStyle={{
                      borderWidth: 1,
                      borderColor: C.accent,
                      borderRadius: cardRadius(),
                    }}
                  />
                  <View
                    style={[
                      platform.isTerminal
                        ? { gap: 8 }
                        : { gap: 8, flexGrow: 1, paddingHorizontal: 8, paddingTop: 4 },
                      { pointerEvents: 'box-none' },
                    ]}
                  >
                    <If when={owner !== null}>
                      <DraftAttachments draft={owner!.attachments} preview={owner!.previewImage} />
                    </If>
                    <If when={local !== null}>
                      <Each of={local?.files() ?? []} key={(file) => file.id}>
                        {(file) => (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ color: C.secondary }}>{file().name}</Text>
                            <Button
                              accessibilityLabel={tr('Remove attachment {name}', {
                                name: file().name,
                              })}
                              onPress={() => local?.removeFile(file().id)}
                              style={controlStyle}
                            >
                              <Icon name="close" color={C.secondary} />
                            </Button>
                          </View>
                        )}
                      </Each>
                      <If when={local?.picking()}>
                        <Input
                          accessibilityLabel={tr('Attachment path')}
                          placeholder={tr('Absolute file path…')}
                          autoFocus
                          value={path()}
                          onChange={({ value }) => path.set(value)}
                          onSubmit={() => {
                            if (path().trim()) local?.selectFiles([path().trim()]);
                          }}
                        />
                        <Button
                          onPress={() => {
                            if (path().trim()) local?.selectFiles([path().trim()]);
                          }}
                          style={controlStyle}
                        >
                          <Text style={{ color: C.secondary }}>{tr('Upload selected file')}</Text>
                        </Button>
                      </If>
                    </If>
                    <Input
                      ref={(node) => {
                        editor.set(node);
                        props.attach(node);
                        completion.attach(owner?.sessionId ?? null, node);
                      }}
                      testID="message"
                      accessibilityLabel={tr('Message composer')}
                      autoFocus={owner !== null || local !== null}
                      multiline
                      submitBehavior="submit"
                      tokens={skillTokens()}
                      value={owner?.draft() ?? local?.draft() ?? ''}
                      readonly={owner ? !owner.editable() : !local || local.sending()}
                      onChange={
                        owner
                          ? ({ value }) => completion.change(owner, value)
                          : local
                            ? ({ value }) => local.changeDraft(value)
                            : undefined
                      }
                      onPaste={
                        owner
                          ? (event) => completion.paste(owner, event)
                          : local
                            ? (event) => paste?.paste(local, event)
                            : undefined
                      }
                      onFileDrop={
                        owner
                          ? (event) => {
                              draggingOverEditor.set(false);
                              completion.drop(owner, event);
                            }
                          : local
                            ? (event) => {
                                draggingOverEditor.set(false);
                                paste?.drop(local, event);
                              }
                            : undefined
                      }
                      onFileDragEnter={
                        owner || local ? () => draggingOverEditor.set(true) : undefined
                      }
                      onFileDragLeave={
                        owner || local ? () => draggingOverEditor.set(false) : undefined
                      }
                      onFocus={
                        owner
                          ? () => completion.pasteFocus(owner)
                          : local
                            ? () => paste?.focus(local)
                            : undefined
                      }
                      onBlur={
                        owner
                          ? () => completion.pasteBlur(owner)
                          : local
                            ? () => paste?.blur(local)
                            : undefined
                      }
                      onSelectionChange={
                        owner
                          ? (event) => completion.selection(owner, event)
                          : local
                            ? (event) => {
                                selection.set({ ...event });
                              }
                            : undefined
                      }
                      onCaretMove={owner ? (event) => completion.caret(owner, event) : undefined}
                      onCompositionChange={
                        owner || local
                          ? (event) => {
                              if (owner || pending() === local)
                                completion.composition(owner, event);
                            }
                          : undefined
                      }
                      onSubmit={
                        owner
                          ? (event) => completion.submit(owner, event)
                          : local
                            ? (event) => submitPending(local, event.text)
                            : undefined
                      }
                      placeholder={
                        owner || local
                          ? tr('Message or run a task…')
                          : tr('Choose a workspace to begin…')
                      }
                      style={[
                        {
                          minHeight: hero() && !compact() ? 40 : 24,
                          maxHeight: compact() ? 64 : 144,
                          color: C.text,
                          placeholderColor: C.muted,
                          ...bodyTextStyle,
                        },
                        { pointerEvents: owner || local ? 'auto' : 'none' },
                      ]}
                    />
                  </View>
                </>
              );
            }}
          </Each>
          <View
            style={[
              { flexDirection: 'row', alignItems: 'center', gap: platform.isTerminal ? 8 : 4 },
              { pointerEvents: 'box-none' },
            ]}
          >
            <Button
              ref={completion.addButton}
              onPress={
                pending()
                  ? inputAction(togglePendingPicker, {
                      owner: pending()!,
                      open: pending()!.picking(),
                    })
                  : inputAction(completion.toggleAdd, {
                      sessionId: props.session()?.sessionId ?? null,
                    })
              }
              accessibilityLabel={tr('Add to message')}
              tooltip={textTooltip(() => tr('Add to message'))}
              disabled={
                pending()
                  ? pending()!.sending() || !pending()!.ready()
                  : !props.session()?.editable() || completion.composing()
              }
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
            <SessionPermissionsSelect
              owner={props.session()?.permissions ?? null}
              pending={pending()?.permissions ?? null}
            />
            <PlanModeToggle
              plan={props.session()?.plan ?? null}
              pending={pending()?.permissions ?? null}
              busy={props.session()?.invocation() != null}
            />
            <If when={props.session() !== null || pending() !== null}>
              <View
                style={[
                  platform.isTerminal
                    ? { flex: 1, minWidth: 0 }
                    : {
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                        gap: 4,
                      },
                  { pointerEvents: 'box-none' },
                ]}
              >
                {/* The desktop shows context use beside the model; the terminal
                    keeps it in the line under the composer. */}
                <If when={!platform.isTerminal && props.session()?.contextUsage?.()}>
                  <ContextGauge usage={() => props.session()!.contextUsage!()!} />
                </If>
                {props.models}
              </View>
            </If>
            <If when={props.session() === null && pending() === null}>
              <View style={[{ flex: 1 }, { pointerEvents: 'none' }]} />
            </If>
            <Button
              accessibilityLabel={primaryLabel()}
              tooltip={textTooltip(() =>
                primaryStops() ? `${tr('Pause response')} · Esc` : `${primaryLabel()} · Enter`,
              )}
              disabled={primaryDisabled()}
              onPress={
                primaryStops()
                  ? inputAction(props.session()!.stop, props.session()!.invocation())
                  : resumeSource()
                    ? inputAction(continueRendered, {
                        owner: props.session()!.sessionId,
                        source: resumeSource()!,
                        backend: props.session()!.backend(),
                      })
                    : props.session()
                      ? inputAction(completion.send, {
                          owner: props.session()!.sessionId,
                          text: props.session()!.draft(),
                          backend: props.session()!.backend(),
                          attachments: props.session()!.attachments.ids(),
                        })
                      : pending()
                        ? inputAction(sendPending, {
                            owner: pending()!,
                            text: pending()!.draft(),
                            expected: pending()!.confirmation(),
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
                name={primaryStops() ? 'pause' : resumeSource() ? 'play' : 'send'}
                color={primaryDisabled() ? C.muted : C.background}
              />
            </Button>
          </View>
          <If when={fileDragging()}>
            <FileDropHint radius={cardRadius()} />
          </If>
          <ComposerCompletion state={completion} />
        </View>
        {/* The terminal reserves the warning row so the composer never jumps; the
            desktop shows it only when there is a warning, so no empty band sits
            under the box. */}
        <If when={platform.isTerminal || (props.session()?.connected() && blocked())}>
          <View style={{ minHeight: 24, paddingTop: 8 }}>
            <If when={props.session()?.connected() && blocked()}>
              <Text style={{ color: C.warning, fontSize: 12, lineHeight: 16 }}>{blocked()}</Text>
            </If>
          </View>
        </If>
        <If when={platform.isTerminal && props.session()?.metrics()}>
          <Text style={[{ color: C.muted, fontSize: 12, paddingTop: 4 }, { numberOfLines: 1 }]}>
            {props.session()?.metrics()}
          </Text>
        </If>
      </View>
    </View>
  );
}
