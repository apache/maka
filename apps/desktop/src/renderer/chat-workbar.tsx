import { lazy, Suspense } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useUiLocale, type ChatModelChoice } from '@maka/ui';
import type { SessionSummary } from '@maka/core';
import type { SessionWorkbarTab } from './session-workbar-layout';
import { SESSION_WORKBAR_MAX_WIDTH, SESSION_WORKBAR_MIN_WIDTH } from './session-workbar-layout';
import { getShellCopy } from './locales/shell-copy';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

// The session workbar owns the task ledger, embedded browser, and artifact
// preview. Keep the combined auxiliary surface out of the first chat paint.
const SessionWorkbar = lazy(() => import('./session-workbar').then((m) => ({ default: m.SessionWorkbar })));

function SessionWorkbarFallback() {
  const copy = getShellCopy(useUiLocale()).app;
  return (
    <aside className="maka-session-workbar" role="status" aria-busy="true" aria-label={copy.loadingWorkbarLabel}>
      <div className="maka-lazy-fallback" data-surface="panel">{copy.loadingWorkbar}</div>
    </aside>
  );
}

/**
 * The artifacts column of the sessions surface (issue #1043): the workbar
 * resize handle plus the lazy-mounted SessionWorkbar (task ledger, embedded
 * browser, artifact pane). AppShell renders this conditionally - only beside
 * an active session inside the sessions module - so it is not part of the
 * always-mounted chat surface.
 */
interface ChatWorkbarProps {
  activeId: string;
  browserLive: boolean;
  hidden: boolean;
  width: number;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
  onDismiss: () => void;
  startWorkbarResize: (event: PointerEvent<HTMLDivElement>) => void;
  onWorkbarResizeHandleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Active quote side panel: staged excerpts + source; threads to the workbar's
   *  "追问引用" tab. */
  quote?: QuoteCompanionPanelState | null;
  onClearQuote?: () => void;
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  sourceSession?: SessionSummary;
  modelChoices?: readonly ChatModelChoice[];
}

export function ChatWorkbar({
  activeId,
  browserLive,
  hidden,
  width,
  activeTab,
  onActiveTabChange,
  onDismiss,
  startWorkbarResize,
  onWorkbarResizeHandleKeyDown,
  quote,
  onClearQuote,
  onQuotesConsumed,
  onRemoveQuote,
  onForkVisibilityChange,
  sourceSession,
  modelChoices,
}: ChatWorkbarProps) {
  const copy = getShellCopy(useUiLocale()).app;
  return (
    <>
      <div
        className="maka-workbar-resize-handle"
        role="separator"
        aria-label={copy.resizeWorkbar}
        aria-orientation="vertical"
        aria-valuemin={SESSION_WORKBAR_MIN_WIDTH}
        aria-valuemax={SESSION_WORKBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startWorkbarResize}
        onKeyDown={onWorkbarResizeHandleKeyDown}
      />
      <Suspense fallback={<SessionWorkbarFallback />}>
        <SessionWorkbar
          key={activeId}
          sessionId={activeId}
          browserLive={browserLive}
          hidden={hidden}
          width={width}
          onDismiss={onDismiss}
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
          quote={quote}
          onClearQuote={onClearQuote}
          onQuotesConsumed={onQuotesConsumed}
          onRemoveQuote={onRemoveQuote}
          onForkVisibilityChange={onForkVisibilityChange}
          sourceSession={sourceSession}
          modelChoices={modelChoices}
        />
      </Suspense>
    </>
  );
}
