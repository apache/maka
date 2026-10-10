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

/** Extend a presentation-local palette without recoloring known Works.
 * Cycle through six 30-degree bands, leaving a 30-degree gap between them.
 * An ID-seeded pseudo-random offset keeps sampling stable during React
 * rendering, while different Works can use different hues in the same band.
 */
export function allocateWorkHubHues(sessionIds: readonly string[], previous: ReadonlyMap<string, number> = new Map()): ReadonlyMap<string, number> {
  const pending = [...new Set(sessionIds)].filter((id) => !previous.has(id)).sort();
  if (pending.length === 0) return previous;
  const next = new Map(previous);
  for (const id of pending) {
    let hash = 2166136261;
    for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    // Mix similar IDs before converting the unsigned hash to [0, 1).
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash = (hash ^ (hash >>> 16)) >>> 0;
    const band = next.size % 6;
    next.set(id, band * 60 + (hash / 0x100000000) * 30);
  }
  return next;
}
