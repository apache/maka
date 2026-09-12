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

import { createContext, useState, type ReactNode } from 'react';

export const WorkHubHighlightContext = createContext<{
  sessionId: string | undefined;
  highlight(sessionId: string | undefined): void;
  navigationWork?: { sessionId: string; nonce: number };
  navigateWork(work: { sessionId: string; name: string }): void;
  selectedWork?: { sessionId: string; name: string };
  toggleWork(work: { sessionId: string; name: string }): void;
  selectWork(work: { sessionId: string; name: string } | undefined): void;
}>({ sessionId: undefined, highlight: () => {}, navigateWork: () => {}, selectWork: () => {}, toggleWork: () => {} });

/** Stable across refreshes and reordering; color supplements the visible work name. */
export function workHubIdentityHue(sessionId: string): number {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const hues = [250, 165, 65, 315, 205, 25];
  return hues[hash % hues.length]!;
}


/** Work identity hover and conversation filtering are local presentation state. */
export function WorkHubHighlightProvider({ children }: { children: ReactNode }) {
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
  return <WorkHubHighlightContext.Provider value={{ sessionId, highlight, navigationWork, navigateWork, selectedWork, selectWork, toggleWork: (work) => selectWork(selectedWork?.sessionId === work.sessionId ? undefined : work) }}>
    {children}
  </WorkHubHighlightContext.Provider>;
}
