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
import { registerHooks } from 'node:module';
import test from 'node:test';
import { invokeFocusedConversation } from '../app/conversationCommands.ts';

const appRoot = new URL('../app/', import.meta.url);
const resourceRoot = new URL('../../../../plugins/workspace/workspace-files/ui/', import.meta.url);
const native = {
  nsh: 'let tracking;\n    export const signal = initial => {\n      let value = initial;\n      const observers = new Set();\n      const read = () => { if (tracking) observers.add(tracking); return value; };\n      read.set = next => {\n        if (Object.is(value, next)) return;\n        value = next;\n        for (const observer of [...observers]) observer();\n      };\n      return read;\n    };\n    export const computed = fn => fn;\n    export const untracked = fn => { const previous = tracking; tracking = undefined; try { return fn(); } finally { tracking = previous; } };\n    export const effect = fn => {\n      let alive = true;\n      const run = () => {\n        if (!alive) return;\n        const previous = tracking;\n        tracking = run;\n        try { fn(); } finally { tracking = previous; }\n      };\n      globalThis.resourceScope.push(() => { alive = false; });\n      run();\n    };\n    export const cleanup = fn => globalThis.resourceScope.push(fn);',
  locale: `export const tr = key => key;`,
  workspaceFileState: `export const createWorkspaceFiles = (_host, options) => ({ sessionId: options.sessionId });`,
  CurrentFile: `export const createCurrentFile = (_host, target) => ({target, anchorValue: target.anchor, setAnchor(next) { this.anchorValue = next; }, dirty() { return Boolean(this.isDirty); }, saving() { return false; }, async save() { this.isDirty = false; return true; }, activate() {}, suspend() { this.suspended = true; }, dispose() {this.disposed = true;}});`,
  currentDiffState: `
    export const resolveDiffSource = (target) => target.source ?? { kind: 'working', area: target.area ?? 'worktree' };
    export const resolveDiffSourceKey = (target) => {
      if (target.sourceKey) return target.sourceKey;
      const src = resolveDiffSource(target);
      if (src.kind === 'working') return 'working:' + src.area;
      if (src.kind === 'compare') {
        if (src.spec.kind === 'branch') return 'branch:' + src.spec.base;
        if (src.spec.kind === 'commit') return 'commit:' + src.spec.oid;
        return 'range:' + src.spec.base + '..' + src.spec.head;
      }
      return 'pr:' + src.repo.host + '/' + src.repo.owner + '/' + src.repo.repo + '#' + src.number;
    };
    export const currentDiffTargetKey = (target) => target.sessionId + '::' + resolveDiffSourceKey(target) + '::' + target.path.bytesBase64;
    export const createCurrentDiff = (_host, target) => ({target, anchorValue: target.anchor, anchor() { return this.anchorValue; }, setAnchor(next) { this.anchorValue = next; }, threads: () => [], setThreads() {}, state: () => ({ kind: 'loading' }), position: { x: 0, y: 0 }, refresh: async () => {}, dispose() { this.disposed = true; }});
  `,
  terminalState: `
    export const completed = reply => reply.value;
    export const terminalRunning = entry => entry.result.status === 'running';
    export const createTerminals = (_host, options) => ({
      entries: () => [],
      sessionId: options.sessionId,
    });
  `,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (
      context.parentURL?.startsWith(resourceRoot.href) ||
      context.parentURL?.startsWith(appRoot.href)
    ) {
      for (const name of Object.keys(native)) if (specifier.endsWith('/' + name)) key = name;
      if (key in native)
        return {
          url: `data:text/javascript,${encodeURIComponent(native[key])}`,
          shortCircuit: true,
        };
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
        return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { createResources } = await import(new URL('resources.ts', resourceRoot));
const { signal } = await import(`data:text/javascript,${encodeURIComponent(native.nsh)}`);
hooks.deregister();

function setup(t, openLink = async () => null) {
  globalThis.resourceScope = [];
  const sessions = signal(['A', 'B']);
  const errors = [];
  const resources = createResources(
    { openLink, pathLabel: (path) => path.bytesBase64 },
    {
      sessions,
      blocked: () => false,
      directory: () => undefined,
      report: (error) => errors.push(error),
    },
  );
  const scope = globalThis.resourceScope;
  t.after(() => {
    for (const dispose of scope.toReversed()) dispose();
  });
  return { resources, sessions, errors };
}
const path = { bytesBase64: 'UkVBRE1FLm1k' };
const file = (sessionId) => ({ sessionId, path, title: 'README.md' });
const image = (sessionId) => ({
  source: { kind: 'attachment-image', read: { sessionId } },
  uri: 'maka://image/shared-name',
  width: 40,
  height: 30,
});

test('resource requests from both workspaces keep their source session, even for identical paths and image URIs', (t) => {
  const { resources } = setup(t);
  resources.openFile(file('A'));
  const a = resources.activeTab();
  assert.equal(a.model.target.sessionId, 'A');
  const oldClose = { sessionId: 'A', instance: resources.instance() };
  resources.openFile(file('B'));
  resources.close(oldClose);
  assert.equal(resources.shown(), true);
  assert.equal(resources.activeTab().model.target.sessionId, 'B');
  assert.equal(resources.sessionId(), 'B');
  assert.equal(a.model.disposed, true);
  resources.openFiles({ sessionId: 'B' });
  assert.equal(resources.files.sessionId(), 'B');
  resources.inventory({ sessionId: 'A', kind: 'terminals' });
  assert.equal(resources.terminals.sessionId(), 'A');
  resources.openImage(image('A'));
  resources.openImage(image('B'));
  assert.equal(resources.activeTab().image.source.read.sessionId, 'B');
});

test('external links do not change the current preview, and file links open in their originating workspace', async (t) => {
  const opened = [];
  const { resources } = setup(t, async (target) => {
    opened.push(target);
    return target.startsWith('https:') ? null : { path };
  });
  resources.openFile(file('A'));
  await resources.openLink('B', 'https://github.com/apache/maka', () => false);
  assert.equal(resources.sessionId(), 'A');
  await resources.openLink('B', 'README.md', () => false);
  assert.equal(resources.activeTab().model.target.sessionId, 'B');
  assert.deepEqual(opened, ['https://github.com/apache/maka', 'README.md']);
});

test('a late file-link result cannot replace a newer request or reopen a closed source session', async (t) => {
  let resolve;
  const { resources, sessions } = setup(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = resources.openLink('A', 'README.md', () => false);
  resources.openFiles({ sessionId: 'B' });
  resolve({ path });
  await first;
  assert.equal(resources.sessionId(), 'B');
  assert.equal(resources.active(), 'files');
  const second = resources.openLink('B', 'README.md', () => false);
  sessions.set(['A']);
  sessions.set(['A', 'B']);
  resolve({ path });
  await second;
  assert.equal(resources.shown(), false);
  assert.equal(resources.sessionId(), null);
  resources.openFiles({ sessionId: 'B' });
  const third = resources.openLink('B', 'README.md', () => false);
  resources.close({ sessionId: 'B', instance: resources.instance() });
  resolve({ path });
  await third;
  assert.equal(resources.shown(), false);
});

test('preview close restores the source pane and removing that session releases its resources', (t) => {
  const { resources, sessions } = setup(t);
  const focused = [];
  resources.attachOpener('A', { focus: () => focused.push('A') });
  resources.attachOpener('B', { focus: () => focused.push('B') });
  resources.openImage(image('B'));
  resources.close({ sessionId: 'B', instance: resources.instance() });
  assert.deepEqual(focused, ['B']);
  resources.openFile(file('B'));
  const model = resources.activeTab().model;
  sessions.set(['A']);
  assert.equal(model.disposed, true);
  assert.equal(resources.shown(), false);
  assert.equal(resources.sessionId(), null);
  resources.openImage(image('B'));
  assert.equal(resources.shown(), false);
});

test('dirty file drafts park across workspace switches and dispose when their session leaves', (t) => {
  const { resources, sessions } = setup(t);
  resources.openFile(file('A'));
  const draft = resources.activeTab().model;
  draft.isDirty = true;
  resources.openFile(file('B'));
  assert.equal(draft.suspended, true);
  assert.equal(draft.disposed, undefined);
  resources.openFiles({ sessionId: 'A' });
  assert.equal(resources.tabs().length, 1);
  assert.equal(resources.tabs()[0].model, draft);
  resources.openFile(file('B'));
  sessions.set(['B']);
  assert.equal(draft.disposed, true);
});

test('window commands follow the focused pane and stop targeting a removed pane', () => {
  let focus = 'A';
  const received = [];
  const pane = (sessionId) => ({
    focused: () => focus === sessionId,
    command: (id) => received.push({ sessionId, id }),
  });
  const a = pane('A');
  const b = pane('B');
  const menu = (id) => invokeFocusedConversation([a, b], id);
  for (const id of ['find', 'models', 'latest', 'commands']) {
    menu(id);
    focus = 'B';
    menu(id);
    focus = 'A';
  }
  assert.deepEqual(received, [
    { sessionId: 'A', id: 'find' },
    { sessionId: 'B', id: 'find' },
    { sessionId: 'A', id: 'models' },
    { sessionId: 'B', id: 'models' },
    { sessionId: 'A', id: 'latest' },
    { sessionId: 'B', id: 'latest' },
    { sessionId: 'A', id: 'commands' },
    { sessionId: 'B', id: 'commands' },
  ]);
  focus = 'B';
  invokeFocusedConversation([a], 'models');
  assert.deepEqual(received.at(-1), { sessionId: 'A', id: 'models' });
});

test('review navigation preserves workspace file:// anchors, history back/forward, and review batch formatting', async (t) => {
  const { formatReviewBatch, extractLineIdentifiers, relativizeWorkspaceFileUrl } = await import(
    new URL('reviewState.ts', appRoot)
  );
  globalThis.resourceScope = [];
  const sessions = signal(['A', 'B']);
  let allowSend = true;
  const prompts = [];
  const openedTargets = [];
  const resources = createResources(
    {
      openLink: async (target) => {
        openedTargets.push(target);
        return { path, parent: null, line: 9, endLine: 14, column: 2 };
      },
      pathLabel: () => 'src/lib.rs',
      query: async () => null,
    },
    {
      sessions,
      blocked: () => false,
      directory: () => '/Users/test/project',
      prompt: (sessionId, action) => {
        if (action.mode === 'send' && !allowSend) return false;
        prompts.push({ sessionId, ...action });
        return true;
      },
      report: () => {},
    },
  );
  const scope = globalThis.resourceScope;
  t.after(() => {
    for (const dispose of scope.toReversed()) dispose();
  });

  resources.openChanges({ sessionId: 'A' });
  assert.equal(resources.active(), 'changes');

  await resources.openLink('A', 'file:///Users/test/project/src/lib.rs#L10-L15', () => false);
  assert.deepEqual(openedTargets, ['src/lib.rs#L10-L15']);
  assert.equal(resources.activeTab().kind, 'file');
  assert.equal(resources.activeTab().model.anchorValue.line, 9);
  assert.equal(resources.activeTab().model.anchorValue.endLine, 14);

  resources.openDiff({
    sessionId: 'A',
    area: 'worktree',
    path,
    title: 'src/lib.rs',
  });
  assert.equal(resources.activeTab().kind, 'diff');
  assert.equal(resources.canGoBack(), true);

  resources.goBack();
  assert.equal(resources.activeTab().kind, 'file');
  assert.equal(resources.canGoForward(), true);

  resources.goForward();
  assert.equal(resources.activeTab().kind, 'diff');

  const note = resources.reviewStore.upsertNote({
    sessionId: 'A',
    path,
    pathLabel: 'src/lib.rs',
    area: 'worktree',
    side: 'new',
    startLine: 9,
    endLine: 11,
    excerpt: 'let lock = state.lock();\nio_work();',
    comment: 'Move I/O outside the mutex guard.',
  });
  const formatted = formatReviewBatch([note]);
  assert.match(formatted, /`src\/lib\.rs#L10-L12`:/);
  assert.match(formatted, /```rust/);
  assert.match(formatted, /Move I\/O outside the mutex guard\./);

  // Jumping to a diff review note updates the diff anchor even when the diff tab is already open.
  resources.jumpToNote(note);
  assert.equal(resources.activeTab().kind, 'diff');
  assert.equal(resources.activeTab().model.anchorValue.line, 9);
  assert.equal(resources.activeTab().model.anchorValue.endLine, 11);

  // Blocked sends return false so callers retain unsent review notes.
  allowSend = false;
  assert.equal(resources.deliverPrompt('A', formatted, 'send'), false);
  assert.equal(prompts.length, 0);

  allowSend = true;
  assert.equal(resources.deliverPrompt('A', formatted, 'send'), true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, 'send');

  // Nested triple-backtick excerpts expand outer fence to avoid breaking Markdown blocks.
  const mdNote = resources.reviewStore.upsertNote({
    sessionId: 'B',
    path,
    pathLabel: 'docs/guide.md',
    side: 'new',
    startLine: 0,
    endLine: 2,
    excerpt: '```ts\nconst x = 1;\n```',
    comment: 'Clarify example.',
  });
  const mdFormatted = formatReviewBatch([mdNote]);
  assert.ok(mdFormatted.includes('````markdown\n```ts'), mdFormatted);

  // Windows file:///C:/... and '#'/'?' percent-encoded filenames relativize without corrupting anchors.
  assert.equal(
    relativizeWorkspaceFileUrl('file:///C:/Users/dev/repo/src/main.rs#L12', 'C:\\Users\\dev\\repo'),
    'src/main.rs#L12',
  );
  assert.equal(
    relativizeWorkspaceFileUrl(
      'file:///Users/test/project/docs/a%23b.md#L10',
      '/Users/test/project',
    ),
    'docs/a%23b.md#L10',
  );

  // Closing session B prunes its review store entries.
  assert.equal(resources.reviewStore.notes('B').length, 1);
  sessions.set(['A']);
  assert.equal(resources.reviewStore.notes('B').length, 0);

  assert.deepEqual(extractLineIdentifiers('pub async fn read_git(repo: &Repository)'), [
    'read_git',
    'repo',
    'Repository',
  ]);
});

test('patch line bijection, viewed digest invalidation, and GitHub PR review state', async (t) => {
  const { buildPatchLineMap, formatGitHubThreadPrompt, formatPrKey, isRangeInSinglePatchHunk } =
    await import(new URL('reviewState.ts', appRoot));
  const { resources } = setup(t);

  const patch = [
    'diff --git a/src/lib.sql b/src/lib.sql',
    '--- a/src/lib.sql',
    '+++ b/src/lib.sql',
    '@@ -10,3 +10,4 @@',
    ' SELECT 1;',
    '--- old sql comment that starts with triple minus in unified diff',
    '+++ new increment-like line that starts with triple plus',
    '+SELECT 2;',
    ' SELECT 3;',
    '@@ -40,1 +41,2 @@',
    ' SELECT 40;',
    '+SELECT 42;',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  const map = buildPatchLineMap(patch);
  assert.deepEqual(map.oldVirtualToReal, [10, 11, 12, 40]);
  assert.deepEqual(map.newVirtualToReal, [10, 11, 12, 13, 41, 42]);
  assert.equal(map.oldLines[1], '-- old sql comment that starts with triple minus in unified diff');
  assert.equal(map.newLines[1], '++ new increment-like line that starts with triple plus');
  assert.equal(map.oldRealToVirtual.get(11), 1);
  assert.equal(map.newRealToVirtual.get(12), 2);
  assert.equal(map.newRealToVirtual.get(42), 5);
  assert.equal(map.newLines[5], 'SELECT 42;');
  assert.equal(isRangeInSinglePatchHunk(map, 'new', 10, 13), true);
  assert.equal(isRangeInSinglePatchHunk(map, 'new', 41, 42), true);
  assert.equal(isRangeInSinglePatchHunk(map, 'new', 1, 1), false);
  assert.equal(isRangeInSinglePatchHunk(map, 'new', 12, 41), false);

  assert.equal(
    resources.reviewStore.isViewed('A', 'branch:main', path.bytesBase64, 'sha-v1'),
    false,
  );
  assert.equal(
    resources.reviewStore.toggleViewed('A', 'branch:main', path.bytesBase64, 'sha-v1'),
    true,
  );
  assert.equal(
    resources.reviewStore.isViewed('A', 'branch:main', path.bytesBase64, 'sha-v1'),
    true,
  );
  assert.equal(
    resources.reviewStore.isViewed('A', 'branch:main', path.bytesBase64, 'sha-v2'),
    false,
  );

  const branchTarget = {
    sessionId: 'A',
    source: {
      kind: 'compare',
      spec: { kind: 'branch', base: 'origin/main' },
      label: 'origin/main…HEAD',
    },
    digest: 'sha-v1',
    path,
    title: 'src/lib.rs',
  };
  const prNote = resources.reviewStore.upsertNote({
    sessionId: 'A',
    path,
    pathLabel: 'src/lib.rs',
    diffTarget: branchTarget,
    side: 'new',
    startLine: 2,
    endLine: 3,
    realStartLine: 12,
    realEndLine: 13,
    excerpt: 'fn extra_call() {}',
    comment: 'Check edge case.',
  });
  resources.jumpToNote(prNote);
  assert.equal(resources.activeTab().kind, 'diff');
  assert.deepEqual(resources.activeTab().model.target.source, branchTarget.source);

  const prKey = formatPrKey({ host: 'github.com', owner: 'apache', repo: 'maka' }, 6974);
  const draft = resources.reviewStore.upsertPrDraft('A', {
    prKey,
    path: 'src/lib.rs',
    side: 'RIGHT',
    line: 42,
    startLine: 41,
    excerpt: 'added_in_second();',
    body: 'Nit: prefer borrowed slice here.',
  });
  assert.equal(resources.reviewStore.prDrafts('A', prKey).length, 1);
  assert.equal(resources.reviewStore.prDrafts('A', prKey)[0].id, draft.id);

  const thread = {
    id: 501,
    path: 'src/lib.rs',
    side: 'RIGHT',
    line: 42,
    startLine: 41,
    outdated: false,
    diffHunk: '@@ -40,2 +41,2 @@',
    comments: [
      {
        id: 501,
        author: 'reviewer',
        body: 'Handle empty slice.',
        createdAt: '2026-11-17T12:00:00Z',
        htmlUrl: 'https://github.com/apache/maka/pull/6974#discussion_r501',
      },
    ],
  };
  resources.reviewStore.setPrThreads('A', prKey, [thread]);
  resources.reviewStore.appendPrThreadReply('A', prKey, 501, {
    id: 502,
    author: 'author',
    body: 'Done!',
    createdAt: '2026-11-17T12:05:00Z',
    htmlUrl: 'https://github.com/apache/maka/pull/6974#discussion_r502',
  });
  const updatedThread = resources.reviewStore.prThreads('A', prKey)[0];
  assert.equal(updatedThread.comments.length, 2);
  const promptText = formatGitHubThreadPrompt(6974, updatedThread, 'fn second_hunk() {');
  assert.ok(promptText.includes('GitHub PR #6974 review thread on `src/lib.rs#L41-L42`'));
  assert.ok(promptText.includes('**@reviewer**: Handle empty slice.'));
});

test('workspace stage launchpad, PR tabs, fullscreen, worktree selection, and scroll/collapse persistence', async (t) => {
  const { basenameLabel, isAutoCollapsedPath } = await import(new URL('reviewState.ts', appRoot));
  const { resources, sessions } = setup(t);

  assert.equal(basenameLabel('plugins/agent/native/src/owner/github.rs'), 'github.rs');
  assert.equal(isAutoCollapsedPath('Cargo.lock'), true);
  assert.equal(isAutoCollapsedPath('packages/app/package-lock.json'), true);
  assert.equal(isAutoCollapsedPath('src/main.rs'), false);

  // Toggling an empty stage opens the New Tab launchpad; toggling again hides without destroying tabs.
  resources.toggleStage({ sessionId: 'A' });
  assert.equal(resources.shown(), true);
  assert.equal(resources.active(), 'launchpad');
  assert.deepEqual(resources.openSections(), ['launchpad']);

  resources.setFullscreen(true);
  assert.equal(resources.fullscreen(), true);

  resources.toggleStage({ sessionId: 'A' });
  assert.equal(resources.shown(), false);
  assert.equal(resources.fullscreen(), false);
  assert.deepEqual(resources.openSections(), ['launchpad']);

  // Opening a GitHub PR creates a deduplicated PR tab, updates title, and surfaces in sources().
  resources.openPullRequest({
    sessionId: 'A',
    repo: { host: 'github.com', owner: 'apache', repo: 'maka' },
    number: 6962,
    title: 'fix(agent): pair late tool results',
  });
  assert.equal(resources.shown(), true);
  assert.equal(resources.activeTab().kind, 'pr');
  assert.equal(resources.activeTab().number, 6962);
  assert.equal(resources.sources('A').length, 1);
  assert.equal(resources.sources('A')[0].kind, 'pr');

  const prInstance = resources.activeTab().instance;
  resources.updateTabTitle(prInstance, '#6962 fix(agent): pair late tool results in model history');
  assert.equal(
    resources.activeTab().title,
    '#6962 fix(agent): pair late tool results in model history',
  );

  // Worktree selection and studio scroll/collapse state persist across tab switches.
  resources.openChanges({ sessionId: 'A', worktreePath: '/tmp/repo/.worktrees/feature-a' });
  assert.equal(resources.active(), 'changes');
  assert.equal(resources.activeWorktree('A'), '/tmp/repo/.worktrees/feature-a');

  resources.reviewStore.patchStudioViewState('A', 'working:/tmp/repo/.worktrees/feature-a', {
    scrollOffset: 480,
    collapsedPaths: { 'Cargo.lock': true, 'src/lib.rs': false },
    filterQuery: 'src/',
  });
  resources.select({ sessionId: 'A', instance: prInstance });
  assert.equal(resources.activeTab().kind, 'pr');
  resources.goBack();
  assert.equal(resources.active(), 'changes');
  const studio = resources.reviewStore.studioViewState(
    'A',
    'working:/tmp/repo/.worktrees/feature-a',
  );
  assert.equal(studio.scrollOffset, 480);
  assert.equal(studio.collapsedPaths['Cargo.lock'], true);
  assert.equal(studio.filterQuery, 'src/');

  // Closing sections & tabs falls back cleanly and hides stage when the last tab closes.
  resources.closeSection({ sessionId: 'A', section: 'changes' });
  assert.equal(resources.active(), prInstance);
  resources.closeTab({ sessionId: 'A', instance: prInstance });
  assert.equal(resources.active(), 'launchpad');
  resources.closeSection({ sessionId: 'A', section: 'launchpad' });
  assert.equal(resources.shown(), false);

  // Pruning session A cleans up worktree & studio state.
  sessions.set(['B']);
  assert.equal(resources.activeWorktree('A'), null);
  assert.equal(
    resources.reviewStore.studioViewState('A', 'working:/tmp/repo/.worktrees/feature-a')
      .scrollOffset,
    0,
  );
});
