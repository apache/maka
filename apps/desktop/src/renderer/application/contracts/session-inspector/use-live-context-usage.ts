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

import { useEffect, useState } from 'react';
import type { SessionInspectorService } from './service.js';
import {
  createLiveContextUsageTracker,
  type LiveContextUsage,
} from './live-context-usage.js';
import { TRACE_REFRESH_DEBOUNCE_MS } from './session-trace-refresh.js';

interface TargetedLiveContextUsage {
  readonly sessionId: string;
  readonly model: string | undefined;
  readonly providerType: string | undefined;
  readonly state: LiveContextUsageState;
}

export type LiveContextUsageState =
  | { readonly status: 'pending' }
  | { readonly status: 'available'; readonly usage: LiveContextUsage }
  | { readonly status: 'unavailable' };

/**
 * The composer gauge's live reading (#4717).
 *
 * The gauge used to wait for the turn-end `token_usage` record, so a long
 * agentic turn — exactly when context grows fastest — showed the previous
 * turn's number throughout. The Host seals a latest-context snapshot at every
 * settled provider request, and this hook keeps the gauge on that snapshot:
 * an immediate read when the target changes, then a debounced re-read on each
 * trace-relevant live event, the same signal the inspector's context bar
 * follows. The stateful form distinguishes a new target's first read from a
 * settled refusal, so the composer does not present "no usage" while the Host
 * is still answering. The value-only wrapper remains for consumers that only
 * need the available reading.
 */
export function useLiveContextUsageState(input: {
  readonly inspector: SessionInspectorService;
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly providerType: string | undefined;
}): LiveContextUsageState {
  const { inspector } = input;
  const [snapshot, setSnapshot] = useState<TargetedLiveContextUsage | undefined>(undefined);
  const { sessionId, model, providerType } = input;
  useEffect(() => {
    let settingTarget = true;
    const targetSnapshot = (state: LiveContextUsageState): TargetedLiveContextUsage => ({
      sessionId: sessionId!,
      model,
      providerType,
      state,
    });
    const tracker = createLiveContextUsageTracker({
      query: async (targetSessionId) => {
        const result = await inspector.context(targetSessionId);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      delayMs: TRACE_REFRESH_DEBOUNCE_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onChange: (usage) => {
        setSnapshot(
          sessionId === undefined
            ? undefined
            : targetSnapshot(
                settingTarget
                  ? { status: 'pending' }
                  : usage
                    ? { status: 'available', usage }
                    : { status: 'unavailable' },
              ),
        );
      },
      onReadFailure: () => {
        if (sessionId === undefined) return;
        setSnapshot((current) => {
          if (
            current?.sessionId === sessionId
            && current.model === model
            && current.providerType === providerType
            && current.state.status === 'available'
          ) {
            return current;
          }
          return targetSnapshot({ status: 'unavailable' });
        });
      },
    });
    tracker.setTarget(
      sessionId === undefined
        ? undefined
        : { sessionId, route: { model, providerType } },
    );
    settingTarget = false;
    const unsubscribe =
      sessionId === undefined
        ? undefined
        : inspector.subscribeSessionEvents(sessionId, (event) => tracker.observe(event));
    return () => {
      unsubscribe?.();
      tracker.dispose();
    };
  }, [inspector, sessionId, model, providerType]);
  if (sessionId === undefined) return { status: 'unavailable' };
  if (
    snapshot?.sessionId !== sessionId
    || snapshot.model !== model
    || snapshot.providerType !== providerType
  ) {
    return { status: 'pending' };
  }
  return snapshot.state;
}

export function useLiveContextUsage(input: {
  readonly inspector: SessionInspectorService;
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly providerType: string | undefined;
}): LiveContextUsage | undefined {
  const state = useLiveContextUsageState(input);
  return state.status === 'available' ? state.usage : undefined;
}
