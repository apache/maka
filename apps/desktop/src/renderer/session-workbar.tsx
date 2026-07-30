import { useEffect, useState, type CSSProperties } from 'react';
import {
  PrimitiveTabs,
  PrimitiveTabsList,
  PrimitiveTabsPanel,
  PrimitiveTabsTrigger,
  TaskLedgerPanel,
  deriveTaskLedgerPanelModel,
  useUiLocale,
  type ChatModelChoice,
} from '@maka/ui';
import type { SessionSummary } from '@maka/core';
import { ArtifactPane } from './artifact-pane';
import { BrowserPanel } from './browser-panel';
import { QuoteCompanionPanel } from './quote-companion-panel';
import type { SessionWorkbarTab } from './session-workbar-layout';
import { useSessionTasks } from './use-session-tasks';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

export function SessionWorkbar(props: {
  sessionId: string;
  browserLive: boolean;
  hidden: boolean;
  width: number;
  onDismiss: () => void;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
  /** Active quote side panel: staged excerpts for the source session, or null
   *  when no panel is open. Renders a transient "追问引用" tab. */
  quote?: QuoteCompanionPanelState | null;
  onClearQuote?: () => void;
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  /** The main session the companion forks from (inherits context + model). */
  sourceSession?: SessionSummary;
  /** Shared global choice list, used to label the companion's inherited model. */
  modelChoices?: readonly ChatModelChoice[];
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const sessionTasks = useSessionTasks(props.sessionId);
  const taskCount = deriveTaskLedgerPanelModel(sessionTasks.tasks).activeCount;
  const [artifactCount, setArtifactCount] = useState(0);

  useEffect(() => {
    if (props.activeTab === 'browser' && !props.browserLive) props.onActiveTabChange('tasks');
  }, [props.activeTab, props.browserLive, props.onActiveTabChange]);

  // The quote tab only exists while an excerpt is active; fall back when cleared.
  useEffect(() => {
    if (props.activeTab === 'quote' && !props.quote) props.onActiveTabChange('tasks');
  }, [props.activeTab, props.quote, props.onActiveTabChange]);

  return (
    <aside
      className="maka-session-workbar"
      aria-label={copy.ariaLabel}
      style={{ '--maka-session-workbar-width': `${props.width}px` } as CSSProperties}
    >
      <PrimitiveTabs value={props.activeTab} onValueChange={(value) => props.onActiveTabChange(value as SessionWorkbarTab)} className="maka-session-workbar-tabs">
        <PrimitiveTabsList variant="underline" className="maka-session-workbar-tab-list" aria-label={copy.sectionsAriaLabel}>
          <PrimitiveTabsTrigger value="tasks">
            <span>{copy.tasks}</span>
            <span className="maka-session-workbar-count">{taskCount}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="browser" disabled={!props.browserLive}>
            <span>{copy.browser}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="files">
            <span>{copy.files}</span>
            <span className="maka-session-workbar-count">{artifactCount}</span>
          </PrimitiveTabsTrigger>
          {props.quote && (
            <PrimitiveTabsTrigger value="quote">
              <span>{copy.quoteTab}</span>
            </PrimitiveTabsTrigger>
          )}
        </PrimitiveTabsList>
        <PrimitiveTabsPanel value="tasks" className="maka-session-workbar-panel" keepMounted>
          <TaskLedgerPanel
            tasks={sessionTasks.tasks}
            loading={sessionTasks.loading}
            error={sessionTasks.error}
            onRetry={sessionTasks.retry}
          />
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="browser" className="maka-session-workbar-panel" keepMounted>
          {props.browserLive && <BrowserPanel sessionId={props.sessionId} hidden={props.hidden || props.activeTab !== 'browser'} />}
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="files" className="maka-session-workbar-panel" keepMounted>
          <ArtifactPane sessionId={props.sessionId} onCountChange={setArtifactCount} onDismiss={props.onDismiss} />
        </PrimitiveTabsPanel>
        {props.quote && (
          <PrimitiveTabsPanel
            value="quote"
            className="maka-session-workbar-panel maka-quote-workbar-panel"
            keepMounted
          >
            <QuoteCompanionPanel
              key={props.quote.id}
              panelId={props.quote.id}
              quotes={props.quote.quotes}
              sourceSession={props.sourceSession}
              modelChoices={props.modelChoices ?? []}
              onClear={props.onClearQuote}
              onQuotesConsumed={props.onQuotesConsumed ?? (() => {})}
              onRemoveQuote={props.onRemoveQuote}
              onForkVisibilityChange={props.onForkVisibilityChange}
            />
          </PrimitiveTabsPanel>
        )}
      </PrimitiveTabs>
    </aside>
  );
}
