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

const CHANGE_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export interface WorktreeName {
  type: (typeof CHANGE_TYPES)[number];
  slug: string;
}

/** Decode one conventional branch name into its type and standalone directory slug. */
export function parseWorktreeName(text: string): WorktreeName | undefined {
  const branch = text.trim();
  const type = CHANGE_TYPES.find((candidate) => branch.startsWith(`${candidate}/`));
  if (!type) return undefined;
  const slug = branch.slice(type.length + 1);
  if (slug.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return undefined;
  // The slug also becomes a directory on Windows, where these names are reserved.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(slug)) return undefined;
  return { type, slug };
}
