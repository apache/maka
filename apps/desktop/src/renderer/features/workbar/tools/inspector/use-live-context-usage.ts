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
import { useWorkbarServices } from '../../services-context.js';
import {
  createLiveContextUsageTracker,
  type LiveContextUsage,
} from './live-context-usage.js';
import { TRACE_REFRESH_DEBOUNCE_MS } from './session-trace-refresh.js';

/**
 * The composer gauge's live reading (#4717).
 *
 * The gauge used to wait for the turn-end `token_usage` record, so a long
 * agentic turn — exactly when context grows fastest — showed the previous
 * turn's number throughout. The Host seals a latest-context snapshot at every
 * settled provider request, and this hook keeps the gauge on that snapshot:
 * an immediate read when the target changes, then a debounced re-read on each
 * trace-relevant live event, the same signal the inspector's context bar
 * follows. When the snapshot cannot vouch for the composer's active route the
 * hook says nothing, and the caller falls back to the per-turn anchor.
 */
export function useLiveContextUsage(input: {
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly providerType: string | undefined;
}): LiveContextUsage | undefined {
  const { inspector } = useWorkbarServices();
  const [usage, setUsage] = useState<LiveContextUsage | undefined>(undefined);
  const { sessionId, model, providerType } = input;
  useEffect(() => {
    const tracker = createLiveContextUsageTracker({
      query: async (targetSessionId) => {
        const result = await inspector.context(targetSessionId);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      delayMs: TRACE_REFRESH_DEBOUNCE_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onChange: setUsage,
    });
    tracker.setTarget(
      sessionId === undefined
        ? undefined
        : { sessionId, route: { model, providerType } },
    );
    const unsubscribe =
      sessionId === undefined
        ? undefined
        : inspector.subscribeSessionEvents(sessionId, (event) => tracker.observe(event));
    return () => {
      unsubscribe?.();
      tracker.dispose();
    };
  }, [inspector, sessionId, model, providerType]);
  return usage;
}
