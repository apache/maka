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
 * Serialize a write operation under `key` against a per-key promise
 * chain held in `queueMap`. Once the chain for a key drains with no
 * newer write queued behind it, the entry self-evicts so the Map
 * does not accumulate one settled Promise per key forever.
 *
 * The returned promise rejects on operation failure so callers can
 * observe errors; the Map-held chain swallows rejections only to keep
 * the chain alive for subsequent writes.
 */
export function chainWrite(
  queueMap: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = queueMap.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const stored = next.catch(() => {
    // Keep the chain alive after failures.
  });
  const tracked = stored.finally(() => {
    if (queueMap.get(key) === tracked) queueMap.delete(key);
  });
  queueMap.set(key, tracked);
  return next;
}
