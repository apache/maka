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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NavSelection } from '@maka/ui';

interface LocalDraftTarget {
  readonly profileId: string;
  readonly hostId: string;
  readonly projectId: string | null;
}

export interface HistoryDraftHostInput {
  readonly activeSessionId?: string;
  readonly activeSessionIsLocal: boolean;
  readonly switchingSession: boolean;
  readonly obscured: boolean;
  readonly target?: LocalDraftTarget;
  readonly targetIsLocal: boolean;
  readonly draftKey: string;
  readonly selectLocalTarget: () => LocalDraftTarget | undefined;
  readonly composer: { current: { appendText(text: string): void; focus(): void } | null };
  readonly captureSelection: () => () => boolean;
  readonly selectChat: (selection: NavSelection) => void;
  readonly startNewSession: () => void;
  readonly reportError: (error: unknown) => void;
}

interface PendingDraft {
  readonly text: string;
  readonly selection: NavSelection;
  readonly sourceSelection: NavSelection;
  readonly selectionIsCurrent: () => boolean;
  readonly sessionId?: string;
  readonly profileId?: string;
  readonly hostId?: string;
  readonly projectId?: string | null;
  readonly draftKey?: string;
  readonly sourceDraftKey: string;
  readonly composer: NonNullable<HistoryDraftHostInput['composer']['current']>;
}

/** Append through Shell intents only after the selected local Composer commits. */
export function useComputerHistoryDraft(
  input: HistoryDraftHostInput & { readonly selection: NavSelection },
): (text: string) => void {
  const live = useRef(input);
  useLayoutEffect(() => { live.current = input; });
  const mounted = useRef(false);
  const busy = useRef(false);
  const [pending, setPending] = useState<PendingDraft>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (input.selection === pending.sourceSelection && pending.selectionIsCurrent()) return;
    if (
      input.selection !== pending.selection ||
      !pending.selectionIsCurrent() ||
      input.composer.current !== pending.composer ||
      input.obscured
    ) {
      busy.current = false;
      setPending(undefined);
      return;
    }
    const target = input.target;
    const destinationIsCurrent = pending.sessionId
      ? input.activeSessionId === pending.sessionId && input.activeSessionIsLocal
      : !input.activeSessionId &&
        input.targetIsLocal &&
        (pending.draftKey
          ? input.draftKey === pending.draftKey
          : target?.profileId === pending.profileId &&
            target?.hostId === pending.hostId && target?.projectId === pending.projectId);
    if (!destinationIsCurrent) {
      if (input.draftKey !== pending.sourceDraftKey) {
        busy.current = false;
        setPending(undefined);
      }
      return;
    }
    if (input.switchingSession) return;
    const composer = input.composer.current;
    if (!composer) return;
    busy.current = false;
    setPending(undefined);
    composer.appendText(pending.text);
    composer.focus();
  }, [input, pending]);

  return useCallback((text: string) => {
    const source = live.current;
    if (
      !text.trim() || busy.current || !mounted.current ||
      source.selection.section !== 'computer-history' ||
      source.switchingSession || source.obscured || !source.composer.current
    ) return;
    busy.current = true;
    try {
      let destination: Pick<PendingDraft, 'sessionId' | 'profileId' | 'hostId' | 'projectId' | 'draftKey'>;
      if (source.activeSessionId && source.activeSessionIsLocal) {
        destination = { sessionId: source.activeSessionId };
      } else if (source.targetIsLocal) {
        destination = { draftKey: source.draftKey };
      } else {
        const target = source.selectLocalTarget();
        if (!target) throw new Error('A local task workspace is unavailable');
        destination = target;
      }
      if (!destination.sessionId && source.activeSessionId) live.current.startNewSession();
      const selection: NavSelection = { section: 'sessions' };
      setPending({
        ...destination,
        text,
        selection,
        sourceSelection: source.selection,
        sourceDraftKey: source.draftKey,
        composer: source.composer.current,
        selectionIsCurrent: live.current.captureSelection(),
      });
      live.current.selectChat(selection);
    } catch (error) {
      busy.current = false;
      source.reportError(error);
    }
  }, []);
}
