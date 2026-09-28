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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { ExportTree } from '../../renderer/features/session-bundle/testing.js';

// Named, not spread: `globalThis` carries getter-only properties, and copying
// the whole object back throws on the first one.
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

describe('session bundle export tree', () => {
  it('nests a subagent subtree and counts the whole thing', async () => {
    const rendered = await render([
      task('root', 'Refactor compaction'),
      subagentTask('child-a', 'Find the call sites', 'root', 'Explore'),
      subagentTask('grandchild', 'What the child spawned', 'child-a', 'Explore'),
      subagentTask('child-b', 'Check the checkpoint path', 'root', 'general-purpose'),
      task('unrelated', 'Say hello'),
    ]);

    // Three descendants, not the two children: a subagent spawns its own, and a
    // bundle rooted here carries all of them.
    assert.match(rendered.container.textContent, /Carries 3 subagent conversations/);
    // The child that has one of its own says so too.
    assert.match(rendered.container.textContent, /Carries 1 subagent conversation/);
    // Nesting is structural, not an indent class: a child lives inside the list
    // that belongs to its parent, which is what draws one continuous rule.
    assert.equal(
      rendered.container.querySelectorAll('.maka-export-subtree').length,
      2,
      'one per parent that has children',
    );
    assert.equal(
      rendered.container.querySelectorAll('.maka-export-tree > .maka-export-node').length,
      2,
      'two roots: the parent task and the unrelated one',
    );
    await rendered.dispose();
  });

  it('reads the link the catalog actually publishes', async () => {
    // The catalog projection calls it `subagent`; `subagentParent` is on the
    // full header and absent from a list. Reading only the second one made
    // every row a root -- a flat list claiming every task stands alone.
    const rendered = await render([
      task('root', 'Refactor compaction'),
      { ...task('child', 'A child'), subagent: { parentSessionId: 'root', agentName: 'Explore' } },
    ]);
    assert.equal(rendered.container.querySelectorAll('.maka-export-subtree').length, 1);
    assert.match(rendered.container.textContent, /Carries 1 subagent conversation/);
    await rendered.dispose();
  });

  it('shows a task whose parent is not in the list', async () => {
    // Its parent was archived, or paging never reached it. It is not a root and
    // nothing here can nest it, so without this it is simply gone.
    const rendered = await render([
      subagentTask('orphan', 'Parent is elsewhere', 'absent-parent', 'Explore'),
    ]);
    assert.match(rendered.container.textContent, /Parent is elsewhere/);
    await rendered.dispose();
  });

  it('a Session that names itself as its parent still renders', async () => {
    // `subagentParent` is an ordinary field with no schema guarantee behind it,
    // and a cycle here is an infinite render rather than a wrong number.
    const rendered = await render([subagentTask('loop', 'Points at itself', 'loop', 'Explore')]);
    assert.match(rendered.container.textContent, /Points at itself/);
    await rendered.dispose();
  });

  it('leaves archived tasks out', async () => {
    const rendered = await render([{ ...task('archived', 'Put away'), isArchived: true }]);
    assert.doesNotMatch(rendered.container.textContent, /Put away/);
    await rendered.dispose();
  });

  it('offers every row, because a bundle can be rooted at any node', async () => {
    const rendered = await render([
      task('root', 'Refactor compaction'),
      subagentTask('child', 'Find the call sites', 'root', 'Explore'),
    ]);
    const exports = Array.from(
      rendered.container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((button) => button.textContent === 'Export');
    assert.equal(exports.length, 2, 'the child exports on its own too');
    await rendered.dispose();
  });
  it('shows an active grandchild whose parent is archived', async () => {
    // Lineage decided over the whole catalog and rows hidden afterwards loses
    // this one: it nests under a parent that is never drawn, so nobody renders
    // it. Filtering first is what makes it a root of its own.
    const rendered = await render([
      task('root', 'Refactor compaction'),
      { ...subagentTask('gone', 'Archived middle', 'root', 'Explore'), isArchived: true },
      subagentTask('grandchild', 'Still running', 'gone', 'Explore'),
    ]);
    assert.match(rendered.container.textContent, /Still running/);
    assert.doesNotMatch(rendered.container.textContent, /Archived middle/);
    await rendered.dispose();
  });
});

async function render(sessions: readonly DesktopSessionSummary[]): Promise<{
  container: HTMLElement;
  dispose(): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ExportTree, { sessions, isBusy: false, onExport: () => {} }),
        }),
      }),
    );
  });
  return { container, dispose: async () => void (await act(async () => root.unmount())) };
}

function task(id: string, name: string): DesktopSessionSummary {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    cwd: '/workspace',
    isArchived: false,
    status: 'idle',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    revision: 1,
  } as unknown as DesktopSessionSummary;
}

function subagentTask(
  id: string,
  name: string,
  parentSessionId: string,
  agentName: string,
): DesktopSessionSummary {
  return {
    ...task(id, name),
    // The full shape the guard requires: a partial one is not a link, and a
    // fixture that omits `spawnedBy` silently renders five unrelated roots.
    subagentParent: {
      kind: 'subagent',
      parentSessionId,
      lifecycle: 'foreground',
      spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
    },
    subagentRuntime: { agentName },
  } as unknown as DesktopSessionSummary;
}
