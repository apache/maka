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

import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import {
  ChatView,
  ChatSurfaceLayout,
  Composer,
  ClientCapabilityPrompt,
  SandboxBoundaryPrompt,
  UserQuestionPrompt,
  useToast,
  useUiLocale,
  type ChatModelChoice,
  type ComposerHandle,
} from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
} from '@maka/core/redaction';
import { useQuoteCompanion } from './use-quote-companion';
import { useComposerAttachments } from '../../../../use-composer-attachments';
import { useComposerMentionsContext } from '../../../../composer-mentions.js';
import { preflightAttachmentItems } from '../../../../attachment-preflight';
import { toComposerIngestItems } from '../../../../composer-attachments';
import { getDesktopConversationCopy } from '../../../../locales/conversation-copy.js';
import { deriveTurnFooterActions } from '../../../../turn-footer-actions';
import {
  createQuoteCompanionCompactionPresentation,
  dispatchQuoteCompanionInput,
  presentQuoteCompanionCompactionResult,
} from './quote-companion-context-compaction.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  StagedCompanionQuote,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';
import { readScrollMotionBehavior } from '../../../../scroll-motion-policy';
import { useWorkbarServices } from '../../services-context.js';

/**
 * The side-conversation workbar tab: a transient read-only fork of the main session.
 * It renders with the SAME surface as the main conversation — the real
 * `ChatView` transcript (markdown, tool activity, token streaming) and the real
 * `Composer` — bound to a read-only companion fork of the main session (see
 * useQuoteCompanion). The fork KNOWS the main conversation's context and inherits
 * its model (shown read-only — no independent picker). It explains and explores;
 * writes/shell are blocked, and web/custom tools prompt here. Selecting more text
 * in the main transcript adds another quote chip to THIS thread.
 */
export function QuoteCompanionPanel(props: {
  panelId: string;
  active: boolean;
  /** Excerpts staged for the next send (accumulated as the user adds more). */
  quotes: readonly StagedCompanionQuote[];
  initialPrompt?: string;
  sourceSession: SessionSummary | undefined;
  /** Shared global choice list, only used to render the inherited model's label. */
  modelChoices: readonly ChatModelChoice[];
  confirmBypass: () => Promise<boolean>;
  onQuotesConsumed: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  onContentStateChange?: (panelId: string, hasContent: boolean) => void;
  onInitialPromptStarted?: (panelId: string) => void;
  onPromptAccepted?: (panelId: string, prompt: string) => void;
  onActivityStateChange?: (panelId: string, active: boolean) => void;
}) {
  const { attachments } = useWorkbarServices();
  const mentions = useComposerMentionsContext();
  const locale = useUiLocale();
  const toast = useToast();
  const copy = getDesktopConversationCopy(locale).quoteCompanion;
  const composerRef = useRef<ComposerHandle>(null);
  const initialPromptStartedRef = useRef(false);
  const contextCompactionPresentationRef = useRef<
    ReturnType<typeof createQuoteCompanionCompactionPresentation>
  >(undefined);
  if (!contextCompactionPresentationRef.current) {
    contextCompactionPresentationRef.current = createQuoteCompanionCompactionPresentation({
      toastApi: toast,
      copyForLocale: (nextLocale) => getDesktopConversationCopy(nextLocale).quoteCompanion,
      presentTerminal(sessionId, notice) {
        if (notice.level === 'error') {
          toast.error(notice.title, notice.description, undefined, { sessionId });
        } else {
          toast[notice.level](notice.title, notice.description);
        }
      },
    });
  }
  const draftKey = `quote-companion:${props.panelId}`;
  const {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  } = useComposerAttachments({
    draftKey,
    toastApi: toast,
    service: attachments,
  });
  const companion = useQuoteCompanion({
    panelId: props.panelId,
    pendingQuotes: props.quotes,
    sourceSession: props.sourceSession,
    modelChoices: props.modelChoices,
    locale,
    onQuotesConsumed: props.onQuotesConsumed,
    confirmBypass: props.confirmBypass,
    onForkVisibilityChange: props.onForkVisibilityChange,
    onContextCompactionResult: (sessionId, result) => {
      presentQuoteCompanionCompactionResult(
        contextCompactionPresentationRef.current!,
        sessionId,
        result,
        locale,
      );
    },
    onContextCompactionOutcome: (sessionId, turnId, outcome) => {
      contextCompactionPresentationRef.current!.finished(
        sessionId,
        turnId,
        outcome,
        locale,
      );
    },
    onContextCompactionError: (sessionId, error) => {
      if (isWorkspaceUnavailableError(error)) {
        toast.error(
          getDesktopConversationCopy(locale).quoteCompanion.workspaceUnavailableTitle,
          getDesktopConversationCopy(locale).quoteCompanion.workspaceUnavailableDescription,
          undefined,
          { sessionId },
        );
        return;
      }
      const compactCopy = getDesktopConversationCopy(locale).quoteCompanion;
      toast.error(
        compactCopy.compactErrorTitle,
        locale === 'zh'
          ? generalizedErrorMessageChinese(error, compactCopy.compactErrorFallback)
          : generalizedErrorMessage(error, compactCopy.compactErrorFallback),
        undefined,
        { sessionId },
      );
    },
  });
  useEffect(() => {
    props.onContentStateChange?.(props.panelId, companion.hasContent);
  }, [companion.hasContent, props.onContentStateChange, props.panelId]);
  useEffect(() => {
    props.onActivityStateChange?.(
      props.panelId,
      companion.streaming || companion.processing,
    );
  }, [
    companion.processing,
    companion.streaming,
    props.onActivityStateChange,
    props.panelId,
  ]);
  useEffect(() => {
    if (!props.active) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.active]);
  useEffect(() => {
    const prompt = props.initialPrompt?.trim();
    if (
      !props.active ||
      !companion.modelReady ||
      !prompt ||
      initialPromptStartedRef.current
    ) {
      return;
    }
    initialPromptStartedRef.current = true;
    props.onInitialPromptStarted?.(props.panelId);
    void companion
      .send(prompt)
      .then((accepted) => {
        if (accepted) {
          props.onPromptAccepted?.(props.panelId, prompt);
          return;
        }
        composerRef.current?.setText(prompt);
        composerRef.current?.focus();
      })
      .catch(() => {
        composerRef.current?.setText(prompt);
        composerRef.current?.focus();
      });
  }, [
    companion.send,
    props.active,
    props.initialPrompt,
    props.onInitialPromptStarted,
    props.onPromptAccepted,
    props.panelId,
    companion.modelReady,
  ]);

  // The companion inherits the source model and does not switch it; look up a
  // friendly label from the shared choice list purely for a read-only display.
  const activeModel = companion.activeModel;
  const activeModelLabel =
    (activeModel
      ? props.modelChoices.find(
          (choice) =>
            choice.connectionSlug === activeModel.llmConnectionSlug &&
            choice.model === activeModel.model,
        )?.label
      : undefined) ?? activeModel?.model;

  const activeInteraction =
    companion.activeSandboxBoundary ??
    companion.activeClientCapability ??
    companion.activeQuestion;
  const deriveTurnPresentation = useCallback<
    NonNullable<ComponentProps<typeof ChatView>['deriveTurnPresentation']>
  >(
    (turns) => ({
      footerActionsByTurn: Object.fromEntries(
        turns.map((turn) => [
          turn.turnId,
          deriveTurnFooterActions({
            status: turn.status,
            locale,
            hasContent: Boolean(turn.assistant?.text?.trim()),
            ...(companion.regeneratePendingTurnId === turn.turnId
              ? { pendingActions: new Set(['regenerate'] as const) }
              : {}),
          }).filter((action) => action.id !== 'branch'),
        ]),
      ),
      failedReasonLabels: {},
      failedSeverities: {},
      failedExecutionStateLabels: {},
      lineageBadgesByTurn: {},
    }),
    [companion.regeneratePendingTurnId, locale],
  );

  return (
    <div className="maka-quote-companion">
      <ChatSurfaceLayout
        scrollOwner="host"
        scrollToBottomLabel={copy.scrollToBottom}
        composer={
          <>
            {companion.error && (
              <Banner status="error" role="alert" title={companion.error} />
            )}
            {(companion.activeSandboxBoundary ||
              companion.activeClientCapability ||
              companion.activeQuestion) && (
              <div className="maka-composer-interaction-slot">
                {companion.activeSandboxBoundary && (
                  <SandboxBoundaryPrompt
                    request={companion.activeSandboxBoundary}
                    onRespond={companion.respondToSandboxBoundary}
                  />
                )}
                {companion.activeClientCapability && (
                  <ClientCapabilityPrompt
                    request={companion.activeClientCapability}
                    onRespond={companion.respondToClientCapability}
                  />
                )}
                {companion.activeQuestion && (
                  <UserQuestionPrompt
                    request={companion.activeQuestion}
                    onRespond={companion.respondToUserQuestion}
                    onStop={() => void companion.stop()}
                  />
                )}
              </div>
            )}
            <Composer
              ref={composerRef}
              onSend={(text) =>
                dispatchQuoteCompanionInput({
                  text,
                  streaming: companion.streaming,
                  compact: companion.compact,
                  steer: companion.steer,
                  send: async () => {
                    try {
                      preflightAttachmentItems(pendingAttachments, locale);
                    } catch (error) {
                      toast.error(
                        copy.errors.sendRejected,
                        error instanceof Error ? error.message : String(error),
                      );
                      return false;
                    }
                    const accepted = await companion.send(
                      text,
                      pendingAttachments.length > 0
                        ? toComposerIngestItems(pendingAttachments)
                        : undefined,
                    );
                    if (accepted) {
                      props.onPromptAccepted?.(props.panelId, text);
                    }
                    if (accepted) clearSubmittedAttachments(pendingAttachments);
                    return accepted;
                  },
                })
              }
              onStop={() => void companion.stop()}
              hidden={Boolean(activeInteraction)}
              streaming={companion.streaming}
              processing={companion.processing}
              draftKey={draftKey}
              disabled={!companion.modelReady}
              onPickAttachments={pickAttachments}
              onAttachFilePaths={attachFilePaths}
              pendingAttachments={pendingAttachments}
              onRemoveAttachment={removeAttachment}
              mentionSkills={mentions?.mentionSkills}
              onSearchMentionFiles={mentions?.searchMentionFiles}
              pendingQuotes={props.quotes.map((quote) => quote.value)}
              mentionSkillsUnavailable={mentions?.mentionSkillsUnavailable}
              mentionSkillsLoading={mentions?.mentionSkillsLoading}
              contextDrawerDefaultCollapsed
              showStaticModelUnavailableStatus={false}
              onRemoveQuote={(index) => {
                const quote = props.quotes[index];
                if (quote) {
                  props.onRemoveQuote?.({
                    panelId: props.panelId,
                    quoteId: quote.id,
                  });
                }
              }}
              // No activeSession / onModelChange → the model shows as a read-only chip
              // (the companion has no independent picker; it inherits the source model).
              modelLabel={activeModelLabel}
              permissionMode={companion.permissionMode}
              permissionModeDisabledReason={
                companion.streaming ? copy.permissionStreaming : undefined
              }
              onPermissionModeChange={(mode) => {
                void companion.setPermissionMode(mode);
              }}
            />
          </>
        }
      >
        <ChatView
          messages={companion.messages}
          scrollBehavior={readScrollMotionBehavior()}
          liveTurn={companion.liveTurn}
          runningStatus={companion.processing}
          activeSession={companion.companionSession}
          onReadAttachmentBytes={attachments.readBytes}
          deriveTurnPresentation={deriveTurnPresentation}
          onTurnFooterAction={(turnId, actionId) => {
            if (actionId === 'regenerate') {
              void companion.regenerate(turnId);
            }
          }}
          emptyOverride={<div className="maka-quote-companion-empty" aria-hidden="true" />}
          onNew={() => {}}
        />
      </ChatSurfaceLayout>
    </div>
  );
}

function isWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown };
  return (
    value.code === 'SESSION_WORKSPACE_UNAVAILABLE' ||
    (typeof value.message === 'string' &&
      value.message.includes('SESSION_WORKSPACE_UNAVAILABLE:'))
  );
}
