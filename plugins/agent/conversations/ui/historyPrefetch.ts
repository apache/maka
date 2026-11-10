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

import { signal } from 'nsh';

export const HISTORY_LOOKAHEAD_VIEWPORTS = 2;
const MAX_PREFETCH_PAGES = 3;

export function createHistoryPrefetch(options: {
  owner(): object | null;
  nearStart(): boolean;
  loadOlder(): Promise<boolean>;
}) {
  const reading = signal<object | null>(null);
  return {
    loading: () => reading() !== null && reading() === options.owner(),
    async start() {
      const owner = options.owner();
      if (owner === null || reading() === owner) return;
      reading.set(owner);
      try {
        for (let page = 0; page < MAX_PREFETCH_PAGES; page++) {
          if (!(await options.loadOlder()) || options.owner() !== owner) break;
          // A folded page can advance the cursor without a new list edge event.
          // NSH delivers the offset correction in the turn after frame callbacks.
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          if (options.owner() !== owner || !options.nearStart()) break;
        }
      } finally {
        if (reading() === owner) reading.set(null);
      }
    },
  };
}
