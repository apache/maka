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

import type { ReactElement } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { projectLinkedSessionTree } from '@maka/core/session';
import { useUiLocale } from '@maka/ui';
import type { DesktopSessionSummary } from '../../../shared/desktop-session-projection.js';
import { getExternalSessionImportCopy } from '../../locales/external-session-import-copy.js';

/**
 * The local tasks, as the tree a bundle would carry.
 *
 * A bundle can be rooted at any node -- a subagent Session has its own complete
 * history -- so every row exports, and the nesting says which subtree a row
 * would take with it.
 */
export function ExportTree(props: {
  sessions: readonly DesktopSessionSummary[];
  isBusy: boolean;
  onExport: (session: DesktopSessionSummary, subtree: readonly string[]) => void;
}): ReactElement {
  const copy = getExternalSessionImportCopy(useUiLocale());

  // Filtered first, then projected. Deciding lineage over the whole catalog and
  // hiding rows afterwards loses a Session: an active grandchild under an
  // archived child nests under a parent that never draws it, so nobody renders
  // it at all.
  const visible = props.sessions.filter((session) => !session.isArchived);
  // Two subtrees, on purpose. The visible one decides what is drawn; this one
  // is every linked descendant, archived included, because that is the set the
  // Host fences and exports. Confirming from the drawn one would name a
  // different set than the file holds -- and would be refused as stale forever
  // for any parent with an archived child.
  const wholeTree = projectLinkedSessionTree(props.sessions);
  const wholeSubtree = (sessionId: string): readonly string[] => {
    const ids = [sessionId];
    const pending = [...(wholeTree.childrenByParentId.get(sessionId) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) continue;
      ids.push(next.id);
      pending.push(...(wholeTree.childrenByParentId.get(next.id) ?? []));
    }
    return ids;
  };
  // The read model the rest of the app projects lineage with, rather than a
  // second one maintained here. It resolves both spellings of the link, drops a
  // parent that is not in the list, and refuses a cycle -- which `subagentParent`
  // permits, being an ordinary field with no schema guarantee behind it.
  const tree = projectLinkedSessionTree(visible);
  const childrenOf = (sessionId: string): readonly DesktopSessionSummary[] =>
    (tree.childrenByParentId.get(sessionId) ?? []) as readonly DesktopSessionSummary[];

  const descendantCount = (sessionId: string): number => {
    // A subagent spawns its own, so this walks the subtree rather than counting
    // one level.
    let count = 0;
    const pending = [...childrenOf(sessionId)];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) continue;
      count += 1;
      pending.push(...childrenOf(next.id));
    }
    return count;
  };

  if (tree.roots.length === 0) return <EmptyState title={copy.exportEmpty} />;

  const node = (session: DesktopSessionSummary, depth: number): ReactElement => {
    const carried = descendantCount(session.id);
    const agent = session.subagent?.agentName ?? session.subagentRuntime?.agentName;
    const children = childrenOf(session.id);
    return (
      <li key={session.id} className="maka-export-node">
        <div className="maka-export-row">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <span className="maka-export-name">{session.name ?? session.id}</span>
              {agent ? <Badge variant="neutral" label={agent} /> : null}
            </HStack>
            {carried > 0 && (
              <span className="maka-export-carries">{copy.exportCarriesSubagents(carried)}</span>
            )}
          </VStack>
          <Button
            // A root is what someone came here to export; a child is usually
            // context. The same capability, at a quieter weight.
            variant={depth === 0 ? 'secondary' : 'ghost'}
            size="sm"
            label={copy.exportAction}
            aria-label={copy.exportActionFor(session.name ?? session.id)}
            isDisabled={props.isBusy}
            onClick={() => props.onExport(session, wholeSubtree(session.id))}
          />
        </div>
        {children.length > 0 && (
          // The rule belongs to the container, not to each row: a border on the
          // list that holds the children is exactly as tall as they are, while a
          // mark drawn beside every child draws nothing between them.
          <ul className="maka-export-subtree">
            {children.map((child) => node(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className="maka-export-tree" aria-label={copy.exportTitle}>
      {tree.roots.map((session) => node(session as DesktopSessionSummary, 0))}
    </ul>
  );
}
