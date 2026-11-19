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

import type { WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import type { TreeItem } from 'nsh/base';
import { basenameLabel, parentPathOf } from './reviewState';

// Search results and diffs already contain paths. Their parents need no filesystem reads.
export function pathTree<T>(
  rows: readonly T[],
  path: (row: T) => WorkspacePath,
  label: (path: WorkspacePath) => string,
) {
  const roots: TreeItem[] = [];
  const folders = new Map<string, TreeItem>();
  function children(parent: WorkspacePath | null): TreeItem[] {
    if (!parent) return roots;
    const key = parent.bytesBase64;
    let folder = folders.get(key);
    if (!folder) {
      folder = { id: 'dir:' + key, label: basenameLabel(label(parent)), children: [] };
      folders.set(key, folder);
      children(parentPathOf(parent)).push(folder);
    }
    return folder.children!;
  }
  for (const row of rows) {
    const file = path(row);
    children(parentPathOf(file)).push({ id: file.bytesBase64, label: basenameLabel(label(file)) });
  }
  const folderIds: string[] = [];
  function compact(nodes: TreeItem[]): TreeItem[] {
    return nodes
      .sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.label.localeCompare(b.label))
      .map((node) => {
        if (!node.children) return node;
        let end = node;
        let label = node.label;
        while (end.children?.length === 1 && end.children[0]!.children) {
          end = end.children[0]!;
          label += '/' + end.label;
        }
        folderIds.push(end.id);
        return { id: end.id, label, children: compact(end.children!) };
      });
  }
  return { items: compact(roots), folders: folderIds };
}
