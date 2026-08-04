import { lazy, Suspense, useState, type CSSProperties } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { ResizeHandle, type ResizableProps } from '@astryxdesign/core/Resizable';
import { useUiLocale } from '@maka/ui';
import type { ChatModelChoice, SessionSummary } from '@maka/core';
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
    <Card
      variant="transparent"
      padding={0}
      height="100%"
      className="maka-session-workbar"
      data-maka-contract="session-workbar"
      role="status"
      aria-busy="true"
      aria-label={copy.loadingWorkbarLabel}
    >
      <div className="maka-lazy-fallback" data-surface="panel">{copy.loadingWorkbar}</div>
    </Card>
  );
}

/**
 * The artifacts column of the sessions surface (issue #1043): the workbar
 * resize handle plus the lazy-mounted SessionWorkbar (task ledger, embedded
 * browser, artifact pane). AppShell renders this beside an active session
 * inside the sessions module and nowhere else, so it is not part of the
 * always-mounted chat surface. Collapsed it is an empty animating box; the
 * column itself mounts and unmounts inside it.
 */
interface ChatWorkbarProps {
  activeId: string;
  /** Shell state. Collapsed, the column leaves — after it has animated out. */
  collapsed: boolean;
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
  collapsed,
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
  // One question, one state: has the column finished sliding off? Nothing else
  // has to be tracked, because the two moments that matter are already legible
  // without state — `collapsed` is false the instant the column should be back,
  // and the box's own transition ending is the instant it is off screen. So the
  // only writer is that event, and it writes the direction it just finished.
  //
  // A boolean per direction, reconciled during render, is the shape this had
  // first, and it was wrong twice over: `collapsed` and `wasCollapsed` are the
  // same fact stored twice, and clearing the leave flag on every end — including
  // the ends where it is already clear — leaves a same-value update queued that
  // React later replays over the render-phase update arming the NEXT collapse.
  // Measured: the first collapse animated, every collapse after it tore the
  // column down 5ms in and ran the 280ms slide on an empty box.
  const [isGone, setIsGone] = useState(collapsed);
  const showsColumn = !collapsed || !isGone;

  return (
    <>
      {/* Outside the clipping wrapper below: the handle sits a pixel to the
          LEFT of the column it sizes, so inside it the seam control would be
          the one thing `overflow: hidden` cut off. It is also not part of the
          column's motion — there is nothing to size while the column leaves,
          which is why it goes on `collapsed` and not on the column's own
          lifetime: a handle still live during the slide would let a drag write
          a width the user cannot see, and only find out at the next expand. */}
      {!collapsed && (
      <ResizeHandle
        className="maka-workbar-resize-handle"
        resizable={workbarResizable}
        direction="horizontal"
        // The workbar sits at the end of the row, so dragging toward the start
        // must widen it.
        isReversed
        isAlwaysVisible={false}
        // No `hasDivider`. The shell separates its columns by surface tone, not
        // by rules: the sidebar's own border is zeroed out and the seam you see
        // on the left is `--background` meeting the content plate. A hairline
        // here was a second, contradictory seam language — and one this column
        // could not draw properly anyway, since the shared handle rule starts
        // every handle below the titlebar so the drag strip cannot swallow it.
        // The workbar's surface has no such offset, so the tonal seam runs the
        // column's full height the way the left one does.
        // Astryx offsets a side-placed horizontal grab zone with
        // `translateY(-50%)` on top of `top: 0; bottom: 0`, which lifts it half
        // its height off the divider and makes the lower half undraggable.
        // Centering keeps the full-height hit area. Still unfixed on astryx
        // HEAD as of 0.2.0 — verify upstream before removing this.
        pillPlacement="center"
        label={copy.resizeWorkbar}
      />
      )}
      {/* The width lives on this wrapper, not on the column, for the reason the
          sidebar rail already documents: a transition needs an element that
          exists on BOTH sides of the toggle. The column itself is unmounted
          while collapsed — it polls tasks and can hold a live embedded browser,
          neither of which should keep running behind a closed panel — so it can
          never be that element. Closed, this is an empty box at zero width.

          It also clips, which is what lets the column keep its own full width on
          the way out (`min-width` there) and slide off rather than reflow its
          tabs into each other frame by frame. */}
      <div
        className="maka-workbar-motion"
        data-collapsed={collapsed || undefined}
        /* The user's dragged width, on the box that animates it. The column
           inside reads the same property by inheritance, so it holds that width
           while this box narrows past it. */
        style={{ '--maka-session-workbar-width': `${width}px` } as CSSProperties}
        /* The one event that says the column is off screen. Every path this app
           has for suppressing motion — OS reduced-motion, the e2e-fixture
           attribute — caps `transition-duration` to 0.01ms rather than setting
           `transition: none`, precisely so state changes stay observable; that
           is what keeps this from being a teardown that never fires. */
        onTransitionEnd={(event) => {
          if (event.propertyName === 'width' && event.currentTarget === event.target) {
            setIsGone(collapsed);
          }
        }}
      >
      {showsColumn && (
      <Suspense fallback={<SessionWorkbarFallback />}>
        <SessionWorkbar
          key={activeId}
          sessionId={activeId}
          browserLive={browserLive}
          hidden={hidden}
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
      )}
      </div>
    </>
  );
}
