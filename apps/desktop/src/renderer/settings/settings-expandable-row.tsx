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

import { useEffect, useRef, type ReactNode } from 'react';
import { Button, HStack, Text } from '@astryxdesign/core';
import { SettingsField, SettingsRow } from './settings-section';

/**
 * A settled value that becomes a form only when the user asks it to.
 *
 * The shape is Astryx's own — the `settings-sidebar` template's ExpandableRow
 * (`@astryxdesign/cli/templates/pages/settings-sidebar/page.tsx:140-193`): a
 * row reports its label and current value with one affordance to change it,
 * and swaps in place for the editor plus Save / Cancel. At most one row in a
 * group is open at a time, which is the caller's `expandedRow` state.
 *
 * The shape is copied; the template's implementation is not, because it has
 * three problems this component exists to not have:
 *
 * 1. The template's trigger is `<a href="#">` with `preventDefault`. That
 *    announces itself as a link, ignores Space, and points nowhere. Opening a
 *    form is a button.
 *
 * 2. The template has no focus management at all. Expanding moves focus into
 *    the editor here, and Save / Cancel return it to the trigger the user came
 *    from — otherwise collapsing drops focus to the top of the document and a
 *    keyboard user loses their place in the list.
 *
 * 3. The template's Cancel only closes; its fields edit live, so there is
 *    nothing to discard. Ours is a real discard: the caller reverts its draft
 *    in `onCancel`, which is what makes Cancel mean anything.
 *
 * Built on `SettingsRow` rather than a bare HStack so the collapsed row keeps
 * the Item vocabulary the rest of the surface uses — the `settingsRowEnd`
 * width ceiling and the container queries in rows.css apply here too. The
 * expanded editor sits in a `SettingsField`, the same full-width block a
 * permanently-open input would use.
 */
export function SettingsExpandableRow(props: {
  label: string;
  /** The settled value, shown while collapsed. */
  value: ReactNode;
  /** Label for the affordance that opens the editor (更改 / 设置 / 编辑).
   *  Unused when `end` supplies the row's own cluster. */
  actionLabel?: string;
  /** A specific accessible name when neighboring rows share the same visible action label. */
  actionAriaLabel?: string;
  /**
   * Replaces the built-in 更改 trigger for rows that already own their end
   * slot — a project row carries a default Badge, a 设为默认 button and a …
   * menu, and editing is reached from that menu rather than from a second
   * button competing with them. The editor, its focus move, and the
   * save/cancel pair stay identical either way, which is the whole reason
   * this lives here instead of being hand-rolled per page.
   */
  end?: ReactNode;
  isEditing: boolean;
  isDisabled?: boolean;
  /** Save stays disabled until the draft actually differs from the value. */
  canSave?: boolean;
  saveLabel: string;
  cancelLabel: string;
  onEdit(): void;
  onCancel(): void;
  onSave(): void | Promise<void>;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // Only pull focus for a transition the user drove. Without this the row
  // would grab focus on first paint whenever a caller mounts already-expanded.
  const wasEditingRef = useRef(props.isEditing);

  useEffect(() => {
    const opened = props.isEditing && !wasEditingRef.current;
    const closed = !props.isEditing && wasEditingRef.current;
    wasEditingRef.current = props.isEditing;
    if (opened) {
      // The first control the editor renders, whatever the caller put there.
      const first = editorRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
      return;
    }
    if (closed) triggerRef.current?.focus();
  }, [props.isEditing]);

  // The collapsed row carries no aria-expanded / aria-controls on purpose.
  // Those describe a disclosure — a trigger that stays put while a region
  // beside it opens — and this is a mode swap: the trigger unmounts when the
  // editor replaces it, so aria-expanded could never reach true and
  // aria-controls would name a node that does not exist while collapsed.
  // Declaring a contract the DOM never honours is worse than declaring none;
  // the focus move is what tells assistive tech the mode changed, and that
  // part is measured rather than assumed.
  if (!props.isEditing) {
    return (
      <SettingsRow
        label={props.label}
        description={props.value}
        align="start"
        end={props.end ?? (
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            isDisabled={props.isDisabled}
            onClick={props.onEdit}
            label={props.actionLabel ?? ''}
            aria-label={props.actionAriaLabel}
          />
        )}
      />
    );
  }

  return (
    <SettingsField className="settingsExpandableField">
      <div ref={editorRef} className="settingsExpandableEditor">
        {/* The label survives the swap. Collapsed, the row's own label names
            the value; expanded, the editor would otherwise be an unlabelled
            box — the user pressed 更改 on something and must still be able to
            see what. The caller hides the control's own label instead, so the
            name is stated once. */}
        <Text type="body" weight="semibold">{props.label}</Text>
        {props.children}
        <HStack gap={2} hAlign="end">
          <Button
            variant="primary"
            isDisabled={props.isDisabled || props.canSave === false}
            clickAction={() => props.onSave()}
            label={props.saveLabel}
          />
          <Button
            variant="ghost"
            isDisabled={props.isDisabled}
            onClick={props.onCancel}
            label={props.cancelLabel}
          />
        </HStack>
      </div>
    </SettingsField>
  );
}
