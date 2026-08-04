import { lazy, Suspense } from 'react';
import { ResizeHandle, type ResizableProps } from '@astryxdesign/core/Resizable';
import { useUiLocale, type ChatModelChoice } from '@maka/ui';
import type { SessionSummary } from '@maka/core';
import type { SessionWorkbarTab } from './session-workbar-layout';
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
    <aside className="maka-session-workbar" data-maka-contract="session-workbar" role="status" aria-busy="true" aria-label={copy.loadingWorkbarLabel}>
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
  /** Resize region from `useShellLayout`; drives drag and arrow-key sizing. */
  workbarResizable: ResizableProps;
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
  workbarResizable,
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
      <ResizeHandle
        className="maka-workbar-resize-handle"
        resizable={workbarResizable}
        direction="horizontal"
        // The workbar sits at the end of the row, so dragging toward the start
        // must widen it.
        isReversed
        isAlwaysVisible={false}
        // Astryx offsets a side-placed horizontal grab zone with
        // `translateY(-50%)` on top of `top: 0; bottom: 0`, which lifts it half
        // its height off the divider and makes the lower half undraggable.
        // Centering keeps the full-height hit area. Still unfixed on astryx
        // HEAD as of 0.2.0 — verify upstream before removing this.
        pillPlacement="center"
        label={copy.resizeWorkbar}
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
