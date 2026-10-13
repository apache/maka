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

/** Standard discovery locations in precedence order; also the directory-opening allowlist. */
export const STANDARD_SKILL_LOCATIONS = [
  { ref: 'project:maka', scope: 'project', source: 'maka', segments: ['.maka', 'skills'] },
  { ref: 'project:agents', scope: 'project', source: 'agents', segments: ['.agents', 'skills'] },
  { ref: 'workspace:legacy', scope: 'workspace', source: 'legacy', segments: ['skills'] },
  { ref: 'user:maka', scope: 'user', source: 'maka', segments: ['.maka', 'skills'] },
  { ref: 'user:agents', scope: 'user', source: 'agents', segments: ['.agents', 'skills'] },
] as const;

export type SkillLocationDefinition = (typeof STANDARD_SKILL_LOCATIONS)[number];
export type SkillLocationRef = SkillLocationDefinition['ref'];

export function findSkillLocation(ref: string): SkillLocationDefinition | undefined {
  return STANDARD_SKILL_LOCATIONS.find((location) => location.ref === ref);
}
