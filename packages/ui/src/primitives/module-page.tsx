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
// The ONE shell every module page (定时任务 / 每日回顾 / …) renders into: a
// centred column of rows, and one dialog for the selected row's detail. A
// docked side panel squeezes the centred column, so the detail never shares
// it. Astryx's overlay Drawer (lab only for now, API under review in
// facebook/astryx#3675) is the better home for a row's detail: switch the
// dialog to it once it ships in @astryxdesign/core.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Dialog, DialogHeader, HStack, Heading, ListItem, StackItem, Text, VStack } from '@astryxdesign/core';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { useConfirmOpen } from '../toast.js';
import { cn } from '../utils.js';

/**
 * The page column's max width. Matches the clamp the skills / MCP / settings
 * pages already use, so every main page shares one measure.
 */
const MODULE_PAGE_WIDTH = 900;

/** Label column of a detail's facts; fits 固定到技能上下文 on one line. */
export const DETAIL_LABEL_WIDTH = 120;

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
  /** The page's control bar — module switch on the left, view and filters on the right. */
  toolbar?: ReactNode;
  /**
   * Page body. LayoutContent keeps its scrollport at the outer edge while
   * aligning direct children to the same contentWidth lane as the header.
   */
  children: ReactNode;
  /** The selected row's detail, shown as a dialog; `undefined` closes it. */
  detail?: ModulePageDetail;
  /** Clears the caller's selection when the detail dialog is dismissed. */
  onDetailDismiss?: () => void;
  className?: string;
}

export interface ModulePageDetail {
  /** The item's name, not a generic "详情". */
  title: string;
  subtitle?: string;
  startContent?: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
}

/**
 * One row of a module page list. The name leads by weight and the second line
 * steps down by colour, not size: it is what the item does, read as prose.
 */
export function ModuleRow(props: {
  label: ReactNode;
  description?: ReactNode;
  mark?: ReactNode;
  end?: ReactNode;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  return (
    <ListItem
      label={<Text weight="medium" maxLines={1}>{props.label}</Text>}
      description={props.description ? <Text color="secondary" maxLines={1}>{props.description}</Text> : undefined}
      startContent={props.mark}
      endContent={props.end}
      isSelected={props.isSelected}
      onClick={props.onClick}
    />
  );
}

export function ModulePageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VStack gap={2} className="maka-module-page-section">
      <Heading level={2} className="maka-module-section-heading">{title}</Heading>
      {children}
    </VStack>
  );
}

export function ModulePage({
  title,
  meta,
  actions,
  toolbar,
  children,
  detail,
  onDetailDismiss,
  className,
}: ModulePageProps) {
  // The dialog keeps showing the last detail while it animates closed.
  const lastDetailRef = useRef(detail);
  if (detail) lastDetailRef.current = detail;
  const shownDetail = detail ?? lastDetailRef.current;
  // A confirm (删除 and the like) replaces the detail rather than stacking on
  // it; the detail comes back if the confirm is cancelled.
  const confirmOpen = useConfirmOpen();
  const open = detail != null && !confirmOpen;

  // Focus is settled here, not left to Astryx: it returns focus to whatever
  // was focused when the dialog opened, which after the editor or a confirm
  // hands the detail back is a control of that dialog, gone by then. The row
  // is recorded in a layout effect, before Astryx's open effect moves focus,
  // and focus moves a frame later, after the other dialog's close has run.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (open && active instanceof HTMLElement && !active.closest('dialog')) {
      openerRef.current = active;
      return;
    }
    const frame = requestAnimationFrame(() => {
      // The header title, which Astryx makes the dialog's initial focus.
      if (open) dialogRef.current?.querySelector<HTMLElement>('[tabindex="-1"]')?.focus();
      else if (openerRef.current?.isConnected && !document.querySelector('dialog[open]')) openerRef.current.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const dismiss = (open: boolean) => {
    if (!open) onDetailDismiss?.();
  };

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
        <LayoutContent>
          {children}
          {/* Stays mounted and opens by `isOpen`: Astryx returns focus to the
              row on the open→closed transition, which an unmount would skip.
              Astryx names the dialog from a header present at mount, and this
              one mounts empty, so the name is passed explicitly. */}
          <Dialog ref={dialogRef} isOpen={open} onOpenChange={dismiss} purpose="info" width={560} aria-label={shownDetail?.title}>
            {shownDetail ? (
              <Layout
                header={(
                  <DialogHeader
                    title={shownDetail.title}
                    subtitle={shownDetail.subtitle}
                    startContent={shownDetail.startContent}
                    onOpenChange={dismiss}
                  />
                )}
                content={<LayoutContent>{shownDetail.content}</LayoutContent>}
                footer={shownDetail.footer ? <LayoutFooter>{shownDetail.footer}</LayoutFooter> : undefined}
              />
            ) : null}
          </Dialog>
        </LayoutContent>
      )}
    />
  );
}
