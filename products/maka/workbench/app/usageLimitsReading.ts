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

import type { Output } from './host';

export type UsageResult = Output<'settings', 'connectionUsageLimits'>;
export type UsageReading = { result: UsageResult; refreshFailed: boolean };

const REFRESH_INTERVAL = 60_000;

export function watchUsageLimits(
  query: () => Promise<UsageResult>,
  publish: (reading: UsageReading) => void,
  previous: UsageReading | null,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = previous?.result;
  const read = async () => {
    let result: UsageResult;
    try {
      result = await query();
    } catch {
      result = { kind: 'unavailable' };
    }
    if (stopped) return;
    if (result.kind === 'unavailable' && last?.kind === 'ready') {
      publish({ result: last, refreshFailed: true });
    } else {
      last = result;
      publish({ result, refreshFailed: false });
    }
    if (!stopped && result.kind !== 'unsupported') {
      timer = setTimeout(read, REFRESH_INTERVAL);
    }
  };
  void read();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
