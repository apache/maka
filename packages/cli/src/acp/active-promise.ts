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

/** Races cooperative work against cancellation while observing the losing task. */
export function whileActive<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<{ active: true; value: T } | { active: false }> {
  return new Promise((resolve, reject) => {
    const cancelled = () => resolve({ active: false });
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', cancelled);
        resolve(signal.aborted ? { active: false } : { active: true, value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) resolve({ active: false });
        else reject(error);
      },
    );
  });
}
