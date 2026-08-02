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
    assert.match(markup, /astryx-badge[^>]*>1</);
    assert.match(markup, />Missing project</);
    assert.match(markup, /aria-label="Active project 项目操作"/);
    assert.match(markup, /aria-label="Missing project 项目操作"/);
    // Empty projects are leaves (no fabricated collapsible chrome).
    const missingChunk = markup.slice(
      markup.indexOf('data-project-id="project:project-missing"'),
      markup.indexOf('data-project-id="project:project-missing"') + 1200,
    );
    assert.doesNotMatch(missingChunk, /aria-expanded=/);
    // Active project with sessions is a real disclosure.
    assert.match(markup, /aria-expanded="true"/);
    // Archived disclosure stays collapsible: children always mount so Astryx
    // can keep the chevron; default collapsed hides them with inert/aria-hidden.
    assert.match(markup, />已归档项目</);
    assert.match(markup, /inert[\s\S]*Archived project|aria-hidden="true"[\s\S]*Archived project/);
    assert.match(markup, />Archived project</);
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

    assert.match(markup, /maka-session-heading-section/);
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
    assert.equal((markup.match(/data-session-status="running"/g) ?? []).length, 1);
    assert.equal((markup.match(/data-session-status="blocked"/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /data-session-status="active"/);
    // Active rows keep an empty end slot; only non-active statuses mount a StatusDot.
    const activeChunk =
      markup.match(/data-session-id="active-session"[\s\S]*?(?=data-session-id="|$)/)?.[0] ?? '';
    assert.ok(activeChunk.includes('Active session'));
    assert.doesNotMatch(activeChunk, /data-session-status=/);
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
    assert.match(markup, /data-maka-contract="session-row"/);
    // Nested subagent rows use native SideNavItem Bot icon (lucide-bot).
    const childChunk =
      markup.match(/data-session-id="child"[\s\S]*?(?=data-session-id="|$)/)?.[0] ?? '';
    assert.match(childChunk, /lucide-bot/);
    const parentChunk =
      markup.match(/data-session-id="parent"[\s\S]*?(?=data-session-id="child"|$)/)?.[0] ?? '';
    assert.doesNotMatch(parentChunk, /lucide-bot/);
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

    // Project SideNav rows carry the session ids under each project; group
    // identity is the stable project:* id from deriveProjectGroups.
    const markup = renderSessionListPanel({
      sessions,
      groups,
      viewMode: 'project',
    });
    for (const id of ids) {
      assert.match(
        markup,
        new RegExp(`data-project-id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      );
    }
    assert.match(markup, /data-session-id="a"/);
    assert.match(markup, /data-session-id="b"/);
    assert.match(markup, /data-session-id="c"/);
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
