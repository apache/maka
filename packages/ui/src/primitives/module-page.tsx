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

// packages/ui/src/primitives/module-page.tsx
//
// The ONE shell every module page (定时任务 / 每日回顾 / …) renders into.
//
// Built on Astryx `Layout` rather than a hand-rolled grid, following the
// `incident-console` page template — the vendor's archetype for exactly this
// page: dense rows, not cards, with a resizable inspector panel beside them.
// Layout owns what we used to own by hand: header/content/panel zones,
// padding collapse between adjacent slots, and scroll containment.
//
// `contentWidth` clamps the page into a centred column, the way every other
// main page in this app is clamped — nothing here runs edge to edge. Astryx
// applies the same `--layout-content-width` to the header's inner wrapper and
// to the body row, and both centre inside the full plate width, so the title
// keeps the rows' left edge. The inspector rides INSIDE that column rather
// than beside it, which is what keeps the two aligned when it opens.
//
// Header shape is the template's, too: title, one quiet supporting line and
// the actions on one row, then the page's control bar as the header's last
// row. No lede paragraph, so the page opens straight into its content instead
// of spending three stacked tiers before the first row.
//
// No rules anywhere in the page chrome — not under the header, not beside the
// inspector. The only lines on the page are the list's own row dividers, which
// say where a row ends; a header rule and a panel rule would only restate a
// boundary the layout already draws, and this app separates columns tonally
// (DESIGN.md, One Working Plane) rather than with hairlines. The inspector's
// own surface IS that tonal step — see `.maka-module-page .astryx-layout-panel`
// in module-shell.css. Until it was painted this paragraph described an
// intention rather than the page: the panel inherited the content column's
// white, so the columns were separated neither tonally nor by a line, and the
// inspector read as loose content instead of a region beside the list.

import { useEffect, useRef, type ReactNode } from 'react';
import { Dialog, DialogHeader, HStack, Heading, StackItem, Text, VStack } from '@astryxdesign/core';
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { cn } from '../utils.js';

/**
 * The page column's max width. Matches the clamp the skills / MCP / settings
 * pages already use, so every main page shares one measure.
 */
const MODULE_PAGE_WIDTH = 900;

export interface ModulePageProps {
  /** Page title. Also the `main` landmark's accessible name. */
  title: string;
  /**
   * One quiet line beside the title — a live count, not a description
   * ("3 个进行中", "今天"). The vendor header carries a supporting line here
   * rather than a lede paragraph below.
   */
  meta?: ReactNode;
  /** Right-aligned header cluster: the primary action, then any overflow menu. */
  actions?: ReactNode;
  /**
   * The page's control bar — module switch on the left, this page's view and
   * filters on the right. It belongs to the whole page, not to the list, so it
   * lives in the header above the content/inspector split. Its own bottom
   * hairline is then the ONE horizontal rule on the page, and the inspector's
   * vertical divider starts exactly where that rule ends.
   */
  toolbar?: ReactNode;
  /** Page body. Rendered edge-to-edge; the caller owns its own padding. */
  children: ReactNode;
  /**
   * Inspector content for the selected item. `undefined` hides the panel and
   * its resize handle entirely — an empty panel is dead width, not a
   * placeholder. Below the two-column breakpoint the SAME content opens as a
   * dialog instead, so the actions it carries never become unreachable.
   */
  inspector?: ReactNode;
  /** Accessible name for the inspector panel landmark. */
  inspectorLabel?: string;
  /**
   * Clears the caller's selection. Required for the narrow-window dialog: a
   * dialog owns a close affordance the side panel does not need, and closing
   * it must deselect rather than leave a hidden selection behind.
   */
  onInspectorDismiss?: () => void;
  /** localStorage key so a dragged inspector width survives a relaunch. */
  inspectorAutoSaveId?: string;
  className?: string;
}

export function ModulePage({
  title,
  meta,
  actions,
  toolbar,
  children,
  inspector,
  inspectorLabel,
  inspectorAutoSaveId,
  onInspectorDismiss,
  className,
}: ModulePageProps) {
  // The `incident-console` template's own answer to a narrow window: drop the
  // end panel rather than squeeze two columns into one. Below this width the
  // rows would have less room than their own content needs.
  //
  // Dropping the PANEL cannot mean dropping the inspector: rows are inert by
  // design — every per-item action lives in the inspector — so a narrow window
  // that hid it would leave enable/pause, trigger, snooze, edit, duplicate,
  // clear and delete with no reachable path at all. The app's own floor is
  // 480px wide (SAFE_MIN_WIDTH), so this is a window a user really has. Narrow
  // therefore changes the inspector's PLACEMENT, not its existence: the same
  // content opens as a dialog over the list.
  const isNarrow = useMediaQuery('(max-width: 1024px)');
  // Crossing the breakpoint with something selected must not open a modal on
  // its own: a window resize is not an action on this page, and a dialog that
  // appears unbidden takes focus and covers the list the reader was in.
  // Dropping the selection at the crossing keeps the surface honest in both
  // directions — the placement only ever changes on the user's next click.
  // The viewport IS the external system here, which is what this Effect syncs.
  const wasNarrowRef = useRef(isNarrow);
  useEffect(() => {
    if (wasNarrowRef.current === isNarrow) return;
    wasNarrowRef.current = isNarrow;
    onInspectorDismiss?.();
  }, [isNarrow, onInspectorDismiss]);
  // Hooks cannot be conditional, so the region always exists; only the panel
  // and its handle are conditional on there being something to inspect.
  // Sized against the clamped column, not the window: the inspector shares
  // MODULE_PAGE_WIDTH with the rows, so a panel tuned for a full-bleed page
  // would leave the list too little of it.
  const inspectorPanel = useResizable({
    defaultSize: 320,
    minSizePx: 280,
    maxSizePx: 420,
    autoSaveId: inspectorAutoSaveId,
  });

  return (
    <Layout
      height="fill"
      contentWidth={MODULE_PAGE_WIDTH}
      // The app shell is itself a full-bleed Layout, and
      // `--layout-padding-outer-x: 0` inherits into every nested one — the page
      // title would sit flush against the pane edge, 20px left of its own rows.
      // Restating the step here re-anchors the header on the content's column.
      padding={5}
      className={cn('maka-module-page', className)}
      header={
        <LayoutHeader>
          <VStack gap={4}>
            {/* Wraps rather than squeezes. `StackItem size="fill"` carries its
                own `min-width: 0`, so on a nowrap row a narrow window
                compresses the title instead of moving the actions down: at the
                480px window floor that left 定时任务 running one glyph per
                line, 112px of vertical title. Wrapping sends the actions to
                their own row and hands the title back its line. */}
            <HStack gap={3} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Heading level={1}>{title}</Heading>
                  {meta != null ? (
                    <Text type="supporting" color="secondary">
                      {meta}
                    </Text>
                  ) : null}
                </HStack>
              </StackItem>
              {actions}
            </HStack>
            {toolbar}
          </VStack>
        </LayoutHeader>
      }
      content={(
        <LayoutContent padding={0}>
          {children}
          {/* Mounted for the whole narrow session, opened by `isOpen`: Astryx
              returns focus on the open→closed transition, and a dialog that
              unmounted instead would drop focus on `body` every dismiss. */}
          {isNarrow ? (
            <Dialog
              isOpen={inspector != null}
              onOpenChange={(open) => {
                if (!open) onInspectorDismiss?.();
              }}
              // `info`: a detail sheet is not a flow to complete, so every exit
              // — Escape, backdrop, the close button — should work.
              purpose="info"
              width={420}
            >
              <Layout
                header={<DialogHeader title={inspectorLabel ?? title} onOpenChange={(open) => {
                  if (!open) onInspectorDismiss?.();
                }} />}
                content={<LayoutContent>{inspector}</LayoutContent>}
              />
            </Dialog>
          ) : null}
        </LayoutContent>
      )}
      end={
        inspector != null && !isNarrow ? (
          <>
            {/* No divider, and no grip at rest either (`isAlwaysVisible`
                defaults to true): the panel's own edge is already the
                boundary, and a standing rule or a standing pill would be a
                second one drawn on top of it. Both appear on hover/focus,
                which is what the vendor's own `incident-console` does. */}
            <ResizeHandle
              direction="horizontal"
              isReversed
              isAlwaysVisible={false}
              resizable={inspectorPanel.props}
            />
            {/* `role` is what makes `label` an accessible name: Astryx passes
                both straight to the div, and `aria-label` on a roleless div
                names nothing. */}
            <LayoutPanel role="complementary" resizable={inspectorPanel.props} label={inspectorLabel} padding={5}>
              {inspector}
            </LayoutPanel>
          </>
        ) : undefined
      }
    />
  );
}
