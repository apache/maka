/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { UiSubscription } from '../../../../packages/plugin-sdk/src/workbench.js';
import { UiError } from './text';

// Each connection starts with a new baseline. Release an opening stream even if its
// owner left while subscribe was pending.
export function observeDiscovery<T>(
  open: () => Promise<UiSubscription<T>>,
  receive: (value: T, first: boolean) => void | Promise<void>,
  fail: (reason: unknown) => void,
) {
  let alive = true;
  let stream: UiSubscription<T> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  const close = async () => {
    const opened = stream;
    stream = null;
    await opened?.close();
  };
  const connect = async () => {
    try {
      const opened = await open();
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      let first = true;
      while (alive) {
        const value = await opened.next();
        if (!alive) return;
        if (value === null) throw new UiError('Discovery connection interrupted');
        await receive(value, first);
        first = false;
        delay = 500;
      }
    } catch (reason) {
      if (alive) fail(reason);
    } finally {
      try {
        await close();
      } catch (reason) {
        if (alive) fail(reason);
      }
      if (alive) {
        timer = setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, 10000);
      }
    }
  };
  void connect();
  return () => {
    alive = false;
    clearTimeout(timer);
    void close().catch((reason) => console.warn('Could not close Discovery subscription', reason));
  };
}
