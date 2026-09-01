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

import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { getConversationCopy } from './conversation-copy.js';
import { ICON_SIZE, Archive, Trash2 } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { useSessionRailSelection } from './session-rail-context.js';

/**
 * The rail's selection mode, headed.
 *
 * The master box sits directly above the rows it governs and in the same
 * leading column as theirs, so "all of these" is a claim the eye can check
 * rather than a label to be trusted. It is `indeterminate` whenever some but
 * not all listed rows are marked — the one state a plain checked/unchecked pair
 * cannot express, and the usual state during a selection.
 *
 * "All" means every row the rail is listing, which is what sits under the box.
 * Not every task in the catalog: a box that silently included rows behind a
 * collapsed project would name a number the user never agreed to.
 *
 * The commands are `secondary`, not `ghost`: ghost renders as bare text, and a
 * label with no container beside a checkbox and a count does not read as
 * something to press. Both carry the same container so neither is the primary —
 * one of them is destructive and must not be emphasised by accident.
 *
 * TWO ROWS, because one does not fit. The rail is 180px at its narrowest and
 * 260px by default; the first attempt put count and three text buttons on one
 * line, which measured 228px of a 244px bar and squeezed the count to 12px,
 * where it wrapped one character per line. Vertical space in a rail is cheap.
 */
export function SessionSelectionBar() {
  const selection = useSessionRailSelection();
  const copy = getConversationCopy(useUiLocale()).sessions;
  if (!selection?.active) return null;
  const listed = selection.listedSessionIds;
  const count = selection.selectedIds.size;
  const busy = selection.busy === true;
  const allMarked = listed.length > 0 && listed.every((id) => selection.selectedIds.has(id));
  const master: boolean | 'indeterminate' = count === 0 ? false : allMarked ? true : 'indeterminate';
  return (
    <div className="maka-session-selection-bar" aria-label={copy.selectionBarAriaLabel} role="group">
      <div className="maka-session-selection-bar-head">
        <CheckboxInput
          size="sm"
          value={master}
          label={copy.selectAllAriaLabel}
          isLabelHidden
          isDisabled={busy || listed.length === 0}
          onChange={(checked) => selection.onToggleAll(checked)}
        />
        {/* `aria-live` so the count reaches a screen reader as it changes: the
            bar is not focused while the user is ticking rows, so nothing else
            would say how many are marked. */}
        <span className="maka-session-selection-count" aria-live="polite">
          {copy.selectedCount(count, listed.length)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          // Not disabled while a sweep runs: leaving asks nothing of the Host,
          // and a user who changed their mind should not have to wait for the
          // action they no longer want.
          onClick={() => selection.onExit()}
          label={copy.selectionClear}
        />
      </div>
      <div className="maka-session-selection-actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Archive size={ICON_SIZE.meta} />}
          isDisabled={busy || count === 0}
          onClick={() => void selection.onArchiveSelected()}
          label={copy.selectionArchive}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Trash2 size={ICON_SIZE.meta} />}
          isDisabled={busy || count === 0}
          onClick={() => void selection.onDeleteSelected()}
          label={copy.selectionDelete}
        />
      </div>
    </div>
  );
}
