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
import { ContextMenu, Input, MenuItem } from 'nsh/base';
import type { JSX, ViewRef } from 'nsh';
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
  controlStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuRowHoverStyle,
  menuRowStyle,
  toolbarControlStyle,
} from '../../../../products/maka/workbench/app/ui';
import { LoadingIndicator } from '../../../../products/maka/workbench/app/Loading';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { ContextGauge } from '../../../../products/maka/workbench/app/ContextGauge';
import { FileDropHint } from '../../../../products/maka/workbench/app/FileDropHint';
import { ComposerCompletion, createComposerCompletion } from './ComposerCompletion';
import { createComposerPaste } from './composerPaste';
import { SkillInput } from '../../../../products/maka/workbench/app/SkillInput';
import type { ComposerEditor } from '../../../../products/maka/workbench/app/ComposerEditor';
import logo from '../../../../products/maka/workbench/app/assets/maka.png';

export function Composer(props: ComposerViewInput<JSX.Element>) {
  const completion = createComposerCompletion({
    session: props.session,
    pending: () => props.pending?.() ?? null,
    commands: props.commands,
    active: props.active,
  });
  const predictionEditor = signal<{ owner: ComposerSession; node: ComposerEditor } | null>(null);
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
      owner.continuing() ||
      owner.run() !== null ||
      owner.draft() !== '' ||
      owner.attachments.restoring() ||
      owner.attachments.files().length > 0 ||
      !!owner.quotes().length ||
      owner.attachments.rows().length > 0 ||
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
      editor.node.bindKey(key, () => acceptSuggestedMessage(offered)),
    );
    return () => bindings.forEach((unbind) => unbind());
  });
  const hero = () => props.session() === null || props.session()!.empty();
  // On the desktop the card's 8-point inset makes its corners concentric with the 32-point round buttons.
  const cardRadius = () => (platform.idiom === 'terminal' && compact() ? 16 : 24);
  // Desktop only: the terminal keeps its start pane as it is.
  const noConnections = () => platform.idiom !== 'terminal' && (props.needsConnection?.() ?? false);
  const pending = () => props.pending?.() ?? null;
  // External CLIs run outside the session sandbox, so its setting would not apply to them.
  const externalAgent = () => {
    const backend = props.session() ? props.session()!.backend() : (pending()?.backend() ?? null);
    return backend?.kind === 'executor' && backend.selection.executor === 'external';
  };
  let pendingDrop: ((event: { uris: string[] }) => void) | null = null;
  props.dropFiles?.((event) => {
    const owner = props.session();
    if (owner) completion.drop(owner, event);
    else pendingDrop?.(event);
  });
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
    if (current?.id === owner) completion.submitPending(current, text, expected);
  };
  const blocked = () => props.session()?.blockedReason() ?? '';
  const confirming = () =>
    !!props.session()?.loading() ||
    !!props.session()?.recovering() ||
    !!props.session()?.continuing() ||
    !!pending()?.sending();
  const warning = () => (confirming() ? '' : blocked());
  const cannotSend = () =>
    props.blocked?.() ||
    (props.session() === null &&
      (pending() === null ||
        pending()!.sending() ||
        (!completion.isCommand() && !pending()!.ready()) ||
        (!pending()!.draft().trim() && !pending()!.files().length))) ||
    (props.session() !== null && !props.session()!.editable()) ||
    (!completion.isCommand() &&
      (!!blocked() ||
        (!props.session()?.draft().trim() &&
          !props.session()?.attachments.files().length &&
          !props.session()?.quotes().length &&
          !pending()?.draft().trim() &&
          !pending()?.files().length)));
  const hasContent = () =>
    completion.composing() ||
    !!props.session()?.draft().trim() ||
    !!props.session()?.attachments.files().length ||
    !!props.session()?.quotes().length;
  const running = () => props.session()?.connected() === true && props.session()?.run() != null;
  const continuationSource = () => {
    const value = props.session()?.continuation();
    return !props.session()?.run() && !hasContent() && value ? value.source : null;
  };
  const stopPrimary = () => running() && !hasContent();
  const sendDisabled = () => cannotSend() || completion.composing();
  const continueDisabled = () =>
    !!props.blocked?.() ||
    !!props.session()?.continuing() ||
    !!blocked() ||
    !props.session()?.editable();
  const primaryDisabled = () =>
    stopPrimary()
      ? props.session()!.stopping()
      : continuationSource() !== null
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
      void session.continueRun(source, backend);
  };
  let unbind = () => {};
  cleanup(() => unbind());
  const cardRoot = signal<ViewRef | null>(null);
  const toggleAttachments = () => {
    const owner = props.session();
    if (owner && owner.editable())
      owner.attachments.open({ owner: owner.sessionId, value: !owner.attachments.picker() });
    else if (pending()) pending()!.openPicker(!pending()!.picking());
  };
  // A file drag over the editor leaves the conversation's own drop target.
  const draggingOverEditor = signal(false);
  const fileDragging = () =>
    platform.idiom !== 'terminal' &&
    (props.session() !== null || pending() !== null) &&
    (draggingOverEditor() || (props.fileDragging?.() ?? false));
  const controlCClearsDraft =
    platform.idiom === 'terminal' || keymap.label('mod+c') !== keymap.label('ctrl+c');
  effect(() => {
    const owner = props.session();
    const node = cardRoot();
    if (
      controlCClearsDraft &&
      node &&
      props.active() &&
      owner?.editable() &&
      owner.run() === null &&
      owner.draft()
    )
      return keymap.bind('ctrl+c', completion.clearDraft, {
        when: 'notEditing',
        within: node,
        fallback: true,
      });
  });
  effect(() => {
    const owner = props.session();
    const current = predictionEditor();
    if (
      controlCClearsDraft &&
      owner &&
      current?.owner === owner &&
      props.active() &&
      owner.editable() &&
      owner.run() === null &&
      owner.draft()
    )
      return current.node.bindKey('ctrl+c', completion.clearDraft, { fallback: true });
  });
  const escapeComposer = () => {
    if (completion.composing()) return;
    const suggestion = suggestedMessage();
    if (suggestion) props.session()!.prediction.dismiss(suggestion.sourceTurnId);
    else props.stopAction()();
  };
  effect(() => {
    const node = cardRoot();
    if (node) return keymap.bind('escape', escapeComposer, { when: 'notEditing', within: node });
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
  const workspaceControl = () => (
    <If
      when={props.workspacePicker}
      else={
        <Button
          accessibilityLabel={tr('Choose composer workspace')}
          tooltip={textTooltip(() => props.session()?.workspace() || tr('Choose workspace'))}
          onPress={props.chooseWorkspace}
          style={{
            ...(platform.idiom === 'terminal' ? controlStyle : toolbarControlStyle),
            flexDirection: 'row',
            alignItems: 'center',
            maxWidth: '100%',
            minWidth: 0,
            flexShrink: 1,
            gap: platform.idiom === 'terminal' ? 8 : 4,
          }}
          hoverStyle={{ backgroundColor: platform.idiom === 'terminal' ? C.card : C.line }}
          focusStyle={{ backgroundColor: platform.idiom === 'terminal' ? C.raised : C.line }}
        >
          <Icon name="folder" color={platform.idiom === 'terminal' ? C.secondary : C.muted} />
          <Text
            style={[
              { ...captionTextStyle, color: C.secondary, flexShrink: 1 },
              { numberOfLines: 1 },
            ]}
          >
            {workspaceLabel()}
          </Text>
          <Icon name="down" color={platform.idiom === 'terminal' ? C.secondary : C.muted} />
        </Button>
      }
    >
      {props.workspacePicker}
    </If>
  );
  const primaryButton = () => (
    <View
      role="button"
      focusable
      accessibilityLabel={
        stopPrimary()
          ? props.session()!.stopping()
            ? tr('Stopping…')
            : tr('Stop response')
          : continuationSource() !== null
            ? tr('Continue response')
            : tr('Send message')
      }
      tooltip={textTooltip(() =>
        stopPrimary()
          ? `${tr('Stop response')} · Esc`
          : continuationSource() !== null
            ? tr('Continue response')
            : `${tr('Send message')} · Enter`,
      )}
      disabled={primaryDisabled()}
      onPress={
        stopPrimary()
          ? inputAction(props.session()!.stop, props.session()!.run())
          : continuationSource() !== null
            ? inputAction(continueRendered, {
                owner: props.session()!.sessionId,
                source: continuationSource()!,
                backend: props.session()!.backend(),
              })
            : props.session()
              ? inputAction(completion.send, {
                  owner: props.session()!.sessionId,
                  text: props.session()!.draft(),
                  backend: props.session()!.backend(),
                  attachments: props.session()!.attachments.ids(),
                  quotes: props.session()!.quotes(),
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
            name={stopPrimary() ? 'stop' : continuationSource() !== null ? 'play' : 'send'}
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
        paddingTop: hero() || platform.idiom === 'terminal' ? 0 : 12,
        paddingBottom: hero() || platform.idiom !== 'terminal' ? 16 : 8,
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
          {/* The desktop keeps the workspace in the toolbar and asks only for a missing connection. */}
          <If when={platform.idiom === 'terminal'}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              {workspaceControl()}
              <Button
                accessibilityLabel={tr('Connections & models')}
                onPress={props.settings}
                style={{
                  ...controlStyle,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                hoverStyle={{ backgroundColor: C.card }}
                focusStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ color: C.muted, fontSize: 13 }}>{tr('Connections & models')}</Text>
              </Button>
            </View>
          </If>
          <If when={noConnections()}>
            <Button
              accessibilityLabel={tr('Add a model connection')}
              onPress={props.settings}
              style={{
                ...controlStyle,
                alignSelf: 'center',
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
              ...(platform.idiom === 'terminal'
                ? { lineHeight: 16, paddingVertical: 8 }
                : { paddingTop: 4 }),
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
                toggleAttachments();
              },
              { when: 'always', within: node },
            );
          }}
          accessibilityLabel={tr('Conversation composer')}
          style={{
            flexShrink: 0,
            backgroundColor: platform.idiom === 'terminal' ? C.raised : C.card,
            borderRadius: cardRadius(),
            borderWidth: 1,
            borderColor: fileDragging()
              ? C.accent
              : platform.idiom === 'terminal'
                ? C.line
                : C.card,
            ...(platform.idiom === 'terminal'
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
              const editor = signal<ComposerEditor | null>(null);
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
                      platform.idiom === 'terminal'
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
                      <Each of={owner?.quotes() ?? []}>
                        {(quote, index) => (
                          <View
                            style={{
                              flexDirection: 'row',
                              gap: 8,
                              padding: 8,
                              borderLeftWidth: 2,
                              borderColor: C.line,
                              backgroundColor: C.card,
                              borderRadius: 6,
                            }}
                          >
                            <View style={{ flex: 1, gap: 4 }}>
                              <Text style={{ ...captionTextStyle, color: C.muted }}>
                                {quote().label ?? quote().source?.sessionName ?? ''}
                              </Text>
                              <Text
                                style={[
                                  { ...captionTextStyle, color: C.secondary },
                                  { numberOfLines: 3 },
                                ]}
                              >
                                {quote().text}
                              </Text>
                            </View>
                            <Button
                              accessibilityLabel={tr('Remove quote')}
                              disabled={!owner?.editable()}
                              onPress={() => owner?.removeQuote(index())}
                            >
                              <Icon name="close" color={C.muted} />
                            </Button>
                          </View>
                        )}
                      </Each>
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
                        minHeight:
                          platform.idiom === 'terminal'
                            ? hero() && !compact()
                              ? 40
                              : 24
                            : 2 * bodyTextStyle.lineHeight,
                        maxHeight: compact() ? 64 : 144,
                      }}
                    >
                      <SkillInput
                        ref={(node) => {
                          editor.set(node);
                          props.attach(node);
                          node.bindKey('mod+u', toggleAttachments);
                          completion.attach(owner?.sessionId ?? null, node);
                          predictionEditor.set(owner ? { owner, node } : null);
                        }}
                        onEscape={escapeComposer}
                        testID="message"
                        accessibilityLabel={tr('Message composer')}
                        autoFocus={owner !== null || local !== null}
                        value={owner?.draft() ?? local?.draft() ?? ''}
                        readonly={owner ? !owner.editable() : !local || local.sending()}
                        onChange={
                          owner
                            ? ({ value }) => completion.change(owner, value)
                            : local
                              ? ({ value }) => completion.change(local, value)
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
                                  completion.selection(local, event);
                                }
                              : undefined
                        }
                        onCaretMove={
                          owner
                            ? (event) => completion.caret(owner, event)
                            : local
                              ? (event) => completion.caret(local, event)
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
                              ? (event) => completion.submitPending(local, event.text)
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
                          onPress={inputAction(focusEditor, null)}
                          style={{ ...bodyTextStyle, color: `${C.muted}80`, minHeight: 24 }}
                        >
                          {suggestedMessage()!.text}{' '}
                          <Text
                            accessibilityLabel={tr('Use suggested message')}
                            onPress={inputAction(acceptSuggestedMessage, {
                              sessionId: owner!.sessionId,
                              sourceTurnId: suggestedMessage()!.sourceTurnId,
                              text: suggestedMessage()!.text,
                            })}
                            style={{
                              fontSize: captionTextStyle.fontSize,
                              borderRadius: 4,
                              backgroundColor: `${C.text}0f`,
                            }}
                          >
                            {`\u00a0\u00a0${tr('Press Tab to accept')}\u00a0\u00a0`}
                          </Text>
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
                gap: platform.idiom === 'terminal' ? 8 : 4,
              },
              { pointerEvents: 'box-none' },
            ]}
          >
            <Button
              ref={completion.addButton}
              onPress={inputAction(completion.toggleAdd, {
                owner: props.session()?.sessionId ?? pending()?.id ?? null,
              })}
              accessibilityLabel={tr('Add to message')}
              tooltip={textTooltip(() => tr('Add to message'))}
              disabled={
                completion.composing() ||
                (pending() ? pending()!.sending() : !props.session()?.editable())
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
            <If when={!externalAgent()}>
              <SessionPermissionsSelect
                owner={props.session()?.permissions ?? null}
                pending={pending()?.permissions ?? null}
              />
            </If>
            {/* After the sandbox, so leaving the start pane moves neither. */}
            <If when={platform.idiom !== 'terminal' && hero()}>{workspaceControl()}</If>
            <If when={props.session() !== null || pending() !== null}>
              <View
                style={[
                  platform.idiom === 'terminal'
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
                <If when={platform.idiom !== 'terminal' && props.session()?.contextUsage?.()}>
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
                popupStyle={floatingStyle()}
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
                        disabled={sendDisabled() || completion.isCommand()}
                        onSelect={inputAction(completion.send, {
                          owner: owner().sessionId,
                          text: owner().draft(),
                          backend: owner().backend(),
                          attachments: owner().attachments.ids(),
                          quotes: owner().quotes(),
                          delivery: 'queue' as const,
                        })}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={menuRowHoverStyle()}
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
                        disabled={owner().stopping()}
                        onSelect={inputAction(owner().stop, owner().run())}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={menuRowHoverStyle()}
                      >
                        <Icon name="stop" color={C.secondary} />
                        <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                          {tr('Stop response')}
                        </Text>
                        <Text style={{ ...menuDetailTextStyle, color: C.muted }}>Esc</Text>
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
        <If when={platform.idiom === 'terminal' || (props.session()?.connected() && warning())}>
          <View style={{ minHeight: 24, paddingTop: 8 }}>
            <If when={props.session()?.connected() && warning()}>
              <Text style={{ color: C.warning, fontSize: 12, lineHeight: 16 }}>{warning()}</Text>
            </If>
          </View>
        </If>
        <If when={platform.idiom === 'terminal' && props.session()?.metrics()}>
          <Text style={[{ color: C.muted, fontSize: 12, paddingTop: 4 }, { numberOfLines: 1 }]}>
            {props.session()?.metrics()}
          </Text>
        </If>
      </View>
    </View>
  );
}
