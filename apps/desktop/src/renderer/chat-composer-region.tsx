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

import { useLayoutEffect, useRef, type ComponentProps, type RefObject } from 'react';
import {
  Banner,
  Button,
  ClientCapabilityPrompt,
  Composer,
  SandboxBoundaryPrompt,
  UserQuestionPrompt,
} from '@maka/ui';
import type { ComposerHandle, ComposerInteraction } from '@maka/ui';
import { useComposerMentionsContext } from './composer-mentions.js';
import {
  readNewTaskReloadDraft,
  readNewTaskReloadIntent,
  UNRESOLVED_NEW_TASK_DRAFT_KEY,
  writeNewTaskReloadDraft,
} from './new-task-reload-intent.js';

const newTaskDraftPersistence = {
  read(key: string | undefined): string | undefined {
    return key ? readNewTaskReloadDraft(key) : undefined;
  },
  write(key: string | undefined, value: string): void {
    if (!key?.startsWith('new-task:') && !key?.startsWith('["new-task"')) return;
    writeNewTaskReloadDraft(key, value);
  },
};

/**
 * #1629: what the composer's slot shows when the active session's boundary
 * could not be read. The composer must stay hidden — without the boundary the
 * surface cannot know what the session may do — but "hidden" on its own reads
 * as a broken window, so the slot says what happened and offers another read.
 */
interface BoundaryUnreadableNotice {
  title: string;
  detail: string;
  retryLabel: string;
  retryPendingLabel: string;
  retryPending: boolean;
  onRetry(): void;
}

/**
 * The composer region of the chat surface (issue #1043): the composer
 * interaction slot (permission / user-question prompts) plus the always-mounted
 * Composer itself.
 *
 * AppShell renders this as a stable sibling of the section switch, so it is
 * NEVER conditionally mounted - the Composer keeps its uncontrolled textarea
 * and draft across section switches and permission takeovers (#646 draft
 * preservation, permission-composer-takeover contract). `hidden` drives the
 * native hidden state instead of unmounting.
 *
 * Composer props are forwarded via ComponentProps spread; `hidden`,
 * `draftKey`, and `stopPending` are derived here from the active-session state
 * so AppShell only forwards the orchestration callbacks and the session maps.
 */
interface ChatComposerRegionProps
  extends Omit<
    ComponentProps<typeof Composer>,
    | 'hidden'
    | 'draftKey'
    | 'stopPending'
    | 'allowAttachmentImportWhileStreaming'
    // Read from ComposerMentionsProvider, so a catalog reload repaints the
    // popups without re-rendering the shell that would otherwise pass them.
    | 'mentionSkills'
    | 'mentionSkillsUnavailable'
    | 'mentionSkillsLoading'
    | 'onSearchMentionFiles'
    | 'pendingDirectories'
    | 'onRemoveDirectory'
    | 'onPickDirectory'
  > {
  composerRef: RefObject<ComposerHandle | null>;
  active: boolean;
  onboardingComposerHidden: boolean;
  activeInteraction: ComposerInteraction | undefined;
  activeId: string | undefined;
  newTaskDraftKey: string;
  /** True from the moment a new-task send starts until it has settled. */
  newTaskSendPending: boolean;
  stopPendingBySession: Record<string, boolean>;
  respondToSandboxBoundary: ComponentProps<typeof SandboxBoundaryPrompt>['onRespond'];
  respondToClientCapability: ComponentProps<typeof ClientCapabilityPrompt>['onRespond'];
  respondToUserQuestion: ComponentProps<typeof UserQuestionPrompt>['onRespond'];
  stop: ComponentProps<typeof UserQuestionPrompt>['onStop'];
  boundaryUnreadableNotice?: BoundaryUnreadableNotice;
  directoryComposerProps: Pick<
    ComponentProps<typeof Composer>,
    'pendingDirectories' | 'onRemoveDirectory' | 'onPickDirectory'
  >;
  directoryPickerEnabled: boolean;
}

export function ChatComposerRegion({
  composerRef,
  active,
  onboardingComposerHidden,
  activeInteraction,
  activeId,
  newTaskDraftKey,
  newTaskSendPending,
  stopPendingBySession,
  respondToSandboxBoundary,
  respondToClientCapability,
  respondToUserQuestion,
  stop,
  boundaryUnreadableNotice,
  directoryComposerProps,
  directoryPickerEnabled,
  ...composerRest
}: ChatComposerRegionProps) {
  const mentions = useComposerMentionsContext();
  const activeSandboxBoundary =
    activeInteraction?.type === 'sandbox_boundary_request' ? activeInteraction : undefined;
  const activeClientCapability =
    activeInteraction?.type === 'client_capability_request' ? activeInteraction : undefined;
  const activeQuestion = activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;
  const previousNewTaskDraftKey = useRef(newTaskDraftKey);
  useLayoutEffect(() => {
    const previous = previousNewTaskDraftKey.current;
    // A submission owns the text it submitted until it settles. `sendCurrent`
    // captures the key it sent from and clears exactly that key when the send
    // resolves, so carrying the text to a target chosen mid-flight would leave
    // the sent message sitting in the composer under the new one, ready to be
    // sent twice. Leave `previous` where it is rather than dropping the change:
    // the effect re-runs when the send settles, and carries then — from the
    // slot the completion has already cleared, so nothing sent comes with it,
    // and anything typed after the send does.
    if (newTaskSendPending) return;
    previousNewTaskDraftKey.current = newTaskDraftKey;
    if (previous === newTaskDraftKey) return;
    const composer = composerRef.current;
    if (!composer) return;
    // The catalog may settle after the user has opened an existing Session.
    // Read the slot the key is LEAVING instead of whichever draft is currently
    // visible, so Session text can never become a new-task draft. With no
    // Session open that slot IS the active one, so this is the visible text.
    const carried = composer.getDraft(previous);
    // Leaving the UNRESOLVED slot is startup settling, not a choice the user
    // made: its draft may have been persisted for one specific target by a
    // reload, and must not be pasted into a different one. Every other change
    // is the user picking a different target for the task they are already
    // writing — the workspace picker sits directly under the composer, so
    // "type, then pick where it runs" is the ordinary order, and the draft
    // follows the selection rather than staying behind in the slot they
    // navigated away from, which read as the text being destroyed (#3408).
    // The slots themselves stay keyed per target, so #3122's Host-scoped
    // new-task state is unchanged.
    if (previous === UNRESOLVED_NEW_TASK_DRAFT_KEY) {
      const reloadIntent = readNewTaskReloadIntent();
      const reloadTarget = reloadIntent?.draftKey;
      const canCarryUnresolvedDraft =
        !reloadTarget ||
        reloadTarget === UNRESOLVED_NEW_TASK_DRAFT_KEY ||
        reloadTarget === newTaskDraftKey;
      if (!canCarryUnresolvedDraft) return;
    }
    // Assigned even when nothing is carried, so the target the user arrives at
    // shows what they arrived with and nothing else. The swap leaves a copy
    // under every key it passes through (the composer's draft hook re-remembers
    // the live text under the key it is leaving), so skipping the empty case
    // would let one of those copies surface later: send the task, come back to
    // an empty composer, pick another target, and the text just sent would
    // reappear as that target's own draft. Its persisted draft still wins over
    // an empty carry — that one outlived a renderer reload rather than being
    // left behind by this effect.
    composer.setDraft(
      newTaskDraftKey,
      carried.length > 0
        ? carried
        : (newTaskDraftPersistence.read(newTaskDraftKey) ?? ''),
    );
  }, [composerRef, newTaskDraftKey, newTaskSendPending]);

  return (
    <>
      <div className="maka-composer-interaction-slot">
        {/* The notice stands in for the composer, so it appears exactly where
            the composer would have been — and never over a turn-scoped
            interaction, which already owns the slot and is the more urgent
            thing to answer. */}
        {boundaryUnreadableNotice && active && !activeInteraction && (
          <div className="maka-boundary-unreadable-notice">
            <Banner
              status="warning"
              className="maka-boundary-unreadable-notice-alert"
              role="status"
              title={boundaryUnreadableNotice.title}
              description={boundaryUnreadableNotice.detail}
              endContent={<Button
                variant="secondary"
                size="sm"
                label={boundaryUnreadableNotice.retryPending
                  ? boundaryUnreadableNotice.retryPendingLabel
                  : boundaryUnreadableNotice.retryLabel}
                isDisabled={boundaryUnreadableNotice.retryPending}
                onClick={boundaryUnreadableNotice.onRetry}
              />} />
          </div>
        )}
        {activeSandboxBoundary && (
          <SandboxBoundaryPrompt
            request={activeSandboxBoundary}
            onRespond={respondToSandboxBoundary}
          />
        )}
        {activeClientCapability && (
          <ClientCapabilityPrompt
            request={activeClientCapability}
            onRespond={respondToClientCapability}
          />
        )}
        {activeQuestion && (
          <UserQuestionPrompt
            request={activeQuestion}
            onRespond={respondToUserQuestion}
            onStop={stop}
            stopPending={activeId ? stopPendingBySession[activeId] === true : false}
          />
        )}
      </div>
      <Composer
        ref={composerRef}
        {...composerRest}
        // AppShell carries staged attachments into both queued and steering
        // follow-ups. Other Composer hosts remain gated by default because a
        // text-only running-turn submission would leave attachments behind.
        allowAttachmentImportWhileStreaming
        mentionSkills={mentions?.mentionSkills}
        mentionSkillsUnavailable={mentions?.mentionSkillsUnavailable}
        mentionSkillsLoading={mentions?.mentionSkillsLoading}
        onSearchMentionFiles={mentions?.searchMentionFiles}
        {...directoryComposerProps}
        onPickDirectory={
          directoryPickerEnabled ? directoryComposerProps.onPickDirectory : undefined
        }
        hidden={!active || onboardingComposerHidden || Boolean(activeInteraction)}
        draftKey={activeId ?? newTaskDraftKey}
        draftPersistence={newTaskDraftPersistence}
        stopPending={activeId ? stopPendingBySession[activeId] === true : false}
      />
    </>
  );
}
