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
import { ContextMenu, Input, MenuItem, Popover } from 'nsh/base';
import type { InputRef, JSX, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { platform, windowSize } from 'nsh';
import { keymap } from 'nsh';
import {
  DraftAttachments,
  StagedAttachments,
} from '../../../../products/maka/workbench/app/Attachments';
import { ComposerDetails } from '../../../../products/maka/workbench/app/ComposerDetails';
import { SessionPermissionsSelect } from '../../../../products/maka/workbench/app/SessionPermissionsSelect';
import type { AgentExecution } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type {
  ComposerBackend,
  ComposerSession,
  ComposerViewInput,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import {
  C,
  bodyTextStyle,
  inputTextStyle,
  captionTextStyle,
  compact,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
} from '../../../../products/maka/workbench/app/ui';
import { LoadingIndicator } from '../../../../products/maka/workbench/app/Loading';
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
    style: {
      color: C.accent,
      backgroundColor: `${C.accent}20`,
      borderRadius: 4,
    },
    atomic: true,
  },
];

export function Composer(props: ComposerViewInput<JSX.Element>) {
  const pendingAdd = signal(false);
  const completion = createComposerCompletion({
    session: props.session,
    commands: props.commands,
    active: props.active,
  });
  const predictionEditor = signal<{ owner: ComposerSession; node: InputRef } | null>(null);
  const suggestedMessage = () => {
    const owner = props.session();
    if (
      !owner ||
      !props.active() ||
      props.blocked?.() ||
      !owner.connected() ||
      !owner.editable() ||
      owner.loading() ||
      owner.recovering() ||
      owner.resuming() ||
      owner.invocation() !== null ||
      owner.draft() !== '' ||
      owner.attachments.files().length > 0 ||
      completion.composing() ||
      completion.opened() !== null
    )
      return null;
    return owner.prediction.current();
  };
  const acceptSuggestedMessage = (offered: {
    sessionId: string;
    sourceTurnId: string;
    text: string;
  }) => {
    const owner = props.session();
    const suggestion = suggestedMessage();
    const editor = predictionEditor();
    if (
      completion.composing() ||
      !owner ||
      owner.sessionId !== offered.sessionId ||
      editor?.owner !== owner ||
      suggestion?.sourceTurnId !== offered.sourceTurnId ||
      suggestion.text !== offered.text
    )
      return;
    editor.node.focus();
    editor.node.replaceRange({
      start: 0,
      end: 0,
      text: offered.text,
      expectedText: '',
      expectedSelection: { start: 0, end: 0 },
    });
    owner.prediction.dismiss(offered.sourceTurnId);
  };
  effect(() => {
    const owner = props.session();
    const suggestion = suggestedMessage();
    const editor = predictionEditor();
    if (!owner || !suggestion || editor?.owner !== owner || completion.composing()) return;
    const offered = {
      sessionId: owner.sessionId,
      sourceTurnId: suggestion.sourceTurnId,
      text: suggestion.text,
    };
    const bindings = ['tab', 'right', 'enter'].map((key) =>
      keymap.bind(key, () => acceptSuggestedMessage(offered), {
        when: 'always',
        within: editor.node,
      }),
    );
    return () => bindings.forEach((unbind) => unbind());
  });
  const hero = () => props.session() === null || props.session()!.empty();
  // On the desktop the card's 8-point inset makes its corners concentric with the 32-point round buttons.
  const cardRadius = () => (platform.isTerminal && compact() ? 16 : 24);
  // Desktop only: the terminal keeps its start pane as it is.
  const noConnections = () => !platform.isTerminal && (props.needsConnection?.() ?? false);
  const pending = () => props.pending?.() ?? null;
  let pendingDrop: ((event: { uris: string[] }) => void) | null = null;
  props.dropFiles?.((event) => {
    const owner = props.session();
    if (owner) completion.drop(owner, event);
    else pendingDrop?.(event);
  });
  type Pending = NonNullable<ReturnType<NonNullable<ComposerViewInput<JSX.Element>['pending']>>>;
  let pendingCommand: {
    owner: Pending;
    text: string;
    confirmation: string;
    id: string;
  } | null = null;
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
    owner: string;
    text: string;
    expected: string;
  }) => {
    const current = pending();
    if (current?.id === owner) submitPending(current, text, expected);
  };
  const blocked = () => props.session()?.blockedReason() ?? '';
  const confirming = () =>
    !!props.session()?.loading() ||
    !!props.session()?.recovering() ||
    !!props.session()?.resuming() ||
    !!pending()?.sending();
  const warning = () => (confirming() ? '' : blocked());
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
  const hasContent = () =>
    completion.composing() ||
    !!props.session()?.draft().trim() ||
    !!props.session()?.attachments.files().length;
  const running = () =>
    props.session()?.connected() === true && props.session()?.invocation() != null;
  const resumeSource = () => {
    const value = props.session()?.resumable();
    return !props.session()?.invocation() && !hasContent() && value?.kind === 'ready'
      ? value.source
      : null;
  };
  const stopPrimary = () => running() && !hasContent();
  const sendDisabled = () => cannotSend() || completion.composing();
  const continueDisabled = () =>
    !!props.blocked?.() ||
    !!props.session()?.resuming() ||
    !!blocked() ||
    !props.session()?.editable();
  const primaryDisabled = () =>
    stopPrimary()
      ? props.session()!.stopping()
      : resumeSource() !== null
        ? continueDisabled()
        : sendDisabled();
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
    if (session?.sessionId === owner && props.active() && !continueDisabled())
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
    if (node)
      return keymap.bind(
        'escape',
        () => {
          if (completion.composing()) return;
          const suggestion = suggestedMessage();
          if (suggestion) props.session()!.prediction.dismiss(suggestion.sourceTurnId);
          else stop();
        },
        { when: 'always', within: node },
      );
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
  const primaryButton = () => (
    <View
      role="button"
      focusable
      accessibilityLabel={
        stopPrimary()
          ? props.session()!.stopping()
            ? tr('Stopping…')
            : tr('Stop response')
          : resumeSource() !== null
            ? tr('Continue response')
            : tr('Send message')
      }
      tooltip={textTooltip(() =>
        stopPrimary()
          ? `${tr('Stop response')} · Esc`
          : resumeSource() !== null
            ? tr('Continue response')
            : `${tr('Send message')} · Enter`,
      )}
      disabled={primaryDisabled()}
      onPress={
        stopPrimary()
          ? inputAction(props.session()!.stop, props.session()!.invocation())
          : resumeSource() !== null
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
                  delivery: 'steer',
                })
              : pending()
                ? inputAction(sendPending, {
                    owner: pending()!.id,
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
      <If
        when={stopPrimary() ? props.session()!.stopping() : confirming()}
        else={
          <Icon
            name={stopPrimary() ? 'stop' : resumeSource() !== null ? 'play' : 'send'}
            color={primaryDisabled() ? C.muted : C.background}
          />
        }
      >
        <LoadingIndicator color={C.muted} />
      </If>
    </View>
  );
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
      <If when={hero()}>
        <View style={{ flexShrink: 0, gap: compact() ? 8 : 16, paddingBottom: 12 }}>
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
            <If
              when={props.workspacePicker}
              else={
                <Button
                  accessibilityLabel={tr('Choose composer workspace')}
                  tooltip={textTooltip(
                    () => props.session()?.workspace() || tr('Choose workspace'),
                  )}
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
              }
            >
              {props.workspacePicker}
            </If>
            <If
              when={noConnections()}
              else={
                <Button
                  accessibilityLabel={tr('Connections & models')}
                  onPress={props.settings}
                  style={{
                    ...controlStyle,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={{ backgroundColor: C.surface }}
                  focusStyle={{ backgroundColor: C.raised }}
                >
                  <Text style={{ color: C.muted, fontSize: 13 }}>{tr('Connections & models')}</Text>
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
                <Text
                  style={{
                    color: C.background,
                    fontSize: 13,
                    fontWeight: '600',
                  }}
                >
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
      {props.request}
      <View style={{ flexShrink: 0 }}>
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
            borderColor: fileDragging() ? C.accent : platform.isTerminal ? C.line : C.raised,
            ...(platform.isTerminal
              ? {
                  paddingHorizontal: 16,
                  paddingTop: 12,
                  paddingBottom: 8,
                  gap: 12,
                }
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
              if (local && paste) {
                const drop = (event: { uris: string[] }) => paste.drop(local, event);
                pendingDrop = drop;
                cleanup(() => {
                  if (pendingDrop === drop) pendingDrop = null;
                });
              }
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
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                    }}
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
                        : {
                            gap: 8,
                            flexGrow: 1,
                            paddingHorizontal: 8,
                            paddingTop: 4,
                          },
                      { pointerEvents: 'box-none' },
                    ]}
                  >
                    <If when={owner !== null}>
                      <DraftAttachments draft={owner!.attachments} preview={owner!.previewImage} />
                    </If>
                    <If when={local !== null}>
                      <StagedAttachments
                        files={local?.files() ?? []}
                        remove={(id) => local?.removeFile(id)}
                      />
                      <If when={local?.picking()}>
                        <Input
                          accessibilityLabel={tr('Attachment path')}
                          placeholder={tr('Absolute file path…')}
                          style={{
                            ...inputTextStyle,
                            height: 32,
                            paddingHorizontal: 8,
                            borderWidth: 1,
                            borderRadius: 6,
                            borderColor: C.line,
                            color: C.text,
                            placeholderColor: C.muted,
                          }}
                          focusStyle={{ borderColor: C.accent }}
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
                    <View
                      style={{
                        minHeight: hero() && !compact() ? 40 : 24,
                        maxHeight: compact() ? 64 : 144,
                      }}
                    >
                      <Input
                        ref={(node) => {
                          editor.set(node);
                          props.attach(node);
                          completion.attach(owner?.sessionId ?? null, node);
                          predictionEditor.set(owner ? { owner, node } : null);
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
                            ? (event) => {
                                const suggestion = suggestedMessage();
                                if (suggestion && event.text === '')
                                  acceptSuggestedMessage({
                                    sessionId: owner.sessionId,
                                    sourceTurnId: suggestion.sourceTurnId,
                                    text: suggestion.text,
                                  });
                                else completion.submit(owner, event);
                              }
                            : local
                              ? (event) => submitPending(local, event.text)
                              : undefined
                        }
                        placeholder={
                          suggestedMessage() !== null
                            ? ''
                            : owner || local
                              ? tr('Message or run a task…')
                              : tr('Choose a workspace to begin…')
                        }
                        style={[
                          {
                            minHeight: 0,
                            flexGrow: 1,
                            flexShrink: 1,
                            color: C.text,
                            placeholderColor: C.muted,
                            ...bodyTextStyle,
                            ...(owner !== null && suggestedMessage() !== null
                              ? {
                                  position: 'absolute',
                                  top: 0,
                                  bottom: 0,
                                  left: 0,
                                  right: 0,
                                }
                              : {}),
                          },
                          { pointerEvents: owner || local ? 'auto' : 'none' },
                        ]}
                      />
                      <If when={owner !== null && suggestedMessage() !== null}>
                        <Text
                          accessibilityLabel={tr('Suggested message: {message}', {
                            message: suggestedMessage()!.text,
                          })}
                          style={[
                            { ...bodyTextStyle, color: `${C.muted}80`, minHeight: 24 },
                            { pointerEvents: 'box-none' },
                          ]}
                        >
                          {suggestedMessage()!.text}{' '}
                          <Button
                            accessibilityLabel={tr('Use suggested message')}
                            tooltip={textTooltip(() => tr('Tab to use · Esc to dismiss'))}
                            onPress={inputAction(acceptSuggestedMessage, {
                              sessionId: owner!.sessionId,
                              sourceTurnId: suggestedMessage()!.sourceTurnId,
                              text: suggestedMessage()!.text,
                            })}
                            style={{
                              height: 24,
                              paddingHorizontal: 8,
                              borderRadius: 4,
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: `${C.text}08`,
                              verticalAlign: 'middle',
                              pointerEvents: 'auto',
                            }}
                            hoverStyle={controlHoverStyle()}
                            focusStyle={controlFocusStyle()}
                          >
                            <Text style={{ ...captionTextStyle, color: `${C.muted}80` }}>
                              {tr('Press Tab to accept')}
                            </Text>
                          </Button>
                        </Text>
                      </If>
                    </View>
                  </View>
                </>
              );
            }}
          </Each>
          <View
            style={[
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: platform.isTerminal ? 8 : 4,
              },
              { pointerEvents: 'box-none' },
            ]}
          >
            <Popover
              open={pending() !== null && pendingAdd()}
              onOpenChange={({ open }) => pendingAdd.set(open)}
              placement="top"
              align="start"
              offset={8}
              margin={8}
              popupStyle={{
                width: 240,
                padding: 8,
                backgroundColor: C.surface,
                borderRadius: 12,
              }}
              trigger={
                <Button
                  ref={completion.addButton}
                  onPress={
                    pending()
                      ? inputAction(() => pendingAdd.set(!pendingAdd()), null)
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
              }
            >
              <Button
                accessibilityLabel={tr('Attach files')}
                onPress={inputAction(() => {
                  pendingAdd.set(false);
                  pending()?.openPicker(true);
                }, null)}
                style={controlStyle}
                hoverStyle={{ backgroundColor: C.raised }}
                focusStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ color: C.text }}>{tr('Attach files')}</Text>
              </Button>
              <Each
                of={props.commands().filter((command) => command.trigger === 'goal')}
                key={(command) => command.id}
              >
                {(item) => (
                  <Button
                    accessibilityLabel={item().title}
                    onPress={inputAction(() => {
                      pendingAdd.set(false);
                      return item().run();
                    }, null)}
                    style={controlStyle}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.raised }}
                  >
                    <Text style={{ color: C.text }}>{item().title}</Text>
                  </Button>
                )}
              </Each>
            </Popover>
            <SessionPermissionsSelect
              owner={props.session()?.permissions ?? null}
              pending={pending()?.permissions ?? null}
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
            <If when={running() && hasContent()} else={primaryButton()}>
              <ContextMenu
                offset={8}
                margin={8}
                popupStyle={{ padding: 8, backgroundColor: C.surface, borderRadius: 12 }}
                trigger={primaryButton()}
              >
                <Each
                  of={running() && hasContent() ? [props.session()!] : []}
                  key={(owner) => owner.sessionId}
                >
                  {(owner) => (
                    <>
                      <MenuItem
                        accessibilityLabel={tr('Add to queue')}
                        tooltip={textTooltip(() => tr('Send after this turn'))}
                        disabled={sendDisabled() || completion.isCommand()}
                        onSelect={inputAction(completion.send, {
                          owner: owner().sessionId,
                          text: owner().draft(),
                          backend: owner().backend(),
                          attachments: owner().attachments.ids(),
                          delivery: 'queue' as const,
                        })}
                        style={{
                          ...controlStyle,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                        hoverStyle={{ backgroundColor: C.raised }}
                        focusStyle={controlFocusStyle()}
                      >
                        <Icon name="queue" color={C.secondary} />
                        <Text style={{ ...captionTextStyle, color: C.text }}>
                          {tr('Add to queue')}
                        </Text>
                      </MenuItem>
                      <MenuItem
                        accessibilityLabel={
                          owner().stopping() ? tr('Stopping…') : tr('Stop response')
                        }
                        tooltip={textTooltip(() => `${tr('Stop response')} · Esc`)}
                        disabled={owner().stopping()}
                        onSelect={inputAction(owner().stop, owner().invocation())}
                        style={{
                          ...controlStyle,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                        hoverStyle={{ backgroundColor: C.raised }}
                        focusStyle={controlFocusStyle()}
                      >
                        <Icon name="stop" color={C.secondary} />
                        <Text style={{ ...captionTextStyle, color: C.text }}>
                          {tr('Stop response')}
                        </Text>
                      </MenuItem>
                    </>
                  )}
                </Each>
              </ContextMenu>
            </If>
          </View>
          <If when={fileDragging()}>
            <FileDropHint radius={cardRadius()} />
          </If>
          <ComposerCompletion state={completion} />
        </View>
        {/* The terminal reserves the warning row so the composer never jumps; the
            desktop shows it only when there is a warning, so no empty band sits
            under the box. */}
        <If when={platform.isTerminal || (props.session()?.connected() && warning())}>
          <View style={{ minHeight: 24, paddingTop: 8 }}>
            <If when={props.session()?.connected() && warning()}>
              <Text style={{ color: C.warning, fontSize: 12, lineHeight: 16 }}>{warning()}</Text>
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
