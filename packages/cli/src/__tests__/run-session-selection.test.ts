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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { selectMakaRunSession } from '../run-session-selection.js';

describe('maka run session selection', () => {
  test('new runs canonicalize the explicit cwd or process cwd', async () => {
    const deps = canonicalizer({ '/link': '/repo', '/process': '/process-real' });

    assert.deepEqual(
      await selectMakaRunSession(
        {
          sessions: [],
          continueLatest: false,
          explicitCwd: '/link',
          processCwd: '/process',
          thinkingSpecified: false,
        },
        deps,
      ),
      { kind: 'new', cwd: '/repo' },
    );
    assert.deepEqual(
      await selectMakaRunSession(
        {
          sessions: [],
          continueLatest: false,
          processCwd: '/process',
          thinkingSpecified: false,
        },
        deps,
      ),
      { kind: 'new', cwd: '/process-real' },
    );
  });

  test('resume uses the stored canonical cwd and ignores implicit process cwd', async () => {
    const stored = session({ id: 'resume-me', cwd: '/stored-link' });
    const selected = await selectMakaRunSession(
      {
        sessions: [stored],
        resumeId: stored.id,
        continueLatest: false,
        processCwd: '/unrelated-process-cwd',
        thinkingSpecified: false,
      },
      canonicalizer({ '/stored-link': '/repo' }),
    );

    assert.equal(selected.kind, 'existing');
    assert.equal(selected.cwd, '/repo');
    assert.equal(selected.kind === 'existing' ? selected.session : undefined, stored);
    assert.equal(stored.cwd, '/stored-link');
  });

  test('resume accepts a canonically equal explicit cwd and rejects a conflict', async () => {
    const stored = session({ id: 'resume-me', cwd: '/stored-link' });
    const deps = canonicalizer({
      '/stored-link': '/repo',
      '/explicit-link': '/repo',
      '/other': '/other',
    });

    const selected = await selectMakaRunSession(
      {
        sessions: [stored],
        resumeId: stored.id,
        continueLatest: false,
        explicitCwd: '/explicit-link',
        processCwd: '/ignored',
        thinkingSpecified: false,
      },
      deps,
    );
    assert.equal(selected.cwd, '/repo');

    await assert.rejects(
      selectMakaRunSession(
        {
          sessions: [stored],
          resumeId: stored.id,
          continueLatest: false,
          explicitCwd: '/other',
          processCwd: '/ignored',
          thinkingSpecified: false,
        },
        deps,
      ),
      /--cwd conflicts/,
    );
  });

  test('resume accepts Auto sessions and rejects missing cwd, unsupported backend, and explicit config conflicts', async () => {
    const deps = canonicalizer({ '/repo': '/repo' });
    const base = session({ id: 'resume-me', cwd: '/repo', thinkingLevel: 'high' });

    await assert.rejects(
      selectMakaRunSession(
        {
          sessions: [session({ id: 'resume-me', cwd: undefined })],
          resumeId: 'resume-me',
          continueLatest: false,
          processCwd: '/ignored',
          thinkingSpecified: false,
        },
        deps,
      ),
      /has no stored cwd/,
    );
    const auto = session({ id: 'resume-me', permissionMode: 'ask' });
    const resumedAuto = await selectMakaRunSession(
      {
        sessions: [auto],
        resumeId: 'resume-me',
        continueLatest: false,
        processCwd: '/ignored',
        thinkingSpecified: false,
      },
      deps,
    );
    assert.equal(resumedAuto.kind === 'existing' ? resumedAuto.session : undefined, auto);
    for (const conflict of [
      { explicitConnection: 'other' },
      { explicitModel: 'other' },
      { thinkingSpecified: true, explicitThinking: undefined },
      { explicitPermissionMode: 'bypass' as const },
    ]) {
      await assert.rejects(
        selectMakaRunSession(
          {
            sessions: [base],
            resumeId: base.id,
            continueLatest: false,
            processCwd: '/ignored',
            thinkingSpecified: false,
            ...conflict,
          },
          deps,
        ),
        /conflicts with resumed session/,
      );
    }
  });

  test('continue selects by lastMessageAt descending then id ascending after cwd filtering', async () => {
    const selected = await selectMakaRunSession(
      {
        sessions: [
          session({ id: 'archived', lastMessageAt: 500, isArchived: true }),
          session({ id: 'blocked', lastMessageAt: 500, status: 'blocked' }),
          session({ id: 'ask', lastMessageAt: 500, permissionMode: 'ask' }),
          session({ id: 'missing-time', lastMessageAt: undefined }),
          session({ id: 'inaccessible', cwd: '/missing', lastMessageAt: 400 }),
          session({ id: 'b', cwd: '/repo-link', lastMessageAt: 300 }),
          session({ id: 'a', cwd: '/repo', lastMessageAt: 300, status: 'aborted' }),
          session({ id: 'older', cwd: '/repo', lastMessageAt: 200 }),
        ],
        continueLatest: true,
        processCwd: '/process-link',
        thinkingSpecified: false,
      },
      canonicalizer({
        '/process-link': '/repo',
        '/repo-link': '/repo',
        '/repo': '/repo',
      }),
    );

    assert.equal(selected.kind, 'existing');
    assert.equal(selected.kind === 'existing' ? selected.session.id : undefined, 'ask');
    assert.equal(selected.cwd, '/repo');
  });

  test('continue skips linked child sessions while explicit resume still accepts them', async () => {
    const child = session({
      id: 'child',
      lastMessageAt: 500,
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'parent',
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground',
      },
    });
    const parent = session({ id: 'parent', lastMessageAt: 100 });
    const deps = canonicalizer({ '/repo': '/repo' });

    const continued = await selectMakaRunSession(
      {
        sessions: [child, parent],
        continueLatest: true,
        processCwd: '/repo',
        thinkingSpecified: false,
      },
      deps,
    );
    assert.equal(continued.kind === 'existing' ? continued.session.id : undefined, parent.id);

    const resumed = await selectMakaRunSession(
      {
        sessions: [child, parent],
        resumeId: child.id,
        continueLatest: false,
        processCwd: '/repo',
        thinkingSpecified: false,
      },
      deps,
    );
    assert.equal(resumed.kind === 'existing' ? resumed.session.id : undefined, child.id);
  });

  test('continue returns a preflight failure when no cwd-compatible session exists', async () => {
    await assert.rejects(
      selectMakaRunSession(
        {
          sessions: [session({ id: 'other', cwd: '/other', lastMessageAt: 10 })],
          continueLatest: true,
          processCwd: '/repo',
          thinkingSpecified: false,
        },
        canonicalizer({ '/repo': '/repo', '/other': '/other' }),
      ),
      /no compatible session found/,
    );
  });
});

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    cwd: '/repo',
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 100,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'explore',
    ...overrides,
  };
}

function canonicalizer(paths: Record<string, string>) {
  return {
    async canonicalizeDirectory(path: string): Promise<string> {
      const canonical = paths[path];
      if (!canonical) throw new Error(`missing path: ${path}`);
      return canonical;
    },
  };
}
