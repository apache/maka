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

import { useRef, useState } from 'react';
import { DIRECTORY_REFERENCE_MAX_COUNT, type DirectoryReference } from '@maka/core/events';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';

export function useComposerDirectories(options: {
  draftKey: string;
  hostId?: string;
  pick(): Promise<{ ok: true; reference: DirectoryReference } | { ok: false; reason: 'cancelled' }>;
  toastApi: { error(title: string, description?: string): void };
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).actions;
  const [byKey, setByKey] = useState<Record<string, readonly DirectoryReference[]>>({});
  const current = useRef(options);
  current.current = options;
  const pendingDirectories = byKey[options.draftKey] ?? [];

  async function pickDirectory(): Promise<void> {
    const owner = current.current;
    if (!owner.hostId) return;
    try {
      const result = await owner.pick();
      if (!result.ok) return;
      if (current.current.draftKey !== owner.draftKey || current.current.hostId !== owner.hostId) {
        return;
      }
      if (result.reference.hostId !== owner.hostId) {
        throw new Error('Directory references require the local Host.');
      }
      setByKey((all) => {
        const previous = all[owner.draftKey] ?? [];
        if (previous.length >= DIRECTORY_REFERENCE_MAX_COUNT) return all;
        if (previous.some((ref) =>
          ref.path === result.reference.path && ref.hostId === result.reference.hostId,
        )) return all;
        return { ...all, [owner.draftKey]: [...previous, result.reference] };
      });
    } catch (error) {
      owner.toastApi.error(
        copy.attachmentFailedTitle,
        localizedShellErrorMessage(error, copy.tryAgain, locale),
      );
    }
  }
  return {
    pendingDirectories,
    pickDirectory: pendingDirectories.length < DIRECTORY_REFERENCE_MAX_COUNT
      ? pickDirectory
      : undefined,
    removeDirectory(index: number) {
      setByKey((all) => ({
        ...all,
        [options.draftKey]: (all[options.draftKey] ?? []).filter((_, i) => i !== index),
      }));
    },
    clearSubmittedDirectories(submitted: readonly DirectoryReference[]) {
      setByKey((all) => ({
        ...all,
        [options.draftKey]: (all[options.draftKey] ?? []).filter((ref) => !submitted.includes(ref)),
      }));
    },
  };
}
