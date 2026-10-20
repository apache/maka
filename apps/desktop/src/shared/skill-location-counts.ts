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

import type { SkillEntry, SkillLocation } from '@maka/ui';

/** Counts every discovered copy, including disabled, shadowed and rejected Skills. */
export function withSkillLocationCounts(
  locations: readonly Omit<SkillLocation, 'skillCount'>[],
  skills: readonly Pick<SkillEntry, 'kind' | 'scope' | 'source'>[],
): SkillLocation[] {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    if (skill.kind === 'discovery_diagnostic') continue;
    const ref = `${skill.scope}:${skill.source}`;
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return locations.map((location) => ({
    ...location,
    skillCount: counts.get(location.ref) ?? 0,
  }));
}
