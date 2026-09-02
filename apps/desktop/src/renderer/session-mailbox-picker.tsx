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

import { useMemo, useRef } from 'react';
import type { SessionMailboxTarget } from '@maka/runtime-host/protocol';
import {
  AstryxLocaleProvider,
  CommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  type SearchableItem,
  type SearchSource,
  useUiLocale,
} from '@maka/ui';
import { getShellCopy } from './locales/shell-copy';

type TargetItem = SearchableItem<{ target: SessionMailboxTarget }>;

export function SessionMailboxPicker(props: {
  targets: readonly SessionMailboxTarget[];
  onOpenChange(open: boolean): void;
  onSelect(target: SessionMailboxTarget): void;
}) {
  const copy = getShellCopy(useUiLocale()).app;
  const pendingTargetRef = useRef<SessionMailboxTarget | undefined>(undefined);
  const items = useMemo<TargetItem[]>(
    () =>
      props.targets.map((target) => ({
        id: target.sessionId,
        label: target.name,
        auxiliaryData: { target },
      })),
    [props.targets],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const searchSource = useMemo<SearchSource<TargetItem>>(
    () => ({
      bootstrap: () => items,
      search: (query) => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return items;
        return items.filter((item) => item.label.toLowerCase().includes(normalized));
      },
    }),
    [items],
  );

  const close = (open: boolean) => {
    props.onOpenChange(open);
    if (open) return;
    const target = pendingTargetRef.current;
    pendingTargetRef.current = undefined;
    if (target) window.requestAnimationFrame(() => props.onSelect(target));
  };

  return (
    <AstryxLocaleProvider
      overrides={{ '@astryx.commandPalette.list.label': copy.mailboxPickerResultsLabel }}
    >
      <CommandPalette
        isOpen
        onOpenChange={close}
        searchSource={searchSource}
        label={copy.mailboxPickerTitle}
        width={560}
        maxHeight="min(560px, 68vh)"
        input={(
          <CommandPaletteInput
            placeholder={copy.mailboxPickerPlaceholder}
            label={copy.mailboxPickerSearchLabel}
          />
        )}
        emptyBootstrapText={copy.mailboxPickerEmpty}
        emptySearchText={copy.mailboxPickerNoMatch}
        onValueChange={(itemId) => {
          const target = itemById.get(itemId)?.auxiliaryData?.target;
          if (!target || pendingTargetRef.current) return;
          pendingTargetRef.current = target;
          close(false);
        }}
        renderItem={(item) => {
          const target = item.auxiliaryData?.target;
          if (!target) return item.label;
          return (
            <>
              <span className="maka-palette-label">{target.name}</span>
              <span className="maka-palette-hint">
                {copy.mailboxPickerStatus[target.status]}
              </span>
            </>
          );
        }}
        footer={(
          <CommandPaletteFooter>{copy.mailboxPickerHint}</CommandPaletteFooter>
        )}
      />
    </AstryxLocaleProvider>
  );
}
