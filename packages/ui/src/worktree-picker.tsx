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

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSubMenu } from '@astryxdesign/core/DropdownMenu';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ICON_SIZE, Check, GitBranch, Monitor, Plus, Search } from './icons.js';
import { getWorktreeCopy } from './worktree-copy.js';
import { useUiLocale } from './locale-context.js';
import type { WorkspacePickerWorktreeMenu } from './workspace-picker.js';

export function WorktreePicker({ menu, disabled, compact = false }: {
  menu: WorkspacePickerWorktreeMenu;
  disabled?: boolean;
  compact?: boolean;
}) {
  const copy = getWorktreeCopy(useUiLocale());
  const [menuGeneration, setMenuGeneration] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const [existingOpen, setExistingOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setMenuGeneration((generation) => generation + 1);
      setExistingOpen(false);
    }
  }, []);
  const existing = menu.options.filter((option) => option.value !== 'main' && option.value !== 'new');
  const searchable = existing.length >= 10;
  // The root menu defers its opening focus to a frame; focus search after it.
  useEffect(() => {
    if (!searchable || searchFocusRequest === 0) return;
    const frame = requestAnimationFrame(() => {
      const input = searchRef.current;
      if (input && input.getClientRects().length > 0) input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchFocusRequest, searchable]);
  const requestSearchFocus = (target: EventTarget | null) => {
    if (searchable && target instanceof Element && target.closest('[role="menuitem"][aria-haspopup="menu"]')) {
      setSearchFocusRequest((request) => request + 1);
    }
  };
  const selected = menu.options.find((option) => option.value === menu.value);
  const label = menu.value === 'main' ? copy.main
    : menu.value === 'new' ? copy.menu.create : selected?.label ?? copy.unavailable;
  const icon = menu.value === 'main' ? <Monitor size={ICON_SIZE.meta} aria-hidden="true" />
    : menu.value === 'new' ? <Plus size={ICON_SIZE.meta} aria-hidden="true" />
    : <GitBranch size={ICON_SIZE.meta} aria-hidden="true" />;
  return (
    <DropdownMenu
      placement="above"
      className="maka-composer-quiet-menu"
      onOpenChange={handleOpenChange}
      button={{
        label: compact ? copy.menu.choose(label) : label,
        icon, variant: 'ghost', size: 'sm',
        isIconOnly: compact,
        className: 'maka-worktree-picker',
        isDisabled: disabled || menu.pending,
        isLoading: menu.pending,
        tooltip: copy.chooseTitle,
        'aria-label': copy.menu.choose(label),
      }}
    >
      {menu.options.filter((option) => option.value === 'main' || option.value === 'new').map((option) => (
        <DropdownMenuItem
          key={option.value}
          label={option.value === 'main' ? copy.main : copy.menu.create}
          icon={option.value === 'main'
            ? <Monitor size={ICON_SIZE.meta} aria-hidden="true" />
            : <Plus size={ICON_SIZE.meta} aria-hidden="true" />}
          isDisabled={disabled || option.disabled}
          endContent={menu.value === option.value ? <Check size={ICON_SIZE.control} aria-hidden="true" /> : undefined}
          onClick={() => menu.onSelect(option.value)}
        />
      ))}
      {existing.length > 0 ? (
        <div
          onClickCapture={(event) => requestSearchFocus(event.target)}
          onKeyDownCapture={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') requestSearchFocus(event.target);
          }}
        >
          <DropdownMenuSubMenu
            key={menuGeneration}
            label={copy.menu.existing}
            icon={<GitBranch size={ICON_SIZE.meta} aria-hidden="true" />}
            isDisabled={disabled}
            onOpenChange={setExistingOpen}
          >
            {existingOpen ? <ExistingWorktrees menu={menu} disabled={disabled} searchRef={searchRef} /> : null}
          </DropdownMenuSubMenu>
        </div>
      ) : null}
    </DropdownMenu>
  );
}

function ExistingWorktrees({ menu, disabled, searchRef }: {
  menu: WorkspacePickerWorktreeMenu;
  disabled?: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const copy = getWorktreeCopy(useUiLocale());
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const existing = menu.options.filter((option) => option.value !== 'main' && option.value !== 'new');
  const searchable = existing.length >= 10;
  const query = searchable ? search.trim().toLowerCase() : '';
  const filtered = existing.filter((option) => option.label.toLowerCase().includes(query));
  return (
    <div className="maka-worktree-existing">
      {searchable ? (
        <div className="maka-worktree-search">
          <TextInput
            ref={searchRef}
            role="searchbox"
            label={copy.menu.search}
            isLabelHidden
            startIcon={<Search size={ICON_SIZE.meta} aria-hidden="true" />}
            size="sm"
            width="100%"
            isDisabled={disabled}
            placeholder={copy.menu.search}
            value={search}
            onChange={setSearch}
            onInput={(event) => {
              if (event.target instanceof HTMLInputElement) setSearch(event.target.value);
            }}
            onClick={(event) => {
              // The composer also focuses its editor on bubbled clicks.
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const items = listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])');
                items?.[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
              }
              // Menu typeahead and Space activation must not consume typing.
              event.stopPropagation();
            }}
          />
        </div>
      ) : null}
      <div
        ref={listRef}
        className="maka-worktree-existing-list"
      >
        {filtered.map((option) => (
          <DropdownMenuItem
            key={option.value}
            label={option.label}
            icon={<GitBranch size={ICON_SIZE.meta} aria-hidden="true" />}
            isDisabled={disabled || option.disabled}
            endContent={menu.value === option.value ? <Check size={ICON_SIZE.control} aria-hidden="true" /> : undefined}
            onClick={() => menu.onSelect(option.value)}
          />
        ))}
        {filtered.length === 0 ? <EmptyState
          title={copy.menu.noMatches}
          isCompact
          onClick={(event) => event.stopPropagation()}
          actions={<Button label={copy.menu.clearSearch} variant="ghost" size="sm" isDisabled={disabled}
            onClick={() => {
              setSearch('');
              searchRef.current?.focus({ preventScroll: true });
            }} />}
        /> : null}
      </div>
    </div>
  );
}
