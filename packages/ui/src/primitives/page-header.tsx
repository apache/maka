// packages/ui/src/primitives/page-header.tsx
//
// PageHeader — the shared header shell for the SETTINGS intro dialect:
//
//   SETTINGS intros (as='h3', or as='h2' for the About hero): the smaller
//      Permission / Health / About page intro cards — a body-tier
//      semibold title, a lede, and a trailing quieter META cluster
//      (RelativeTime + refresh Button) or a leading feature ICON + trailing
//      BADGE chip. Previously `.settingsPermissionIntro`,
//      `.settingsHealthIntro`, `.settingsAboutHero`.
//
//   The MODULE-page dialect this primitive also used to serve (the
//   `.maka-module-main-header` hero) is retired: 技能 / MCP / 定时任务 /
//   每日回顾 moved onto the ModulePage primitive, whose Astryx Layout header
//   owns title + meta + actions.
//
// Layout & typography strategy: the shell is styled with portable semantic
// utilities, but every call site KEEPS its existing wrapper class (passed via
// `className`) so the wrapper CSS — which already owns the surface chrome
// (card border/background/radius, flex vs grid layout, gap, mobile
// breakpoints) and the per-slot typography (`.settingsPermissionIntro h3`,
// `.settingsAboutHero p`, …) — keeps governing the visuals unchanged.
// The primitive only converges the STRUCTURE (slot order, title/subtitle/
// eyebrow/badge/icon/actions/meta arrangement). Slots expose `data-slot`
// hooks so contracts that used to pin the old `h2`/`p` direct children can
// re-pin the primitive's slots where DOM structure genuinely moved.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export interface PageHeaderProps {
  /** Title text. Rendered as an <h2> (module scale) or <h3> (settings scale). */
  title: ReactNode;
  /** Optional lede line under the title (muted). */
  subtitle?: ReactNode;
  /**
   * Optional small caps/eyebrow line ABOVE the title (e.g. a section kicker).
   * Rendered muted+semibold before the title row.
   */
  eyebrow?: ReactNode;
  /** Optional leading glyph, rendered in a framed icon box left of the content. */
  icon?: ReactNode;
  /**
   * Optional marker rendered inline right AFTER the title (About
   * version/channel pills). Accepts one node or a fragment.
   */
  badge?: ReactNode;
  /**
   * Title heading level + scale. 'h2' = the About hero scale, 'h3' = the
   * settings intro scale. Defaults to 'h2'. The exact font-size/weight is
   * left to the wrapper CSS (`.settingsAboutHero h2`,
   * `.settingsPermissionIntro h3`, …); this only picks the semantic tag.
   */
  as?: 'h2' | 'h3';
  /** Id applied to the title element (aria-labelledby targets). */
  titleId?: string;
  /**
   * Right-aligned action cluster (buttons, search box). The cluster's own
   * positioning class (e.g. `maka-module-main-actions`, `maka-scheduled-task-top-actions`)
   * is passed as a child by the call site; the shell only slots it to the end.
   */
  actions?: ReactNode;
  /**
   * Trailing quieter cluster — the settings meta stack (RelativeTime +
   * refresh Button + optional read-only badge). Like `actions`, the cluster's
   * own class (`settingsPermissionMeta`, `settingsHealthMeta`) rides on the
   * child; the shell only slots it.
   */
  meta?: ReactNode;
  /** Wrapper class — the existing call-site hook (kept so CSS + contracts stay pinned). */
  className?: string;
  /**
   * Class for the title+subtitle content column (e.g. `maka-scheduled-task-heading`).
   * Lets a call site keep a wrapper that its CSS targets as the heading group.
   */
  contentClassName?: string;
  /** Class for the leading icon box (e.g. `settingsAboutLogo`). */
  iconClassName?: string;
  /** Class for the inline title+badge row (e.g. `settingsAboutHeading`). */
  headingRowClassName?: string;
  /** Class for the subtitle line (e.g. `settingsAboutTagline`), when a call site's CSS targets it. */
  subtitleClassName?: string;
  /** Render the wrapper as a <header> (default) or a <div>. */
  as_wrapper?: 'header' | 'div';
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  icon,
  badge,
  as = 'h2',
  titleId,
  actions,
  meta,
  className,
  contentClassName,
  iconClassName,
  headingRowClassName,
  subtitleClassName,
  as_wrapper = 'header',
}: PageHeaderProps): ReactNode {
  const Title = as;
  const Wrapper = as_wrapper;

  // The title row: the heading, then any inline badge marker. When neither a
  // badge nor a headingRow class is supplied we render the bare heading, so
  // simple call sites (skills/plan/permission/health) keep a plain `h2`/`h3`
  // as the direct descendant their CSS expects.
  const heading = (
    <Title
      id={titleId}
      data-slot="page-header-title"
      // No typography utilities here — the wrapper CSS owns h2/h3 sizing.
      className="maka-page-header-title"
    >
      {title}
    </Title>
  );
  const titleRow =
    badge != null || headingRowClassName ? (
      <div
        data-slot="page-header-heading-row"
        className={cn('maka-page-header-heading-row', headingRowClassName)}
      >
        {heading}
        {badge != null ? badge : null}
      </div>
    ) : (
      heading
    );

  const content = (
    <div
      data-slot="page-header-content"
      className={cn('maka-page-header-content', contentClassName)}
    >
      {eyebrow != null ? (
        <p data-slot="page-header-eyebrow" className="maka-page-header-eyebrow">
          {eyebrow}
        </p>
      ) : null}
      {titleRow}
      {subtitle != null ? (
        <p
          data-slot="page-header-subtitle"
          className={cn('maka-page-header-subtitle', subtitleClassName)}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );

  return (
    <Wrapper data-slot="page-header" className={className}>
      {icon != null ? (
        <span
          data-slot="page-header-icon"
          aria-hidden="true"
          className={iconClassName}
        >
          {icon}
        </span>
      ) : null}
      {content}
      {actions != null ? actions : null}
      {meta != null ? meta : null}
    </Wrapper>
  );
}
