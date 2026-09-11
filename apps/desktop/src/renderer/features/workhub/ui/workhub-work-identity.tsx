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
}>({ sessionId: undefined, highlight: () => {} });

/** Stable across refreshes and reordering; color supplements the visible work name. */
export function workHubIdentityHue(sessionId: string): number {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const hues = [250, 165, 65, 315, 205, 25];
  return hues[hash % hues.length]!;
}


/** Work identity hover is local presentation state shared by the three rails. */
export function WorkHubHighlightProvider({ children }: { children: ReactNode }) {
  const [sessionId, highlight] = useState<string>();
  return <WorkHubHighlightContext.Provider value={{ sessionId, highlight }}>
    {children}
  </WorkHubHighlightContext.Provider>;
}
