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

import { cleanup, effect } from 'nsh';

// Only observes original operations. Business methods stay with their caller.
export function createPendingRecovery(options: {
  pending(): boolean;
  blocked?(): boolean;
  recover(): Promise<unknown> | void;
}) {
  let alive = true;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    if (!alive || running || timer !== undefined || !options.pending()) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (!alive || !options.pending()) return;
      if (!options.blocked?.()) {
        running = true;
        try {
          await options.recover();
        } catch (reason) {
          console.warn('Maka operation recovery failed:', reason);
        } finally {
          running = false;
        }
      }
      // Match the existing observation reconnect cadence while disconnected.
      schedule(2000);
    }, delay);
  };
  effect(() => {
    const pending = options.pending();
    const blocked = options.blocked?.() ?? false;
    if (!pending) stop();
    else if (!blocked) schedule(0);
  });
  cleanup(() => {
    alive = false;
    stop();
  });
}
