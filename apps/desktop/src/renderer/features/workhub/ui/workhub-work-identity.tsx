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

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { allocateWorkHubHues } from '../model/identity-colors.js';

export const WorkHubHighlightContext = createContext<{
  sessionId: string | undefined;
  highlight(sessionId: string | undefined): void;
  navigationWork?: { sessionId: string; nonce: number };
  navigateWork(work: { sessionId: string; name: string }): void;
  selectedWork?: { sessionId: string; name: string };
  toggleWork(work: { sessionId: string; name: string }): void;
  selectWork(work: { sessionId: string; name: string } | undefined): void;
}>({ sessionId: undefined, highlight: () => {}, navigateWork: () => {}, selectWork: () => {}, toggleWork: () => {} });

/** Work identity hover and conversation filtering are local presentation state. */
export function useWorkHubHighlightState() {
  const [sessionId, highlight] = useState<string>();
  const [navigationWork, setNavigationWork] = useState<{ sessionId: string; nonce: number }>();
  const [selectedWork, setSelectedWork] = useState<{ sessionId: string; name: string }>();
  const selectWork = (work: { sessionId: string; name: string } | undefined) => {
    setNavigationWork(undefined);
    setSelectedWork(work);
  };
  const navigateWork = (work: { sessionId: string; name: string }) => {
    if (selectedWork?.sessionId === work.sessionId) selectWork(undefined);
    else if (navigationWork?.sessionId === work.sessionId) selectWork(work);
    else {
      setSelectedWork(undefined);
      setNavigationWork({ sessionId: work.sessionId, nonce: Date.now() });
    }
  };
  return { sessionId, highlight, navigationWork, navigateWork, selectedWork, selectWork, toggleWork: (work: { sessionId: string; name: string }) => selectWork(selectedWork?.sessionId === work.sessionId ? undefined : work) };
}

const WorkHubHueContext = createContext<ReadonlyMap<string, number> | undefined>(undefined);

export function WorkHubHueProvider({ sessionIds, children }: { sessionIds: readonly string[]; children: ReactNode }) {
  const [allocated, setAllocated] = useState<ReadonlyMap<string, number>>(() => allocateWorkHubHues(sessionIds));
  const next = allocateWorkHubHues(sessionIds, allocated);
  if (next !== allocated) setAllocated(next);
  return <WorkHubHueContext.Provider value={next}>{children}</WorkHubHueContext.Provider>;
}

export function useWorkHubIdentityHue(sessionIds: readonly string[]) {
  const hues = useContext(WorkHubHueContext);
  const palette = useMemo(() => hues ?? allocateWorkHubHues(sessionIds), [hues, sessionIds]);
  return useMemo(() => (id: string) => palette.get(id) ?? 250, [palette]);
}
