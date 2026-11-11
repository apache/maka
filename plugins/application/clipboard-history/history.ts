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

/** How many entries the history may keep, the second the default. */
export const LIMITS = [20, 50, 100, 200] as const;
export type Limit = (typeof LIMITS)[number];
export const DEFAULT_LIMIT: Limit = 50;

/** Newest first, at most `limit`; copying an old entry again moves it back to the top. */
export function remember(
  history: readonly string[],
  text: string,
  limit: Limit,
): readonly string[] {
  return [text, ...history.filter((entry) => entry !== text)].slice(0, limit);
}
