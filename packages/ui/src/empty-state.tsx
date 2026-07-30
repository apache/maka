import type { ReactNode } from 'react';
import type { Search } from './icons.js';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './primitives/empty.js';
import { Button as UiButton, cn } from './ui.js';

type EmptyStateIcon = typeof Search;

/**
 * PR-EMPTY-STATE-COMPONENT-0: shared empty-state container. Folds the
 * 4 visual duplicates (skills empty / sessions empty / module fallbacks /
 * plan reminders empty) into a single declaration so the next empty
 * surface lands consistent by default and the icon-sizing /
 * paragraph-spacing / CTA-placement decisions only live in one
 * place. The `.maka-empty-state*` CSS family is unchanged.
 *
 * Body accepts `ReactNode` so callers can keep inline `<code>` for
 * the skills install instructions; CTAs are rendered as the canonical
 * the shared Button primitive so we never grow a competing empty-state
 * action variant.
 */
interface EmptyStateProps {
  /** Required for the card variant; unused by inline. */
  Icon?: EmptyStateIcon;
  title: string;
  body: ReactNode;
  /** Convergence R5: `inline` renders a single quiet muted line (no icon,
   *  no card) for in-flow "waiting/none yet" notes; `card` is the full
   *  empty surface. */
  variant?: 'card' | 'inline';
  cta?: { label: string; onClick: () => void; disabled?: boolean };
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean };
  /** Optional extra class on the container (e.g. `maka-plan-empty`). */
  extraClassName?: string;
  /** Optional `data-empty-view` passthrough for e2e-fixture selectors. */
  dataEmptyView?: string;
}

export function EmptyState(props: EmptyStateProps) {
  if (props.variant === 'inline') {
    return (
      <p
        className={cn(
          'm-0 text-[length:var(--font-size-ui)] leading-normal text-[color:var(--muted-foreground)]',
          props.extraClassName,
        )}
        data-slot="empty-state-inline"
        data-empty-view={props.dataEmptyView}
      >
        {props.title}
        {props.body != null && props.body !== '' ? <> · {props.body}</> : null}
      </p>
    );
  }
  // `border` before `border-border`: on its own, `border-border` sets only a
  // colour, so the card shipped at border-width 0 and the edge the author
  // meant to draw never rendered. What was actually outlining the card was
  // the `0 0 0 1px var(--border)` ring inside `shadow-maka-panel` — and that
  // shadow is the OVERLAY family (mention popup, model picker, select popup,
  // dialog). This is an in-page card, so it carried a floating panel's
  // drop shadow for no reason and leaned on its ring for the missing border.
  // One real hairline instead, same token as .settingsRows / the skill cards.
  const className = cn(
    'maka-empty-state rounded-md border border-border bg-card/70 p-8 text-card-foreground',
    props.extraClassName,
  );
  return (
    <Empty className={className} data-empty-view={props.dataEmptyView}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="maka-empty-state-media">
          {props.Icon && <props.Icon className="maka-empty-state-icon size-6 text-muted-foreground" />}
        </EmptyMedia>
        <EmptyTitle className="maka-empty-state-title">{props.title}</EmptyTitle>
        <EmptyDescription className="maka-empty-state-body">{props.body}</EmptyDescription>
      </EmptyHeader>
      {(props.cta || props.secondaryCta) && (
        <EmptyContent className="maka-empty-state-actions mt-0">
          {props.cta && (
            <UiButton
              className="maka-empty-state-cta"
              type="button"
              onClick={props.cta.onClick}
              disabled={props.cta.disabled}
            >
              {props.cta.label}
            </UiButton>
          )}
          {props.secondaryCta && (
            <UiButton
              variant="ghost"
              className="maka-empty-state-cta"
              type="button"
              onClick={props.secondaryCta.onClick}
              disabled={props.secondaryCta.disabled}
            >
              {props.secondaryCta.label}
            </UiButton>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}
