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

import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { DIRECTORY_REFERENCE_MAX_COUNT, type DirectoryReference } from '@maka/core/events';
import { useUiLocale } from '@maka/ui';
import { createObservableState } from './observable-state.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';

const EMPTY_DIRECTORY_REFERENCES: readonly DirectoryReference[] = [];

export interface ComposerDirectoriesController {
  subscribe(listener: () => void): () => void;
  get(draftKey: string): readonly DirectoryReference[];
  add(draftKey: string, reference: DirectoryReference): void;
  remove(draftKey: string, index: number): void;
  clearSubmitted(draftKey: string, submitted: readonly DirectoryReference[]): void;
}

export function createComposerDirectoriesController(): ComposerDirectoriesController {
  const state = createObservableState<Record<string, readonly DirectoryReference[]>>({});
  return {
    subscribe: state.subscribe,
    get(draftKey) {
      return state.getState()[draftKey] ?? EMPTY_DIRECTORY_REFERENCES;
    },
    add(draftKey, reference) {
      const all = state.getState();
      const previous = all[draftKey] ?? EMPTY_DIRECTORY_REFERENCES;
      if (previous.length >= DIRECTORY_REFERENCE_MAX_COUNT) return;
      if (previous.some((entry) =>
        entry.path === reference.path && entry.hostId === reference.hostId,
      )) return;
      state.replaceState({ ...all, [draftKey]: [...previous, reference] });
    },
    remove(draftKey, index) {
      const all = state.getState();
      const previous = all[draftKey] ?? EMPTY_DIRECTORY_REFERENCES;
      if (index < 0 || index >= previous.length) return;
      state.replaceState({
        ...all,
        [draftKey]: previous.filter((_, entryIndex) => entryIndex !== index),
      });
    },
    clearSubmitted(draftKey, submitted) {
      const all = state.getState();
      const previous = all[draftKey] ?? EMPTY_DIRECTORY_REFERENCES;
      const next = previous.filter((reference) => !submitted.includes(reference));
      if (next.length === previous.length) return;
      state.replaceState({ ...all, [draftKey]: next });
    },
  };
}

/** Owns directory draft state outside AppShell's render scope (#4109). */
export function ComposerDirectoriesProvider({
  children,
}: {
  children(controller: ComposerDirectoriesController): ReactNode;
}) {
  const controllerRef = useRef<ComposerDirectoriesController | null>(null);
  controllerRef.current ??= createComposerDirectoriesController();
  return children(controllerRef.current);
}

export function useComposerDirectories(options: {
  controller: ComposerDirectoriesController;
  draftKey: string;
  hostId?: string;
  pick(): Promise<{ ok: true; reference: DirectoryReference } | { ok: false; reason: 'cancelled' }>;
  toastApi: { error(title: string, description?: string): void };
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).actions;
  const current = useRef(options);
  current.current = options;
  const pendingDirectories = useSyncExternalStore(
    options.controller.subscribe,
    () => options.controller.get(options.draftKey),
    () => options.controller.get(options.draftKey),
  );

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
      owner.controller.add(owner.draftKey, result.reference);
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
      options.controller.remove(options.draftKey, index);
    },
    clearSubmittedDirectories(submitted: readonly DirectoryReference[]) {
      options.controller.clearSubmitted(options.draftKey, submitted);
    },
  };
}
