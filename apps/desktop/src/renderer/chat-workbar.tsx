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

import { lazy, Suspense, type ComponentProps, type CSSProperties } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { ResizeHandle, type ResizableProps } from '@astryxdesign/core/Resizable';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useUiLocale, type Composer } from '@maka/ui';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { getShellCopy } from './locales/shell-copy';
import type {
  SessionWorkbarPanelsState,
  SessionWorkbarPlacement,
  SessionWorkbarTab,
  SessionWorkbarTabKind,
} from './session-workbar-tabs';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

const SessionWorkbar = lazy(() =>
  import('./session-workbar').then((module) => ({
    default: module.SessionWorkbar,
  })),
);

function SessionWorkbarFallback() {
  const copy = getShellCopy(useUiLocale()).app;
  return (
    <div className="maka-workbar-workspace-contents">
      <Card
        variant="transparent"
        padding={0}
        height="100%"
        className="maka-session-workbar maka-session-workbar-frame"
        data-placement="right"
        role="status"
        aria-busy="true"
        aria-label={copy.loadingWorkbarLabel}
      >
        <div className="maka-lazy-fallback" data-surface="panel">
          <Spinner size="sm" shade="subtle" label={copy.loadingWorkbar} />
        </div>
      </Card>
    </div>
  );
}

interface ChatWorkbarProps {
  activeId: string;
  rightCollapsed: boolean;
  bottomOpen: boolean;
  hidden: boolean;
  rightWidth: number;
  bottomHeight: number;
  panelsState: SessionWorkbarPanelsState;
  onActivateTab: (placement: SessionWorkbarPlacement, tabId: string) => void;
  onCloseTab: (placement: SessionWorkbarPlacement, tab: SessionWorkbarTab) => void;
  onCloseTabs: (
    placement: SessionWorkbarPlacement,
    tabs: readonly SessionWorkbarTab[],
  ) => void;
  onReorderTab: (
    placement: SessionWorkbarPlacement,
    tabId: string,
    targetTabId: string,
  ) => void;
  onMoveTab: (
    placement: SessionWorkbarPlacement,
    tabId: string,
    direction: 'left' | 'right',
  ) => void;
  onMoveTabToPanel: (tabId: string, target: SessionWorkbarPlacement) => void;
  onPinTab: (tabId: string) => void;
  onOpenLauncher: (placement: SessionWorkbarPlacement) => void;
  onRequestOpenTab: (
    placement: SessionWorkbarPlacement,
    kind: SessionWorkbarTabKind,
  ) => void;
  onDismissPanel: (placement: SessionWorkbarPlacement) => void;
  rightResizable: ResizableProps;
  bottomResizable: ResizableProps;
  quotes?: readonly QuoteCompanionPanelState[];
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  onContentStateChange?: (panelId: string, hasContent: boolean) => void;
  onPreparingStateChange?: (panelId: string, preparing: boolean) => void;
  onInitialPromptStarted?: (panelId: string) => void;
  onPromptAccepted?: (panelId: string, prompt: string) => void;
  onActivityStateChange?: (panelId: string, active: boolean) => void;
  preparingSideChatPanelIds?: ReadonlySet<string>;
  activeSideChatPanelIds?: ReadonlySet<string>;
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
  mentionSkills?: ComponentProps<typeof Composer>['mentionSkills'];
  mentionSkillsUnavailable?: ComponentProps<typeof Composer>['mentionSkillsUnavailable'];
  mentionSkillsLoading?: ComponentProps<typeof Composer>['mentionSkillsLoading'];
  onSearchMentionFiles?: ComponentProps<typeof Composer>['onSearchMentionFiles'];
}

export function ChatWorkbar(props: ChatWorkbarProps) {
  const copy = getShellCopy(useUiLocale()).app;
  const style = {
    '--maka-session-workbar-width': `${props.rightWidth}px`,
    '--maka-session-bottom-panel-height': `${props.bottomHeight}px`,
  } as CSSProperties;

  return (
    <>
      {!props.rightCollapsed && (
        <ResizeHandle
          className="maka-workbar-resize-handle maka-workbar-resize-handle-right"
          resizable={props.rightResizable}
          direction="horizontal"
          isReversed
          isAlwaysVisible={false}
          pillPlacement="center"
          label={copy.resizeWorkbar}
        />
      )}
      {props.bottomOpen && (
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
      <div className="maka-workbar-layout-vars" style={style}>
        <Suspense fallback={<SessionWorkbarFallback />}>
          <SessionWorkbar
            key={props.activeId}
            sessionId={props.activeId}
            hidden={props.hidden}
            onDismissPanel={props.onDismissPanel}
            panelsState={props.panelsState}
            rightCollapsed={props.rightCollapsed}
            bottomOpen={props.bottomOpen}
            onActivateTab={props.onActivateTab}
            onCloseTab={props.onCloseTab}
            onCloseTabs={props.onCloseTabs}
            onReorderTab={props.onReorderTab}
            onMoveTab={props.onMoveTab}
            onMoveTabToPanel={props.onMoveTabToPanel}
            onPinTab={props.onPinTab}
            onOpenLauncher={props.onOpenLauncher}
            onRequestOpenTab={props.onRequestOpenTab}
            quotes={props.quotes}
            onQuotesConsumed={props.onQuotesConsumed}
            onRemoveQuote={props.onRemoveQuote}
            onForkVisibilityChange={props.onForkVisibilityChange}
            onContentStateChange={props.onContentStateChange}
            onPreparingStateChange={props.onPreparingStateChange}
            onInitialPromptStarted={props.onInitialPromptStarted}
            onPromptAccepted={props.onPromptAccepted}
            onActivityStateChange={props.onActivityStateChange}
            preparingSideChatPanelIds={props.preparingSideChatPanelIds}
            activeSideChatPanelIds={props.activeSideChatPanelIds}
            sourceSession={props.sourceSession}
            modelChoices={props.modelChoices}
            mentionSkills={props.mentionSkills}
            mentionSkillsUnavailable={props.mentionSkillsUnavailable}
            mentionSkillsLoading={props.mentionSkillsLoading}
            onSearchMentionFiles={props.onSearchMentionFiles}
          />
        </Suspense>
      </div>
    </>
  );
}
