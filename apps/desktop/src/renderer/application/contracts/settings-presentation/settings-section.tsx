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

// apps/desktop/src/renderer/settings/settings-section.tsx
//
// The ONE grouping unit for a settings page.
//
// Before this, the 14 settings pages shared no page vocabulary. 通用 stacked
// four Astryx `Card`s with NO titles — four unlabeled boxes whose grouping the
// user had to infer. 外观 used no cards at all. 权限与能力 opened with a
// `SectionHeader` repeating the page title verbatim. Five different page-root
// containers existed (`settingsStructuredPage`, `settingsUsagePage`,
// `settingsFeatureStatusPage`, `settingsHealthPage`, `settingsAboutPage`) and
// 222 bespoke `.settings*` selectors carried the difference.
//
// A settings page is a list of LABELED GROUPS. That is the whole model:
// a group states what it configures, optionally why, optionally offers one
// group-level action, and then lists its rows. `SettingsSection` is that unit,
// so a page becomes a flat list of sections and stops inventing layout.
//
// `variant`:
//   'rows' (default) — the body is the shared `.settingsRows` open row group:
//     edge-to-edge rows split by hairlines, no card chrome. This is the Astryx
//     settings idiom (see the CLI's settings/settings-dialog templates and
//     `astryx docs layout`: "no stacked full-width Cards as page structure";
//     rows are "edge-to-edge, dividers"). Cards remain for genuine callouts.
//   'bare' — the body is a plain block, for groups whose content is not a row
//     list (the 外观 option grids, a form layout, a chart). The section still
//     contributes its header, anchor divider, and page rhythm.
import type { ReactNode } from 'react';
import { Divider, Heading, HStack, Item, Text, VStack } from '@astryxdesign/core';
import { cn } from '@maka/ui';

/**
 * The ONE page-root container: a flat list of `SettingsSection`s at the open
 * idiom's 32px rhythm. Pages used to reach for the bare
 * `.settingsStructuredPage` class; the kit owns the container now, so a page
 * never references page-layout CSS directly.
 *
 * Class is `settingsPageStack`, NOT `settingsPage` — `.settingsModal.settingsPage`
 * is the pre-existing fullscreen-shell modifier and must not match this rule.
 * Deliberately a `div` + kit-owned `.settingsPageStack` grid (nav-sidebar.css),
 * NOT an Astryx `VStack`: the #1362 fix needs grid's `minmax(0, 1fr)`
 * explicit column. In a flex stack a stretched child keeps its
 * `min-width: auto` min-content floor, so one wide child (a scrollable
 * `<pre>`, a long mono path) would poke past the content column again.
 */
export function SettingsPage(props: {
  className?: string;
  /** `section` when the page is a labeled landmark of a larger surface. */
  as?: 'div' | 'section';
  'aria-label'?: string;
  children: ReactNode;
}) {
  const Tag = props.as ?? 'div';
  return (
    <Tag className={cn('settingsPageStack', props.className)} aria-label={props['aria-label']}>
      {props.children}
    </Tag>
  );
}

export function SettingsSection(props: {
  /** Group label. Omit only for a page's single unlabeled lead group. */
  title?: ReactNode;
  /** id for the title Heading; the section wires `aria-labelledby` to it so
   *  the landmark is named (remote-access e2e relies on these headings). */
  titleId?: string;
  /** One quiet line under the title explaining what the group governs. */
  description?: ReactNode;
  /** Group-level action cluster (refresh, add, filter), right-aligned. */
  action?: ReactNode;
  variant?: 'rows' | 'bare';
  className?: string;
  /** Class for the body element, when a page needs to pin its own grid. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const hasHeader = props.title != null || props.description != null || props.action != null;
  return (
    <section className={cn('settingsSection', props.className)} aria-labelledby={props.titleId}>
      {hasHeader ? (
        /* The header is Astryx's own settings idiom — `Heading level={3}` over
           a `Text type="supporting" color="secondary"` lede — as used by the
           `settings` and `settings-sidebar` page templates the CLI vendors.
           It was @maka/ui's SectionHeader, which styles the same two lines with
           hand-written Tailwind (`text-[length:var(--font-size-ui)]
           font-semibold`, a caption-sized subtitle). Deferring to Astryx means
           section typography now moves with the theme instead of with a copy
           of the theme's values. */
        /* wrap: at the 480px window floor a multi-button action cluster
           must drop under the title instead of crushing it (the old
           bot-runtime header carried a media query for this). */
        <HStack gap={3} align="start" justify="between" wrap="wrap">
          <VStack gap={0.5}>
            {props.title != null ? <Heading level={3} id={props.titleId}>{props.title}</Heading> : null}
            {props.description != null ? (
              <Text type="supporting" size="sm" color="secondary">{props.description}</Text>
            ) : null}
          </VStack>
          {props.action != null ? <div>{props.action}</div> : null}
        </HStack>
      ) : null}
      {hasHeader ? <Divider /> : null}
      {props.variant === 'bare' ? (
        <div className={cn('settingsSectionBody', props.bodyClassName)}>{props.children}</div>
      ) : (
        <div className={cn('settingsRows', props.bodyClassName)}>
          {props.children}
        </div>
      )}
    </section>
  );
}

/**
 * The ONE row unit inside a 'rows' section: label + wrapping helper line on
 * the left, one control (or read-only value) on the right. Astryx `Item` is
 * the layout; this wrapper exists for two Astryx behaviors that are wrong
 * for a settings surface, fixed once here instead of per call site:
 *
 * 1. `Item` single-line-truncates STRING descriptions. A settings helper
 *    line ("switching applies immediately and persists…") must wrap, never
 *    ellipsize — the truncated tail is exactly the part that says what the
 *    control does. Wrapping the text in a fragment makes it a ReactNode,
 *    which `Item` renders without truncation; the description span's
 *    inherited type styles still apply.
 * 2. The end slot needs a bounded share of the row. An unbounded control
 *    (SegmentedControl with English labels, a model picker trigger) would
 *    otherwise crush the label column to nothing before it wraps —
 *    `.settingsRowEnd` caps it and lets the container query in rows.css
 *    stack it under the label on narrow cards.
 *
 * `density="balanced"` (8px block, flush inline) keeps rows edge-aligned
 * with the section header text — the open idiom has no card inset, so rows
 * must not indent relative to their heading.
 */
export function SettingsRow(props: {
  label: ReactNode;
  description?: ReactNode;
  /** The row's control / value cluster, right-aligned. */
  end?: ReactNode;
  align?: 'center' | 'start';
  children?: never;
}) {
  return (
    <Item
      density="balanced"
      align={props.align}
      label={props.label}
      description={props.description == null ? undefined : <>{props.description}</>}
      endContent={props.end == null ? undefined : <span className="settingsRowEnd">{props.end}</span>}
    />
  );
}

/**
 * A full-width form block inside a 'rows' section — a `FormLayout`, one wide
 * `TextInput`/`TextArea`, or a preview body. Owns the same 12px inset as
 * `SettingsRow` via padding (not margin), so the card's hairline dividers
 * span the full card width on either side of it.
 */
export function SettingsField(props: { className?: string; children: ReactNode }) {
  return <div className={cn('settingsFieldRow', props.className)}>{props.children}</div>;
}

/** A trailing action cluster row (test/export/import buttons) in a 'rows' card. */
export function SettingsActions(props: { role?: string; 'aria-label'?: string; children: ReactNode }) {
  return (
    <div className="settingsFieldRow settingsActionRow" role={props.role} aria-label={props['aria-label']}>
      {props.children}
    </div>
  );
}
