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
import type { DeepResearchClientProgress } from '@maka/core/deep-research-run';

export function useDeepResearchRun(
  sessionId: string | undefined,
  enabled: boolean,
): DeepResearchClientProgress | undefined {
  const [run, setRun] = useState<DeepResearchClientProgress>();

  useEffect(() => {
    let active = true;
    let request = 0;
    if (!sessionId || !enabled) {
      setRun(undefined);
      return () => {
        active = false;
      };
    }

    const refresh = async () => {
      const currentRequest = ++request;
      const next = await window.maka.deepResearch.get(sessionId);
      if (active && currentRequest === request) setRun(next);
    };
    void refresh().catch(() => {
      if (active) setRun(undefined);
    });
    const unsubscribe = window.maka.deepResearch.subscribeChanges((event) => {
      if (event.sessionId === sessionId) {
        void refresh().catch(() => undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, sessionId]);

  return enabled && run?.sessionId === sessionId ? run : undefined;
}
