import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { filterLinkedSessionTree, projectLinkedSessionTree } from '@maka/core';
import { sessionMatchesNavSelection } from '../../renderer/session-nav-filter.js';
import {
  deriveProjectGroups,
  deriveWorktreeSessionIds,
} from '../../renderer/session-project-grouping.js';
import { makeSessionSummary, renderSessionListPanel } from './session-list-render-helpers.js';

describe('sidebar project view mode', () => {
  it('groups by stable project identity, retains empty projects, and marks only worktree sessions', () => {
    const projects = [
      project('project-1', 'Maka', [
        { path: '/work/maka', isWorktree: false },
        { path: '/work/maka-feature', isWorktree: true },
      ]),
      project('project-2', 'Empty project', [{ path: '/work/empty', isWorktree: false }]),
    ];
    const sessions = [
      makeSessionSummary({
        id: 'main-session',
        projectId: 'project-1',
        cwd: '/work/maka',
      }),
      makeSessionSummary({
        id: 'worktree-session',
        projectId: 'project-1',
        cwd: '/work/maka-feature',
      }),
    ];

    const groups = deriveProjectGroups(sessions, projects, 'zh');

    assert.deepEqual(
      groups.map((group) => ({
        id: group.id,
        label: group.label,
        sessions: group.sessions.map((session) => session.id),
      })),
      [
        {
          id: 'project:project-1',
          label: 'Maka',
          sessions: ['main-session', 'worktree-session'],
        },
        {
          id: 'project:project-2',
          label: 'Empty project',
          sessions: [],
        },
      ],
    );
    assert.deepEqual([...deriveWorktreeSessionIds(sessions, projects)], ['worktree-session']);
  });

  it('keeps a concurrently created session grouped through a merged project alias', () => {
    const surviving = {
      ...project('project-original', 'Original', [
        { path: '/work/relocated', isWorktree: true },
      ]),
      aliases: ['project-duplicate'],
    };
    const session = makeSessionSummary({
      id: 'late-session',
      projectId: 'project-duplicate',
      cwd: '/work/relocated',
    });

    const groups = deriveProjectGroups([session], [surviving], 'zh');

    assert.deepEqual(groups.map((group) => group.sessions.map((item) => item.id)), [
      ['late-session'],
    ]);
    assert.deepEqual([...deriveWorktreeSessionIds([session], [surviving])], ['late-session']);
  });

  it('renders compact project rows, lifecycle menus, archived disclosure, and one worktree icon', () => {
    const active = project('project-active', 'Active project', [
      { path: '/work/active', isWorktree: false },
    ]);
    const unavailable = {
      ...project('project-missing', 'Missing project', [
        { path: '/work/missing', isWorktree: false },
      ]),
      available: false,
      preferredPath: undefined,
    };
    const archived = {
      ...project('project-archived', 'Archived project', [
        { path: '/work/archived', isWorktree: false },
      ]),
      archivedAt: 2,
    };
    const worktreeSession = makeSessionSummary({
      id: 'worktree-session',
      name: 'Worktree task',
      projectId: active.id,
      cwd: '/work/active-feature',
    });
    active.locations.push({
      path: '/work/active-feature',
      isWorktree: true,
    });
    const groups = deriveProjectGroups(
      [worktreeSession],
      [active, unavailable, archived],
      'zh',
    );

    const markup = renderSessionListPanel({
      sessions: [worktreeSession],
      groups,
      viewMode: 'project',
      worktreeSessionIds: new Set([worktreeSession.id]),
      projectActions: {
        onNew() {},
        onRename() {},
        onArchive() {},
        onRestore() {},
        onRelink() {},
      },
    });

    assert.match(markup, />Active project</);
    assert.match(markup, /maka-list-project-count[^>]*>1</);
    assert.match(markup, />Missing project</);
    assert.match(markup, /aria-label="Active project 项目操作"/);
    assert.match(markup, /aria-label="Missing project 项目操作"/);
    assert.match(markup, />已归档项目</);
    assert.doesNotMatch(markup, />Archived project</);
    assert.equal((markup.match(/lucide-folder-git-2/g) ?? []).length, 1);
  });

  it('renders project groups, the unassigned bucket, and keeps the conversation fallback path', () => {
    const sessions = [
      makeSessionSummary({
        id: 'repo-session',
        name: 'Repo session',
        projectId: 'project-repo',
        cwd: 'C:\\work\\repo-a',
        status: 'active',
        lastMessageAt: 3,
      }),
      makeSessionSummary({
        id: 'pending-session',
        name: 'Pending session',
        cwd: undefined,
        status: 'active',
        lastMessageAt: undefined,
      }),
    ];

    const projectMarkup = renderSessionListPanel({
      sessions,
      groups: deriveProjectGroups(sessions, [
        project('project-repo', 'repo-a', [
          { path: 'C:\\work\\repo-a', isWorktree: false },
        ]),
      ]),
      viewMode: 'project',
    });
    assert.match(projectMarkup, /repo-a/);
    assert.match(projectMarkup, /Pending session/);

    const fallbackMarkup = renderSessionListPanel({
      sessions: [sessions[1]],
    });
    assert.match(fallbackMarkup, /Pending session/);
    assert.doesNotMatch(fallbackMarkup, /maka-list-group-label/);
  });

  it('moves the conversation/project controls into the session-list heading menu', () => {
    const markup = renderSessionListPanel({ viewMode: 'conversation' });

    assert.match(markup, /class="maka-session-list-heading"[^>]*>会话/);
    assert.match(markup, /aria-label="会话分组方式"/);
    const trigger = markup.match(/<button(?=[^>]*aria-label="会话分组方式")[\s\S]*?<\/button>/)?.[0] ?? '';
    assert.ok(trigger, 'the grouping trigger must render');
    assert.doesNotMatch(trigger, />按时间|>按项目/);
    assert.match(markup, /role="menuitemradio"/);
  });

  it('renders lifecycle state only on non-active conversation rows', () => {
    const sessions = [
      makeSessionSummary({
        id: 'active-session',
        name: 'Active session',
        status: 'active',
      }),
      makeSessionSummary({
        id: 'running-session',
        name: 'Running session',
        status: 'running',
      }),
      makeSessionSummary({
        id: 'blocked-session',
        name: 'Blocked session',
        status: 'blocked',
      }),
    ];
    const markup = renderSessionListPanel({
      sessions,
      viewMode: 'conversation',
    });

    assert.equal((markup.match(/>会话</g) ?? []).length, 1);
    assert.equal((markup.match(/maka-list-group-label/g) ?? []).length, 0);
    assert.equal((markup.match(/maka-list-row-status-icon/g) ?? []).length, 2);
    assert.match(markup, /data-status="running"/);
    assert.match(markup, /data-status="blocked"/);
    assert.doesNotMatch(markup, /data-status="active"/);
    assert.doesNotMatch(markup, />进行中|>需要处理|>可继续|>已完成/);
  });

  it('renders linked child sessions directly beneath their parent as normal selectable rows', () => {
    const parent = makeSessionSummary({ id: 'parent', name: 'Parent task' });
    const child = makeSessionSummary({ id: 'child', name: 'Child agent' });
    const markup = renderSessionListPanel({
      sessions: [parent],
      childSessionsByParentId: new Map([[parent.id, [child]]]),
    });

    assert.ok(markup.indexOf('Parent task') < markup.indexOf('Child agent'));
    assert.match(markup, /data-subagent="true"/);
    assert.match(markup, /data-session-id="child"/);
    assert.match(markup, /lucide-bot/);
  });

  it('applies Chats, Flagged, and Archived filters independently to parents and children', () => {
    const parent = makeSessionSummary({
      id: 'parent',
      name: 'Parent task',
      lastMessageAt: 10,
    });
    const archivedChild = makeSessionSummary({
      id: 'archived-child',
      name: 'Archived child',
      isArchived: true,
      lastMessageAt: 20,
      subagentParent: childRelation(parent.id),
    });
    const flaggedChild = makeSessionSummary({
      id: 'flagged-child',
      name: 'Flagged child',
      isFlagged: true,
      lastMessageAt: 30,
      subagentParent: childRelation(parent.id),
    });
    const archivedParent = makeSessionSummary({
      id: 'archived-parent',
      name: 'Archived parent',
      isArchived: true,
      lastMessageAt: 40,
    });
    const activeChild = makeSessionSummary({
      id: 'active-child',
      name: 'Active child',
      lastMessageAt: 50,
      subagentParent: childRelation(archivedParent.id),
    });
    const tree = projectLinkedSessionTree([
      parent,
      archivedChild,
      flaggedChild,
      archivedParent,
      activeChild,
    ]);
    const filter = (selection: 'chats' | 'flagged' | 'archived') =>
      filterLinkedSessionTree(tree, (session) =>
        sessionMatchesNavSelection(session, { section: 'sessions', filter: selection }),
      );

    const chats = filter('chats');
    assert.deepEqual(
      chats.roots.map((session) => session.id),
      [parent.id, activeChild.id],
    );
    assert.deepEqual(
      chats.childrenByParentId.get(parent.id)?.map((session) => session.id),
      [flaggedChild.id],
    );

    const flagged = filter('flagged');
    assert.deepEqual(
      flagged.roots.map((session) => session.id),
      [flaggedChild.id],
    );

    const archived = filter('archived');
    assert.deepEqual(
      archived.roots.map((session) => session.id),
      [archivedChild.id, archivedParent.id],
    );
  });

  it('keeps a running parent visible when preview metadata is temporarily unavailable', () => {
    const parent = makeSessionSummary({
      id: 'running-parent',
      name: 'Running parent',
      status: 'running',
      lastMessageAt: undefined,
    });
    const child = makeSessionSummary({
      id: 'completed-child',
      name: 'Completed child',
      status: 'active',
      lastMessageAt: 50,
      subagentParent: childRelation(parent.id),
    });
    const tree = filterLinkedSessionTree(
      projectLinkedSessionTree([parent, child]),
      (session) =>
        sessionMatchesNavSelection(session, { section: 'sessions', filter: 'chats' }),
    );

    assert.deepEqual(
      tree.roots.map((session) => session.id),
      [parent.id],
    );
    assert.deepEqual(
      tree.childrenByParentId.get(parent.id)?.map((session) => session.id),
      [child.id],
    );
  });

  it('project group ids stay DOM-safe and distinct when the cwd has spaces or shared basenames', () => {
    const sessions = [
      makeSessionSummary({
        id: 'a',
        projectId: 'project-a',
        cwd: '/Users/me/My Project/repo-a',
      }),
      makeSessionSummary({
        id: 'b',
        projectId: 'project-b',
        cwd: '/Users/me/Other/repo-a',
      }),
      makeSessionSummary({
        id: 'c',
        projectId: 'project-c',
        cwd: 'C:\\work\\spaced dir\\x',
      }),
    ];
    const groups = deriveProjectGroups(sessions, [
      project('project-a', 'repo-a', [
        { path: '/Users/me/My Project/repo-a', isWorktree: false },
      ]),
      project('project-b', 'repo-a', [
        { path: '/Users/me/Other/repo-a', isWorktree: false },
      ]),
      project('project-c', 'x', [
        { path: 'C:\\work\\spaced dir\\x', isWorktree: false },
      ]),
    ]);
    const ids = groups.map((g) => g.id);

    // DOM id must contain no ASCII whitespace and only DOM-safe chars.
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9:_-]+$/, `group id must be DOM-safe, got: ${id}`);
    }
    // Distinct paths collapse to distinct ids even with a shared basename.
    assert.equal(new Set(ids).size, ids.length, 'distinct cwds must produce distinct ids');
    // The human-readable label is still the basename.
    assert.ok(groups.some((g) => g.label === 'repo-a'), 'expected a repo-a label');
    assert.ok(groups.some((g) => g.label === 'x'), 'expected an x label');

    // Astryx TreeList uses the stable group id as its tree identity.
    const markup = renderSessionListPanel({
      sessions,
      groups,
      viewMode: 'project',
    });
    const treeIds = [...markup.matchAll(/data-tree-id="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(treeIds.length >= 3, `expected at least 3 tree ids, got ${treeIds.length}`);
    for (const id of treeIds) {
      assert.match(id, /^[A-Za-z0-9:_-]+$/, `rendered tree id must be DOM-safe, got: ${id}`);
    }
  });
});

function project(
  id: string,
  name: string,
  locations: Array<{ path: string; isWorktree: boolean }>,
) {
  return {
    id,
    name,
    locations,
    available: true,
    preferredPath: locations[0]?.path,
  };
}

function childRelation(parentSessionId: string) {
  return {
    kind: 'subagent' as const,
    parentSessionId,
    spawnedBy: {
      parentRunId: 'parent-run',
      parentTurnId: 'parent-turn',
      toolCallId: `spawn-${parentSessionId}`,
    },
    lifecycle: 'foreground' as const,
  };
}
