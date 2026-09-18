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
import { test, type TestContext } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import { LocaleProvider } from '@maka/ui';
import {
  ComposerMentionsProvider,
  useComposerMentionsContext,
  type ComposerMentions,
} from '../../renderer/composer-mentions.js';
import {
  ConversationServicesProvider,
  type ConversationServices,
} from '../../renderer/features/conversation/index.js';

interface CatalogObservation {
  sessionId: string;
  skills: ComposerMentions['mentionSkills'];
  loading: boolean;
  unavailable: boolean;
}

const skillA: InvocableSkillEntry = {
  ref: 'workspace:skill-a',
  id: 'skill-a',
  name: 'Skill A',
  description: 'Available in session A.',
};
const skillB: InvocableSkillEntry = {
  ref: 'workspace:skill-b',
  id: 'skill-b',
  name: 'Skill B',
  description: 'Available in session B.',
};

function installCatalogRenderer(t: TestContext) {
  const originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const pending: Array<{
    sessionId: string;
    resolve(skills: InvocableSkillEntry[]): void;
  }> = [];
  const services: ConversationServices = {
    listMessages: async () => [],
    cancelMessage: async () => undefined,
    reconcileMessage: async () => undefined,
    subscribeChanges: () => () => undefined,
    skills: {
      listInvocable: (sessionId: string) => new Promise<InvocableSkillEntry[]>((resolve) => {
        pending.push({ sessionId, resolve });
      }),
    },
    sessions: {
      list: () => new Promise(() => undefined),
      readSnapshot: async () => {
        throw new Error('Session snapshot is not used in catalog tests');
      },
      subscribeChanges: () => () => undefined,
    },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }),
    },
    mcp: { subscribeChanges: () => () => undefined },
  };

  const observations: CatalogObservation[] = [];
  function Consumer({ sessionId }: { sessionId: string }) {
    const mentions = useComposerMentionsContext();
    assert.ok(mentions);
    useLayoutEffect(() => {
      // Record what a consumer sees before the provider's passive effect can
      // replace the previous context's catalog and hide a missing render guard.
      observations.push({
        sessionId,
        skills: mentions.mentionSkills,
        loading: mentions.mentionSkillsLoading,
        unavailable: mentions.mentionSkillsUnavailable,
      });
    });
    return null;
  }

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      Object.assign(globalThis, originalGlobals);
    }
  });

  return {
    observations,
    latest() {
      const observation = observations.at(-1);
      assert.ok(observation);
      return observation;
    },
    pendingRequestCount() {
      return pending.length;
    },
    async render(sessionId: string, skillCatalogRevision = 0, projectPath?: string) {
      await act(() => root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ConversationServicesProvider, {
          services,
          children: createElement(ComposerMentionsProvider, {
            sessionId,
            projectPath,
            skillCatalogRevision,
            children: createElement(Consumer, { sessionId }),
          }),
        }),
      })));
    },
    async settleNext(sessionId: string, skills: InvocableSkillEntry[]) {
      const request = pending.shift();
      assert.ok(request, 'A catalog request must be waiting for its response.');
      assert.equal(request.sessionId, sessionId);
      await act(async () => request.resolve(skills));
    },
  };
}

for (const previous of [
  { name: 'populated', skills: [skillA] },
  { name: 'empty', skills: [] },
]) {
  test(`a session switch immediately replaces the ${previous.name} catalog with loading`, async (t) => {
    const renderer = installCatalogRenderer(t);
    await renderer.render('session-a');
    await renderer.settleNext('session-a', previous.skills);
    assert.deepEqual(renderer.latest(), {
      sessionId: 'session-a',
      skills: previous.skills,
      loading: false,
      unavailable: previous.skills.length === 0,
    });

    const beforeSwitch = renderer.observations.length;
    await renderer.render('session-b');
    const firstInSessionB = renderer.observations
      .slice(beforeSwitch)
      .find((observation) => observation.sessionId === 'session-b');
    const loadingCatalog = {
      sessionId: 'session-b',
      skills: [],
      loading: true,
      unavailable: false,
    };
    assert.deepEqual(firstInSessionB, loadingCatalog);
    assert.deepEqual(renderer.latest(), loadingCatalog);

    await renderer.settleNext('session-b', [skillB]);
    assert.deepEqual(renderer.latest(), {
      sessionId: 'session-b',
      skills: [skillB],
      loading: false,
      unavailable: false,
    });
  });
}

test('a same-context refresh keeps the settled skills visible until it resolves', async (t) => {
  const renderer = installCatalogRenderer(t);
  await renderer.render('session-a');
  await renderer.settleNext('session-a', [skillA]);

  // A catalog revision reloads the same backend surface without changing its key.
  await renderer.render('session-a', 1);
  assert.deepEqual(renderer.latest(), {
    sessionId: 'session-a',
    skills: [skillA],
    loading: true,
    unavailable: false,
  });

  await renderer.settleNext('session-a', [skillB]);
  assert.deepEqual(renderer.latest(), {
    sessionId: 'session-a',
    skills: [skillB],
    loading: false,
    unavailable: false,
  });
});

test('resolving the project path for an existing session keeps its catalog settled', async (t) => {
  const renderer = installCatalogRenderer(t);
  await renderer.render('session-a');
  await renderer.settleNext('session-a', [skillA]);

  await renderer.render('session-a', 0, '/workspace/project-a');

  assert.deepEqual(renderer.latest(), {
    sessionId: 'session-a',
    skills: [skillA],
    loading: false,
    unavailable: false,
  });
  assert.equal(renderer.pendingRequestCount(), 0);
});
