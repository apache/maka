// packages/ui/src/primitives/section-header.tsx
//
// Convergence round 5: the ONE "section title (+ count / subtitle) +
// trailing action" header. Before this, three dialects were hand-rolled:
// skills' span-row (label + N 个), daily-review's h4 with a colored
// accent bar, and permission's h4 + small + trailing button.
//
// Styled with package-owned semantic classes; call sites keep their wrapper
// call sites keep their wrapper classes for page-pinned CSS placement.

import type { ReactNode } from 'react';
import { cn } from '../utils.js';

export interface SectionHeaderProps {
  title: ReactNode;
  /** `id` on the title element, for a section's `aria-labelledby` link. */
  titleId?: string;
  /** Muted trailing count (e.g. "3 个" / "2 份"). */
  count?: ReactNode;
  /** One quiet line under the title (permission's layer explainer). */
  subtitle?: ReactNode;
  /** Right-aligned action cluster (button / filter pills). */
  action?: ReactNode;
  /** Leading accent bar (daily-review's section marker). */
  accent?: boolean;
  /** Heading level for the title, or a non-heading `span`. `h3` is for a
   *  section that sits directly under a page `h2` (关于 privacy, 数据 config). */
  as?: 'h3' | 'h4' | 'span';
  className?: string;
}

export function SectionHeader({
  title,
  titleId,
  count,
  subtitle,
  action,
  accent = false,
  as: Tag = 'span',
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn('maka-section-header', className)}
      data-slot="section-header"
    >
      <div className="maka-section-header-content">
        <Tag
          id={titleId}
          className={cn(
            'maka-section-header-title',
            accent && 'maka-section-header-title-accent',
          )}
          data-slot="section-header-title"
        >
          {title}
          {count != null && (
            <small
              className="maka-section-header-count"
              data-slot="section-header-count"
            >
              {count}
            </small>
          )}
        </Tag>
        {subtitle != null && (
          <small
            className="maka-section-header-subtitle"
            data-slot="section-header-subtitle"
          >
            {subtitle}
          </small>
        )}
      </div>
      {action != null && (
        <div className="maka-section-header-action" data-slot="section-header-action">
          {action}
        </div>
      )}
    </div>
  );
}
