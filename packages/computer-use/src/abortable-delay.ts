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

/**
 * Sleep that honours an abort signal.
 *
 * The model-facing `wait` action used a bare setTimeout, so a user stop during
 * a long wait was ignored until the timer fired on its own.
 *
 * This used to note that only the maka-cu backend waited this way, and that
 * `cua-driver-backend.ts` still used a bare `setTimeout` for its own `wait`.
 * That backend is gone, so there is no longer a wait in this package that a
 * stop cannot interrupt. The note is kept in this shape rather than deleted
 * because the claim it replaced — that both backends waited the same way —
 * was false, and false claims of that kind are what stop the next person from
 * checking.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
