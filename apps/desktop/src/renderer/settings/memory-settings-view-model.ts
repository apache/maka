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

import type { AppSettings } from '@maka/core/settings';
import type { LocalMemoryState } from '@maka/core/local-memory';
import {
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER,
  buildLocalMemoryPromptBody,
  parseLocalMemoryMarkdown,
} from '@maka/core/local-memory';
import { redactSecrets } from '@maka/ui';
import { filterLocalMemoryEntries, localMemoryPromptPreviewBlockedReason } from './memory-settings-labels.js';
import { getMemorySettingsCopy, type MemorySettingsCopy } from '../locales/settings-memory-copy.js';

export function deriveMemorySettingsViewModel(input: {
  state: LocalMemoryState | null;
  localMemorySettings: AppSettings['localMemory'];
  draft: string;
  query: string;
  copy?: MemorySettingsCopy;
}) {
  const copy = input.copy ?? getMemorySettingsCopy('zh');
  const effective = input.state ?? {
    path: '',
    enabled: input.localMemorySettings.enabled,
    agentReadEnabled: input.localMemorySettings.agentReadEnabled,
    status: 'disabled',
    content: '',
    entryCount: 0,
    activeEntryCount: 0,
    archivedEntryCount: 0,
    entries: [],
    activeEntries: [],
    archivedEntries: [],
  } satisfies LocalMemoryState;
  const memoryDraftDirty = input.draft !== effective.content;
  const draftMemoryEntries = parseLocalMemoryMarkdown(input.draft);
  const visibleMemoryEntries = memoryDraftDirty ? draftMemoryEntries : effective;
  const memoryEntryPreviewBlockedReason = memoryDraftDirty && draftMemoryEntries.safeMode
    ? copy.previewOversize
    : '';
  const normalizedMemoryEntryQuery = input.query.trim();
  const filteredActiveEntries = filterLocalMemoryEntries(
    visibleMemoryEntries.activeEntries,
    normalizedMemoryEntryQuery,
    copy,
  );
  const filteredArchivedEntries = filterLocalMemoryEntries(
    visibleMemoryEntries.archivedEntries,
    normalizedMemoryEntryQuery,
    copy,
  );
  const rawLocalMemoryPromptPreview = buildLocalMemoryPromptBody(input.draft) ?? '';
  const localMemoryPromptPreviewTruncated = rawLocalMemoryPromptPreview.includes(LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER);
  const localMemoryPromptPreview = rawLocalMemoryPromptPreview.replace(LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER, copy.previewTruncationMarker);
  const promptPreviewBlockedReason = localMemoryPromptPreviewBlockedReason(effective, copy);

  return {
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount: filteredActiveEntries.length + filteredArchivedEntries.length,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject: localMemoryPromptPreview.length > 0 && !promptPreviewBlockedReason,
    localMemoryPromptPreviewBudgetLabel: localMemoryPromptPreview
      ? localMemoryPromptPreviewTruncated
        ? copy.previewTruncated(LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString(copy.intlLocale))
        : copy.previewUsage(localMemoryPromptPreview.length.toLocaleString(copy.intlLocale), LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString(copy.intlLocale))
      : copy.previewLimit(LOCAL_MEMORY_PROMPT_MAX_CHARS.toLocaleString(copy.intlLocale)),
    memoryDraftHasSensitiveFields: redactSecrets(input.draft) !== input.draft,
  };
}
