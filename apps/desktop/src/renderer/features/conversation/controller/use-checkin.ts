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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckinCard } from '@maka/core/session-checkin';
import {
  checkinCardKey,
  decodeCheckinMemory,
  recordCheckinAttempt,
  recordCheckinResult,
  settleCheckinCard,
  shouldRunCheckin,
  visibleCheckinCards,
} from '../model/checkin.js';
import { editCheckinCard, runCheckinAction, type CheckinActionOutcome } from '../model/checkin-action.js';
import type { ConversationCheckinMemory } from '../ports.js';
import { useCheckinSetting, useConversationServices } from '../services.js';
import { useConversationQueueCommands } from '../ui/conversation-provider.js';
import { useConversationNavigation } from '../ui/composer-submission-context.js';

/**
 * Runs a check-in when the new-task screen shows and when the window regains
 * focus, at most once per cooldown, and turns a click on a card into its action.
 */
export function useCheckin() {
  const port = useConversationServices().checkin;
  const toggle = useCheckinSetting();
  const navigation = useConversationNavigation();
  const { editing } = useConversationQueueCommands();
  const enabled = Boolean(port && toggle?.enabled);
  const [memory, setMemory] = useState<ConversationCheckinMemory>(() =>
    decodeCheckinMemory(port?.readMemory()),
  );
  const [running, setRunning] = useState(false);
  const [busyKey, setBusyKey] = useState<string>();
  const [notice, setNotice] = useState<{ key: string; outcome: CheckinActionOutcome }>();
  const runningRef = useRef(false);

  const save = useCallback(
    (next: ConversationCheckinMemory) => {
      port?.writeMemory(next);
      setMemory(next);
    },
    [port],
  );

  const run = useCallback(
    async (force = false) => {
      if (!port || runningRef.current) return;
      const current = decodeCheckinMemory(port.readMemory());
      const startedAt = Date.now();
      if (!shouldRunCheckin({ now: startedAt, enabled: port.readEnabled(), running: false, memory: current, force })) {
        setMemory(current);
        return;
      }
      runningRef.current = true;
      setRunning(true);
      const attempted = recordCheckinAttempt(current, startedAt);
      save(attempted);
      try {
        const result = await port.generate({
          effectId: crypto.randomUUID(),
          since: current.lastCheckinAt,
        });
        save(recordCheckinResult(decodeCheckinMemory(port.readMemory()), startedAt, result));
      } catch {
        // A failed check-in is silent and keeps the cards the user already has.
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [port, save],
  );

  // Turning check-in on runs one at once; after that, focus waits out the cooldown.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    const switchedOn = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    if (!enabled) return;
    void run(switchedOn);
    const onFocus = () => void run();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, run]);

  const settle = useCallback(
    (card: CheckinCard) => {
      if (!port) return;
      save(settleCheckinCard(decodeCheckinMemory(port.readMemory()), card));
    },
    [port, save],
  );

  const act = useCallback(
    async (card: CheckinCard) => {
      if (!port) return;
      const key = checkinCardKey(card);
      setBusyKey(key);
      try {
        const outcome = await runCheckinAction(card, {
          port,
          openSession: (sessionId) => navigation?.openSession(sessionId),
        });
        if (outcome !== 'done') setNotice({ key, outcome });
        settle(card);
      } finally {
        setBusyKey(undefined);
      }
    },
    [navigation, port, settle],
  );

  const edit = useCallback(
    (card: CheckinCard, text: string) => {
      editCheckinCard(card, text, {
        openSession: (sessionId) => navigation?.openSession(sessionId),
        seedDraft: editing.seedDraft,
        focus: editing.focus,
        afterNavigation: (run) => globalThis.requestAnimationFrame(run),
      });
      settle(card);
    },
    [editing, navigation, settle],
  );

  return {
    enabled,
    running,
    cards: enabled ? visibleCheckinCards(memory) : [],
    busyKey,
    notice,
    act,
    edit,
    dismiss: settle,
  };
}
