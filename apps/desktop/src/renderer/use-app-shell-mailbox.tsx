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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { StoredMessage } from '@maka/core/session';
import { sessionMailboxSentReceiptId } from '@maka/core/session-mailbox';
import type { UiLocale } from '@maka/core/ui-locale';
import type { SessionMailboxTarget } from '@maka/runtime-host/protocol';
import type { ComposerHandle } from '@maka/ui';
import { SessionMailboxPicker } from './session-mailbox-picker';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';
import { getDesktopConversationCopy } from './locales/conversation-copy';

interface AppShellMailboxInput {
  readonly activeSessionId?: string;
  readonly uiLocale: UiLocale;
  readonly revisionActive: boolean;
  readonly hasPendingComposerContext: boolean;
  readonly composerRef: RefObject<ComposerHandle | null>;
  readonly setMessages: Dispatch<SetStateAction<StoredMessage[]>>;
  readonly toastInfo: (title: string, description?: string) => void;
  readonly showSessionError: (sessionId: string, title: string, description?: string) => void;
}

interface PendingMailboxTarget {
  readonly sourceSessionId: string;
  readonly target: SessionMailboxTarget;
}

export function useAppShellMailbox(input: AppShellMailboxInput) {
  const {
    activeSessionId,
    uiLocale,
    revisionActive,
    hasPendingComposerContext,
    composerRef,
    setMessages,
    toastInfo,
    showSessionError,
  } = input;
  const copy = useMemo(() => getShellCopy(uiLocale).app, [uiLocale]);
  const conversationActions = useMemo(
    () => getDesktopConversationCopy(uiLocale).actions,
    [uiLocale],
  );
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const [pickerFlow, setPickerFlow] = useState<{
    sourceSessionId: string;
    targets: readonly SessionMailboxTarget[];
  } | null>(null);
  const [pendingTarget, setPendingTarget] = useState<PendingMailboxTarget | null>(null);
  const [deliveryFeedback, setDeliveryFeedback] = useState<
    (PendingMailboxTarget & { status: 'sending' | 'failed' }) | null
  >(null);

  useEffect(() => {
    if (pendingTarget && pendingTarget.sourceSessionId !== activeSessionId) {
      setPendingTarget(null);
      setDeliveryFeedback(null);
    }
    if (deliveryFeedback && deliveryFeedback.sourceSessionId !== activeSessionId) {
      setDeliveryFeedback(null);
    }
    if (pickerFlow && pickerFlow.sourceSessionId !== activeSessionId) {
      setPickerFlow(null);
    }
  }, [activeSessionId, deliveryFeedback, pendingTarget, pickerFlow]);

  const openTargetPicker = useCallback(async (hasWorkspaceReferences = false) => {
    const sourceSessionId = activeSessionIdRef.current;
    if (!sourceSessionId) return false;
    if (revisionActive) {
      toastInfo(
        conversationActions.revisionUnavailableTitle,
        conversationActions.revisionCommandUnsupported,
      );
      return false;
    }
    if (hasPendingComposerContext || hasWorkspaceReferences) {
      toastInfo(copy.sideChatContextPendingTitle, copy.sideChatContextPendingDescription);
      return false;
    }
    try {
      const targets = await window.maka.sessions.listMailboxTargets(sourceSessionId);
      setPendingTarget(null);
      setDeliveryFeedback(null);
      setPickerFlow({ sourceSessionId, targets });
      return true;
    } catch (error) {
      showSessionError(
        sourceSessionId,
        copy.mailboxFailedTitle,
        localizedShellErrorMessage(error, copy.mailboxFailedFallback, uiLocale),
      );
      return false;
    }
  }, [
    conversationActions,
    copy,
    hasPendingComposerContext,
    revisionActive,
    showSessionError,
    toastInfo,
    uiLocale,
  ]);

  const sendPending = useCallback(async (
    text: string,
    hasWorkspaceReferences = false,
  ): Promise<boolean | undefined> => {
    if (!pendingTarget) return undefined;
    if (activeSessionIdRef.current !== pendingTarget.sourceSessionId) {
      setPendingTarget(null);
      setDeliveryFeedback(null);
      return false;
    }
    if (hasPendingComposerContext || hasWorkspaceReferences) {
      toastInfo(copy.sideChatContextPendingTitle, copy.sideChatContextPendingDescription);
      return false;
    }

    setDeliveryFeedback({ ...pendingTarget, status: 'sending' });
    try {
      const result = await window.maka.sessions.sendMailboxMessage(
        pendingTarget.sourceSessionId,
        pendingTarget.target.sessionId,
        text,
      );
      setPendingTarget(null);
      setDeliveryFeedback(null);
      const receiptId = sessionMailboxSentReceiptId(result.messageId);
      if (activeSessionIdRef.current === pendingTarget.sourceSessionId) {
        setMessages((current) => {
          if (current.some((message) => message.id === receiptId)) return current;
          let anchorTurnId: string | undefined;
          for (let index = current.length - 1; index >= 0; index -= 1) {
            anchorTurnId = current[index]?.turnId;
            if (anchorTurnId) break;
          }
          return [...current, {
            type: 'system_note',
            id: receiptId,
            ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
            ts: Date.now(),
            kind: 'session_mailbox_sent',
            data: {
              messageId: result.messageId,
              targetSessionId: pendingTarget.target.sessionId,
              targetSessionName: pendingTarget.target.name,
              kind: 'request',
              text,
              disposition: result.disposition,
              ...(result.turnId ? { turnId: result.turnId } : {}),
            },
          }];
        });
      }
      return true;
    } catch (error) {
      setDeliveryFeedback({ ...pendingTarget, status: 'failed' });
      showSessionError(
        pendingTarget.sourceSessionId,
        copy.mailboxFailedTitle,
        localizedShellErrorMessage(error, copy.mailboxFailedFallback, uiLocale),
      );
      return false;
    }
  }, [
    copy,
    hasPendingComposerContext,
    pendingTarget,
    setMessages,
    showSessionError,
    toastInfo,
    uiLocale,
  ]);

  const sendTargetNotice = useMemo(() => {
    if (deliveryFeedback && deliveryFeedback.sourceSessionId === activeSessionId) {
      const dismiss = () => {
        setDeliveryFeedback(null);
        if (deliveryFeedback.status === 'failed') setPendingTarget(null);
      };
      return deliveryFeedback.status === 'sending'
        ? {
            title: copy.mailboxSendingTitle(deliveryFeedback.target.name),
            detail: copy.mailboxSendingDescription,
            cancelLabel: copy.mailboxComposerCancel,
            status: 'sending' as const,
            onCancel: dismiss,
          }
        : {
            title: copy.mailboxFailedReceiptTitle(deliveryFeedback.target.name),
            detail: copy.mailboxFailedReceiptDescription,
            cancelLabel: copy.mailboxComposerCancel,
            status: 'failed' as const,
            onCancel: dismiss,
          };
    }
    if (!pendingTarget || pendingTarget.sourceSessionId !== activeSessionId) return undefined;
    return {
      title: copy.mailboxComposerTitle(pendingTarget.target.name),
      detail: copy.mailboxComposerDescription,
      cancelLabel: copy.mailboxComposerCancel,
      status: 'ready' as const,
      onCancel: () => setPendingTarget(null),
    };
  }, [activeSessionId, copy, deliveryFeedback, pendingTarget]);

  const picker = pickerFlow ? (
    <SessionMailboxPicker
      targets={pickerFlow.targets}
      onOpenChange={(open) => {
        if (!open) setPickerFlow(null);
      }}
      onSelect={(target) => {
        setDeliveryFeedback(null);
        setPendingTarget({ sourceSessionId: pickerFlow.sourceSessionId, target });
        setPickerFlow(null);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }}
    />
  ) : null;

  return {
    openTargetPicker,
    sendPending,
    sendTargetNotice,
    picker,
    modalOpen: pickerFlow !== null,
  } as const;
}
