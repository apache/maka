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

import { createHash } from 'node:crypto';
import type { WorktreeSnapshot } from '@maka/core/worktree';
import {
  decodeWorktreeQueryResult,
  WORKTREE_PAGE_MAX_BYTES,
  WORKTREE_PAGE_MAX_ITEMS,
  type WorktreeCatalogItem,
  type WorktreeCatalogRevision,
  type WorktreeQueryInput,
  type WorktreeQueryResult,
} from '../protocol/worktree.js';
import { JsonArrayPageBudget } from './json-array-page-budget.js';

/** Page both metadata and logs; no unbounded configuration map rides in the envelope. */
export function createWorktreeCatalogPage(
  snapshot: WorktreeSnapshot,
  input: WorktreeQueryInput,
): WorktreeQueryResult {
  const items: WorktreeCatalogItem[] = Object.entries(snapshot.config.projects).map(
    ([projectId, config]) => ({ kind: 'config', projectId, config }),
  );
  for (const { worktrees, ...project } of snapshot.projects) {
    items.push({ kind: 'project', project });
    for (const worktree of worktrees) items.push({ kind: 'worktree', worktree });
  }
  const rootDirectory = snapshot.config.rootDirectory;
  const revision: WorktreeCatalogRevision = `sha256:${createHash('sha256')
    .update(JSON.stringify([rootDirectory, items]))
    .digest('hex')}`;
  if (input.revision !== undefined && input.revision !== revision)
    return { kind: 'revision_changed' };
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.cursor !== undefined && (offset === 0 || offset >= items.length))
  )
    throw new RangeError('Invalid worktree catalog cursor');
  const page: Extract<WorktreeQueryResult, { kind: 'page' }> = {
    kind: 'page',
    revision,
    rootDirectory,
    items: [],
    nextCursor: null,
  };
  const budget = new JsonArrayPageBudget(WORKTREE_PAGE_MAX_BYTES, page);
  for (
    let index = offset;
    index < items.length && page.items.length < WORKTREE_PAGE_MAX_ITEMS;
    index++
  ) {
    const nextCursor = index + 1 < items.length ? String(index + 1) : null;
    if (!budget.tryAppend(items[index], nextCursor)) break;
    page.items.push(items[index]!);
  }
  if (page.items.length === 0 && offset < items.length)
    throw new Error('Worktree catalog item exceeds the page limit');
  const nextOffset = offset + page.items.length;
  page.nextCursor = nextOffset < items.length ? String(nextOffset) : null;
  return decodeWorktreeQueryResult(page);
}
