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

import type { WorkbarTogglePosition } from '@maka/core/settings';
import { lazy, Suspense, type ComponentProps, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, ICON_SIZE } from '@maka/ui/icons';
import { Card } from '@astryxdesign/core/Card';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ResizeHandle, type ResizableProps } from '@astryxdesign/core/Resizable';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Composer, useToast, useUiLocale } from '@maka/ui';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import type { WorkBoardItem, WorkBoardLinkedSession } from '@maka/core/work-board';
import { confirmBypassPermission, getShellCopy } from '../../../locales/shell-copy';
import { getArtifactCopy } from '../../../locales/artifact-copy';
import { getBrowserCopy } from '../../../locales/browser-copy';
import { useFocusedPreview } from '../controller/use-focused-preview.js';
import { RecentTurnOverlay } from './recent-turn-overlay.js';
import type {
  SessionWorkbarPanelsState,
  SessionWorkbarPlacement,
  SessionWorkbarTab,
  SessionWorkbarTabKind,
} from '../model/workbar-tabs';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from '../tools/side-chat/quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from '../tools/side-chat/quote-companion-visibility';
import type { SessionExecutionProjection } from '../../../../shared/session-execution-projection.js';
import { SideChatCloseConfirmation } from './side-chat-close-confirmation.js';

const WorkbarSurface = lazy(() =>
  import('./workbar-surface').then((module) => ({
    default: module.WorkbarSurface,
  })),
);

function SessionWorkbarFallback(props: {
  hidden: boolean;
  rightCollapsed: boolean;
  bottomOpen: boolean;
}) {
  const copy = getShellCopy(useUiLocale()).app;
  if (props.hidden || (props.rightCollapsed && !props.bottomOpen)) return null;
  const placements: SessionWorkbarPlacement[] = [];
  if (!props.rightCollapsed) placements.push('right');
  if (props.bottomOpen) placements.push('bottom');
  return (
    <div className="maka-workbar-workspace-contents">
      {placements.map((placement) => (
        <Card
          key={placement}
          variant="transparent"
          padding={0}
          height="100%"
          className="maka-session-workbar maka-session-workbar-frame"
          data-placement={placement}
          role="status"
          aria-busy="true"
          aria-label={copy.loadingWorkbarLabel}
        >
          <div className="maka-lazy-fallback" data-surface="panel">
            <Spinner size="sm" shade="subtle" label={copy.loadingWorkbar} />
          </div>
        </Card>
      ))}
    </div>
  );
}

export interface WorkbarHostModel {
  workspace?: 'session' | 'workhub';
  activeId?: string;
  projectId?: string | null;
  projectAliases?: readonly string[];
  rightCollapsed: boolean;
  bottomOpen: boolean;
  hidden: boolean;
  rightWidth: number;
  bottomHeight: number;
  panelsState: SessionWorkbarPanelsState;
  onActivateTab: (placement: SessionWorkbarPlacement, tabId: string) => void;
  onCloseTab: (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) => void;
  onOpenLauncher: (placement: SessionWorkbarPlacement) => void;
  onRequestOpenTab: (
    placement: SessionWorkbarPlacement,
    kind: SessionWorkbarTabKind,
  ) => void;
  onDismissPanel: (placement: SessionWorkbarPlacement) => void;
  onToggleRightPanel(): void;
  rightResizable: ResizableProps;
  bottomResizable: ResizableProps;
  quotes?: readonly QuoteCompanionPanelState[];
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  onContentStateChange?: (panelId: string, hasContent: boolean) => void;
  onInitialPromptStarted?: (panelId: string) => void;
  onPromptAccepted?: (panelId: string, prompt: string) => void;
  onActivityStateChange?: (panelId: string, active: boolean) => void;
  activeSideChatPanelIds?: ReadonlySet<string>;
  sourceSession?: SessionSummary;
  onOpenConversation?(sessionId: string, turnId?: string): void;
  modelChoices?: readonly ChatModelChoice[];
  /** The owning conversation's canonical execution projection, for the parent
   * status of Side Conversations. */
  parentExecution?: SessionExecutionProjection;
  parentExecutionHistoryEpoch?: number;
  onOpenParentConversation?: (origin?: Element | null) => void;
  onStartWorkBoardTask?: (item: WorkBoardItem) => void;
  resolveWorkBoardStartTask?: (item: WorkBoardItem) => { ok: boolean; message?: string };
  onOpenWorkBoardSession?: (link: WorkBoardLinkedSession) => void;
  workBoardStartTaskEnabled?: boolean;
  closeConfirmation: {
    key: string;
    open: boolean;
    sideChatCount: number;
    onCancel(): void;
    onConfirm(skipFutureConfirmations: boolean): void;
  };
}

export function WorkbarHost({ model: props, togglePosition = 'edge' }: { model: WorkbarHostModel; togglePosition?: WorkbarTogglePosition }) {
  const locale = useUiLocale();
  const toast = useToast();
  const copy = getShellCopy(locale).app;
  const previewFocus = useFocusedPreview({ host: props });
  const style = {
    '--maka-session-bottom-panel-height': `${props.bottomHeight}px`,
  } as CSSProperties;

  return (
    <>
      {previewFocus.composerTarget && !previewFocus.focusedPreview && props.activeId && props.workspace !== 'workhub' &&
        previewFocus.activeRightTab?.kind === 'files' && !props.rightCollapsed &&
        createPortal(
          <IconButton className="maka-composer-drag-handle" size="sm" variant="ghost" draggable
            label={getArtifactCopy(locale).pane.moveComposer}
            tooltip={getArtifactCopy(locale).pane.moveComposer}
            icon={<GripVertical size={ICON_SIZE.control} aria-hidden="true" />}
            onDragStart={(event) => event.dataTransfer.setData('application/x-maka-composer', props.activeId!)}
            onClick={() => {
              previewFocus.toggle('files');
              requestAnimationFrame(() => previewFocus.composerTarget?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus());
            }} />,
          previewFocus.composerTarget,
        )}
      {previewFocus.composerTarget && props.activeId && !props.hidden && !props.rightCollapsed && props.workspace !== 'workhub' &&
        (previewFocus.activeRightTab?.kind === 'files' || previewFocus.activeRightTab?.kind === 'browser') &&
        createPortal(
          <RecentTurnOverlay key={props.activeId} sessionId={props.activeId}
            hidden={!previewFocus.focusedPreview}
            sourceSession={props.sourceSession} onHeightChange={previewFocus.setOverlayHeight}
            onExit={previewFocus.clear}
            onOpenConversation={(turnId) => {
              previewFocus.clear();
              props.onOpenConversation?.(props.activeId!, turnId);
            }}
            minimized={previewFocus.minimized} onMinimize={previewFocus.minimize} onRestore={previewFocus.restore} />,
          previewFocus.composerTarget,
        )}
      {props.activeId && !props.rightCollapsed && (
        <ResizeHandle
          className="maka-workbar-resize-handle maka-workbar-resize-handle-right"
          resizable={previewFocus.rightResizable}
          onPointerDownCapture={previewFocus.markPointerResize}
          direction="horizontal"
          isReversed
          isAlwaysVisible={false}
          pillPlacement="center"
          label={copy.resizeWorkbar}
        />
      )}
      {props.activeId && props.bottomOpen && (
        <ResizeHandle
          className="maka-workbar-resize-handle maka-workbar-resize-handle-bottom"
          resizable={props.bottomResizable}
          direction="vertical"
          isReversed
          isAlwaysVisible={false}
          pillPlacement="center"
          label={copy.resizeWorkbar}
        />
      )}
        <div className="maka-workbar-layout-vars" style={style} ref={previewFocus.surfaceRef}>
          <div className="maka-preview-collapse-hint" role="status">
            {previewFocus.activeRightTab?.kind === 'browser'
              ? getBrowserCopy(locale).releaseToFocus : getArtifactCopy(locale).pane.releaseToFocus}
          </div>
          <Suspense
            fallback={
              <SessionWorkbarFallback
                hidden={props.hidden || !props.activeId}
                rightCollapsed={props.rightCollapsed}
                bottomOpen={props.bottomOpen}
              />
            }
          >
            <WorkbarSurface
              togglePosition={togglePosition}
              workspace={props.workspace}
              sessionId={props.activeId}
              projectId={props.projectId}
              projectAliases={props.projectAliases}
              hidden={props.hidden || !props.activeId}
              onDismissPanel={props.onDismissPanel}
              onToggleRightPanel={props.onToggleRightPanel}
              panelsState={props.panelsState}
              rightCollapsed={props.rightCollapsed}
              focusedPreview={previewFocus.focusedPreview}
              onTogglePreviewFocus={previewFocus.composerTarget ? previewFocus.toggle : undefined}
              onPreviewExit={previewFocus.clear}
              bottomOpen={props.bottomOpen}
              onActivateTab={props.onActivateTab}
              onCloseTab={props.onCloseTab}
              onOpenLauncher={props.onOpenLauncher}
              onRequestOpenTab={props.onRequestOpenTab}
              quotes={props.quotes}
              onQuotesConsumed={props.onQuotesConsumed}
              onRemoveQuote={props.onRemoveQuote}
              onForkVisibilityChange={props.onForkVisibilityChange}
              onContentStateChange={props.onContentStateChange}
              onInitialPromptStarted={props.onInitialPromptStarted}
              onPromptAccepted={props.onPromptAccepted}
              onActivityStateChange={props.onActivityStateChange}
              activeSideChatPanelIds={props.activeSideChatPanelIds}
              sourceSession={props.sourceSession}
              modelChoices={props.modelChoices}
              onStartWorkBoardTask={props.onStartWorkBoardTask}
              resolveWorkBoardStartTask={props.resolveWorkBoardStartTask}
              onOpenWorkBoardSession={props.onOpenWorkBoardSession}
              workBoardStartTaskEnabled={props.workBoardStartTaskEnabled}
              confirmBypass={() => confirmBypassPermission(toast, locale)}
              parentExecution={props.parentExecution}
              parentExecutionHistoryEpoch={props.parentExecutionHistoryEpoch}
              onOpenParentConversation={props.onOpenParentConversation}
            />
          </Suspense>
        </div>
      <SideChatCloseConfirmation
        key={props.closeConfirmation.key}
        open={props.closeConfirmation.open}
        sideChatCount={props.closeConfirmation.sideChatCount}
        onCancel={props.closeConfirmation.onCancel}
        onConfirm={props.closeConfirmation.onConfirm}
      />
    </>
  );
}
