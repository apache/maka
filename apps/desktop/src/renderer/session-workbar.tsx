import { useEffect, useState, type CSSProperties } from 'react';
import {
  Tab,
  TabList,
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
      data-maka-contract="session-workbar"
      aria-label={copy.ariaLabel}
      style={{ '--maka-session-workbar-width': `${props.width}px` } as CSSProperties}
    >
      <div className="maka-session-workbar-tabs">
        <TabList
          value={props.activeTab}
          onChange={(value) => props.onActiveTabChange(value as SessionWorkbarTab)}
          hasDivider
          className="maka-session-workbar-tab-list"
          aria-label={copy.sectionsAriaLabel}
        >
          <Tab
            value="tasks"
            label={copy.tasks}
            endContent={<span className="maka-session-workbar-count" data-maka-contract="session-workbar-count">{taskCount}</span>}
          />
          <Tab
            value="browser"
            label={copy.browser}
            aria-disabled={!props.browserLive ? 'true' : undefined}
            onClick={!props.browserLive ? (event) => event.preventDefault() : undefined}
          />
          <Tab
            value="files"
            label={copy.files}
            endContent={<span className="maka-session-workbar-count" data-maka-contract="session-workbar-count">{artifactCount}</span>}
          />
          {props.quote && (
            <Tab value="quote" label={copy.quoteTab} />
          )}
        </TabList>
        <div className="maka-session-workbar-panel" hidden={props.activeTab !== 'tasks'}>
          <TaskLedgerPanel
            tasks={sessionTasks.tasks}
            loading={sessionTasks.loading}
            error={sessionTasks.error}
            onRetry={sessionTasks.retry}
          />
        </div>
        <div className="maka-session-workbar-panel" hidden={props.activeTab !== 'browser'}>
          {props.browserLive && <BrowserPanel sessionId={props.sessionId} hidden={props.hidden || props.activeTab !== 'browser'} />}
        </div>
        <div className="maka-session-workbar-panel" hidden={props.activeTab !== 'files'}>
          <ArtifactPane sessionId={props.sessionId} onCountChange={setArtifactCount} onDismiss={props.onDismiss} />
        </div>
        {props.quote && (
          <div
            className="maka-session-workbar-panel maka-quote-workbar-panel"
            hidden={props.activeTab !== 'quote'}
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
          </div>
        )}
      </div>
    </aside>
  );
}
