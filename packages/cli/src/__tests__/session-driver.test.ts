import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  CreateSessionInput,
  ExecutionBoundary,
  PermissionMode,
  QueueEnqueueOutcome,
  SessionEvent,
  SessionSummary,
  StoredMessage,
  UserMessageInput,
  UserQuestionResponse,
} from '@maka/core';
import { createGenesisExecutionBoundary, createReadOnlyPermissionProfile } from '@maka/core';
import { permissionModeLabel } from '../pi-transcript.js';
import { permissionModePickerItems } from '../pi-tui-pickers.js';
import { createMakaSessionDriver } from '../session-driver.js';
import type {
  ContextDiagnostics,
  RuntimeContinuation,
  SafeBoundaryContinuationPlan,
} from '@maka/runtime';

describe('Maka session driver', () => {
  test('creates an ask-permission session from the first prompt and streams the turn', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    const turn = await driver.preparePrompt('please inspect this workspace');
    assert.equal(runtime.sent.length, 0, 'turn ownership must be available before runtime starts');
    const events = await collect(turn.events);

    assert.equal(driver.getSessionId(), 'session-1');
    assert.deepEqual(runtime.created, [
      {
        cwd: '/repo',
        name: 'New Chat',
        backend: 'ai-sdk',
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
        permissionMode: 'ask',
      },
    ]);
    assert.deepEqual(runtime.sent, [
      {
        sessionId: 'session-1',
        input: { turnId: 'turn-1', text: 'please inspect this workspace' },
      },
    ]);
    assert.deepEqual(
      { sessionId: turn.sessionId, turnId: turn.turnId },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
      },
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['text_delta', 'complete'],
    );
  });

  test('new sessions use the default title while displayText keeps the typed prompt', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    const typed = '/skill:alpha 帮我整理';
    const composed = 'The user explicitly invoked…\n\n<user-message>\n帮我整理\n</user-message>';
    const turn = await driver.preparePrompt(typed, { modelText: composed });
    await collect(turn.events);

    assert.equal(runtime.created[0]?.name, 'New Chat');
    assert.deepEqual(runtime.sent[0]?.input, {
      turnId: 'turn-1',
      text: composed,
      displayText: typed,
    });
  });

  test('can still create a bypass session when explicitly requested', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypass',
      newId: nextId('turn'),
    });

    await collectPrompt(driver, 'ship fast');

    assert.equal(runtime.created[0]?.permissionMode, 'bypass');
  });

  test('uses an updated permission mode for a new session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setPermissionMode('execute');
    await collectPrompt(driver, 'run tests');

    assert.equal(runtime.created[0]?.permissionMode, 'execute');
  });

  test('updates permission mode on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'run tests');
    await driver.setPermissionMode('execute');

    assert.deepEqual(runtime.permissionModes, [
      {
        sessionId: 'session-1',
        mode: 'execute',
      },
    ]);
  });

  test('uses an updated orchestration mode for a new session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setOrchestrationMode?.('swarm');
    await collectPrompt(driver, 'analyze in parallel');

    assert.equal(driver.getOrchestrationMode?.(), 'swarm');
    assert.equal(runtime.created[0]?.orchestrationMode, 'swarm');
  });

  test('updates orchestration mode on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'start');
    await driver.setOrchestrationMode?.('swarm');
    await driver.setOrchestrationMode?.('default');

    assert.deepEqual(runtime.orchestrationModes, [
      { sessionId: 'session-1', mode: 'swarm' },
      { sessionId: 'session-1', mode: 'default' },
    ]);
    assert.equal(driver.getOrchestrationMode?.(), 'default');
  });

  test('passes a one-turn swarm override as trusted metadata without changing visible text', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    await collect(
      (
        await driver.preparePrompt('inspect runtime, UI, and tests', {
          turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        })
      ).events,
    );
    await collectPrompt(driver, 'summarize normally');

    assert.deepEqual(
      runtime.sent.map(({ input }) => input),
      [
        {
          turnId: 'turn-1',
          text: 'inspect runtime, UI, and tests',
          turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        },
        { turnId: 'turn-2', text: 'summarize normally' },
      ],
    );
    assert.equal(driver.getOrchestrationMode?.(), 'default');
  });

  test('uses an updated model for a new session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setModel('claude-opus-4-1');
    await collectPrompt(driver, 'run tests');

    assert.equal(runtime.created[0]?.model, 'claude-opus-4-1');
  });

  test('updates model on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'run tests');
    await driver.setModel('claude-opus-4-1');

    assert.deepEqual(runtime.sessionUpdates, [
      {
        sessionId: 'session-1',
        patch: { model: 'claude-opus-4-1', thinkingLevel: undefined },
      },
    ]);
  });

  test('switches connection and model together on an active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'run tests');
    await driver.setModel('glm-5.2', 'zai');

    // The connection rides in the same updateSession patch, so the next turn
    // rebuilds the backend on the new provider.
    assert.deepEqual(runtime.sessionUpdates, [
      {
        sessionId: 'session-1',
        patch: { model: 'glm-5.2', thinkingLevel: undefined, llmConnectionSlug: 'zai' },
      },
    ]);
  });

  test('a same-connection setModel does not churn the connection', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'run tests');
    await driver.setModel('claude-opus-4-1', 'anthropic');

    assert.deepEqual(runtime.sessionUpdates, [
      {
        sessionId: 'session-1',
        patch: { model: 'claude-opus-4-1', thinkingLevel: undefined },
      },
    ]);
  });

  test('creates the next session on a connection chosen before any session exists', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.setModel('glm-5.2', 'zai');
    await collectPrompt(driver, 'run tests');

    assert.equal(runtime.created[0]?.llmConnectionSlug, 'zai');
    assert.equal(runtime.created[0]?.model, 'glm-5.2');
  });

  test('renames the active session through runtime updateSession', async () => {
    const runtime = new RecordingRuntime();
    runtime.updatedSessionName = 'Canonical title';
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'run tests');
    const renamed = await driver.renameSession('watcher 根目录事件风暴修复');

    assert.equal(renamed, 'Canonical title');
    assert.deepEqual(runtime.sessionUpdates, [
      {
        sessionId: 'session-1',
        patch: { name: 'watcher 根目录事件风暴修复' },
      },
    ]);
  });

  test('rejects rename before a session starts', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await assert.rejects(driver.renameSession('too early'), /before a session starts/);
    assert.deepEqual(runtime.sessionUpdates, []);
  });

  test('moves an active session, warns about dirty old cwd, and leaves prompts unchanged', async () => {
    const oldCwd = await mkdtemp(join(tmpdir(), 'maka-move-old-'));
    const nextCwd = join(oldCwd, 'worktree-next');
    await mkdir(nextCwd);
    try {
      const runtime = new RecordingRuntime();
      const inspected: string[] = [];
      const canonicalNextCwd = await realpath(nextCwd);
      const driver = createMakaSessionDriver({
        runtime,
        cwd: oldCwd,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
        inspectCwdChanges: async (cwd) => {
          inspected.push(cwd);
          return true;
        },
        newId: nextId('turn'),
      });

      await collectPrompt(driver, 'before move');
      const result = await driver.moveSession!(nextCwd);
      assert.deepEqual(result, {
        previousCwd: oldCwd,
        cwd: canonicalNextCwd,
        changed: true,
        oldCwdDirty: true,
      });
      assert.deepEqual(inspected, [oldCwd]);
      assert.deepEqual(runtime.sessionUpdates.at(-1), {
        sessionId: 'session-1',
        patch: { cwd: canonicalNextCwd },
      });

      await collectPrompt(driver, 'after move');
      assert.equal(runtime.sent.at(-1)?.input.text, 'after move');
      assert.equal(runtime.sent.at(-1)?.input.displayText, undefined);
    } finally {
      await rm(oldCwd, { recursive: true, force: true });
    }
  });

  test('rejects empty, missing, and non-directory move targets before persistence', async () => {
    const oldCwd = await mkdtemp(join(tmpdir(), 'maka-move-validate-'));
    const file = join(oldCwd, 'file.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'file');
    try {
      const runtime = new RecordingRuntime();
      const driver = createMakaSessionDriver({
        runtime,
        cwd: oldCwd,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collectPrompt(driver, 'start');
      await assert.rejects(driver.moveSession!(''), /cannot be empty/);
      await assert.rejects(driver.moveSession!(join(oldCwd, 'missing')), /does not exist/);
      await assert.rejects(driver.moveSession!(file), /not a directory/);
      assert.deepEqual(runtime.sessionUpdates, []);
    } finally {
      await rm(oldCwd, { recursive: true, force: true });
    }
  });

  test('uses the moved cwd for a new session without changing its prompt', async () => {
    const oldCwd = await mkdtemp(join(tmpdir(), 'maka-move-new-session-'));
    const nextCwd = join(oldCwd, 'next');
    await mkdir(nextCwd);
    try {
      const runtime = new RecordingRuntime();
      const driver = createMakaSessionDriver({
        runtime,
        cwd: oldCwd,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
        inspectCwdChanges: async () => false,
      });
      await collectPrompt(driver, 'first');
      await driver.moveSession!(nextCwd);
      driver.startNewSession();
      await collectPrompt(driver, 'new session');
      assert.equal(runtime.sent.at(-1)?.input.text, 'new session');
    } finally {
      await rm(oldCwd, { recursive: true, force: true });
    }
  });

  test('switches to an existing session for the next prompt', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-switch-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        {
          id: 'session-2',
          cwd: repo,
          name: 'Existing chat',
          isFlagged: false,
          isArchived: false,
          labels: [],
          hasUnread: false,
          status: 'active',
          backend: 'ai-sdk',
          llmConnectionSlug: 'anthropic',
          connectionLocked: false,
          model: 'claude-opus-4-1',
          permissionMode: 'execute',
          orchestrationMode: 'swarm',
        },
      ];
      runtime.sessionMessages.set('session-2', [
        storedUserMessage('user-1', 'turn-1', 'previous question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'previous answer'),
      ]);
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      const summary = await driver.switchSession('session-2');
      await collectPrompt(driver, 'continue');

      assert.equal(summary.summary.id, 'session-2');
      assert.deepEqual(
        summary.messages.map((message) => message.id),
        ['user-1', 'assistant-1'],
      );
      assert.equal(runtime.created.length, 0);
      assert.equal(runtime.sent[0]?.sessionId, 'session-2');
      assert.equal(driver.getOrchestrationMode?.(), 'swarm');

      driver.startNewSession();
      await collectPrompt(driver, 'new session keeps swarm');
      assert.equal(runtime.created[0]?.orchestrationMode, 'swarm');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects externally isolated sessions outside their owning harness', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-external-session-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [sessionSummary({ id: 'external', cwd: repo })];
      runtime.executionBoundaries.set('external', { kind: 'external', revision: 0 });
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      await assert.rejects(
        driver.switchSession('external'),
        /externally isolated session external/,
      );
      assert.equal(driver.getSessionId(), null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('derives the resumed TUI mode from the authoritative boundary', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-bypass-session-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'bypass', cwd: repo, permissionMode: 'ask' }),
      ];
      runtime.executionBoundaries.set('bypass', { kind: 'bypass', revision: 3 });
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      const resumed = await driver.switchSession('bypass');

      assert.equal(driver.getPermissionMode?.(), 'bypass');
      // The summary is the runtime's, reported as-is: the boundary is what the
      // display is derived from, so there is no reason to rewrite the header.
      assert.equal(resumed.summary.permissionMode, 'ask');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('presents a resumed read-only session as read-only, and never as the current Auto', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-read-only-session-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'read-only', cwd: repo, permissionMode: 'ask' }),
      ];
      runtime.executionBoundaries.set('read-only', {
        kind: 'managed',
        profile: createReadOnlyPermissionProfile(),
        revision: 4,
      });
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      await driver.switchSession('read-only');

      assert.equal(driver.getPermissionMode?.(), 'explore');
      assert.equal(permissionModeLabel(driver.getPermissionMode!()), 'Read only');
      // #1611: marking Auto as `current` here made "select the option I am
      // already on" silently replace the read-only boundary with a writable
      // one. Neither option may claim to be in force.
      assert.deepEqual(
        permissionModePickerItems(driver.getPermissionMode!()).map((item) => item.description),
        ['protected', 'your files and network, unprotected'],
      );

      // Choosing Auto is therefore a real change, and it is applied.
      await driver.setPermissionMode('ask');
      assert.deepEqual(runtime.permissionModes, [{ sessionId: 'read-only', mode: 'ask' }]);
      assert.equal(driver.getPermissionMode?.(), 'ask');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a fresh session does not inherit the resumed session read-only boundary', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-read-only-new-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'read-only', cwd: repo, permissionMode: 'ask' }),
      ];
      runtime.executionBoundaries.set('read-only', {
        kind: 'managed',
        profile: createReadOnlyPermissionProfile(),
        revision: 1,
      });
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      await driver.switchSession('read-only');
      driver.startNewSession();

      assert.equal(driver.getPermissionMode?.(), 'ask');
      await collectPrompt(driver, 'fresh session');
      assert.equal(runtime.created.at(-1)?.permissionMode, 'ask');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('uses a resumed session cwd without injecting a synthetic reminder', async () => {
    const oldCwd = await mkdtemp(join(tmpdir(), 'maka-move-persisted-old-'));
    const nextCwd = join(oldCwd, 'worktree-next');
    await mkdir(nextCwd);
    try {
      const runtime = new RecordingRuntime();
      const canonicalNextCwd = await realpath(nextCwd);
      runtime.sessionSummaries = [sessionSummary({ id: 'session-2', cwd: canonicalNextCwd })];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: oldCwd,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      await driver.switchSession('session-2');
      await collectPrompt(driver, 'after restart');

      assert.equal(runtime.sent.at(-1)?.input.text, 'after restart');
      assert.equal(runtime.sent.at(-1)?.input.displayText, undefined);
      assert.deepEqual(runtime.sessionUpdates, []);
    } finally {
      await rm(oldCwd, { recursive: true, force: true });
    }
  });

  test('rejects a session summary without a cwd and leaves the active session unchanged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [{ ...sessionSummary({ id: 'no-cwd' }), cwd: undefined }];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collectPrompt(driver, 'hi');

      await assert.rejects(driver.switchSession('no-cwd'), /Session has no working directory/);

      await collectPrompt(driver, 'again');
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.sent[1]?.sessionId, 'session-1');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects switching to a session whose cwd no longer exists', async () => {
    const missingCwd = await mkdtemp(join(tmpdir(), 'maka-missing-session-cwd-'));
    await rm(missingCwd, { recursive: true, force: true });
    const runtime = new RecordingRuntime();
    const deleted = sessionSummary({ id: 'deleted-worktree', cwd: missingCwd });
    runtime.sessionSummaries = [deleted];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    assert.deepEqual(await driver.getSessionResumeAvailability?.(deleted), {
      available: false,
      reason: 'Working directory no longer exists',
    });
    await assert.rejects(
      driver.switchSession('deleted-worktree'),
      new RegExp(`Session cwd no longer exists: ${escapeRegExp(missingCwd)}`),
    );
    assert.equal(driver.getSessionId(), null);
  });

  test('switches across folders and uses the resumed cwd for the next new session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'maka-other-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [sessionSummary({ id: 'other-folder', cwd: elsewhere })];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collectPrompt(driver, 'hi');

      const resumed = await driver.switchSession('other-folder');
      driver.startNewSession();
      await collectPrompt(driver, 'new work here');

      assert.equal(resumed.summary.cwd, elsewhere);
      assert.equal(runtime.sent[0]?.sessionId, 'session-1');
      assert.equal(runtime.created[1]?.cwd, elsewhere);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test('adopts the resumed connection and model for the next new session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-active-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'other-conn', cwd: repo, llmConnectionSlug: 'other-connection' }),
      ];
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await collectPrompt(driver, 'hi');

      await driver.switchSession('other-conn');
      driver.startNewSession();
      await collectPrompt(driver, 'new work here');

      assert.equal(runtime.created[1]?.llmConnectionSlug, 'other-connection');
      assert.equal(runtime.created[1]?.model, 'claude-sonnet-4-5');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('lists current-cwd sessions before other recent sessions', async () => {
    const runtime = new RecordingRuntime();
    runtime.sessionSummaries = [
      sessionSummary({ id: 'other-newer', cwd: '/other', lastMessageAt: 30 }),
      sessionSummary({ id: 'cwd-newer', cwd: '/repo', lastMessageAt: 20 }),
      sessionSummary({ id: 'cwd-older', cwd: '/repo', lastMessageAt: 10 }),
    ];
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const sessions = await driver.listSessions();

    assert.deepEqual(
      sessions.map((session) => session.id),
      ['cwd-newer', 'cwd-older', 'other-newer'],
    );
  });

  test('uses the default turn id generator when one is not injected', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await collectPrompt(driver, 'hi');

    assert.match(runtime.sent[0]?.input.turnId ?? '', /^[0-9a-f-]{36}$/);
  });

  test('compacts the active session through the runtime compact API', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: fixedIds('turn-1', 'turn-compact'),
    });

    await collectPrompt(driver, 'hello');
    const events = await collect(driver.compactSession());

    assert.deepEqual(runtime.compacted, [
      { sessionId: 'session-1', input: { turnId: 'turn-compact' } },
    ]);
    assert.deepEqual(
      runtime.sent.map((item) => item.input.text),
      ['hello'],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['complete'],
    );
  });

  test('plans and streams a safe-boundary resume for the active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: fixedIds('turn-1'),
    });

    await collectPrompt(driver, 'hello');
    const events = await collect(driver.resumeLatest!());

    assert.deepEqual(runtime.resumePlanSessions, ['session-1']);
    assert.equal(runtime.resumedContinuations.length, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ['text_complete', 'complete'],
    );
  });

  test('routes sandbox boundary responses to the active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    await collectPrompt(driver, 'run tests');
    await driver.respondToSandboxBoundary({
      requestId: 'boundary-1',
      decision: 'allow',
    });

    assert.deepEqual(runtime.sandboxBoundaryResponses, [
      {
        sessionId: 'session-1',
        response: {
          requestId: 'boundary-1',
          decision: 'allow',
        },
      },
    ]);
  });

  test('routes user-question responses to the active session', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
      newId: nextId('turn'),
    });

    await collectPrompt(driver, 'choose');
    await driver.respondToUserQuestion?.({ requestId: 'question-1', answers: ['A', null] });

    assert.deepEqual(runtime.userQuestionResponses, [
      {
        sessionId: 'session-1',
        response: { requestId: 'question-1', answers: ['A', null] },
      },
    ]);
  });

  test('lists rewind targets newest-first, one per prompted turn, including the latest', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'first question');
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', '  first question\nmore detail'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'second question'),
      storedAssistantMessage('assistant-2', 'turn-2', 'second answer'),
      storedUserMessage('user-3', 'turn-3', 'third question'),
    ]);

    const targets = await driver.listRewindTargets();

    // Rewinding resets to *before* a turn, so the latest turn (turn-3) is itself a
    // valid target (undo it, edit its prompt, resend). All prompted turns appear
    // newest-first, label = first non-empty prompt line.
    assert.deepEqual(targets, [
      { turnId: 'turn-3', label: 'third question' },
      { turnId: 'turn-2', label: 'second question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('surfaces the interrupted latest turn as a rewind target', async () => {
    // Regression: interrupting a turn leaves its (aborted) turn_state as the last
    // message, so the old head-exclusion dropped exactly the turn the user wanted
    // to redo. Every prompted turn is now a target regardless of the trailing
    // message.
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'first question');
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'interrupted question'),
      storedTurnState('state-2', 'turn-2', 'aborted'),
    ]);

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-2', label: 'interrupted question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('keeps all prompted turns as targets when the head is a non-prompt turn (e.g. compact)', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'first question');
    // A /compact turn has no user message, so it never becomes a target itself;
    // the prompted turns around it stay listed unchanged.
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      storedUserMessage('user-2', 'turn-2', 'second question'),
      storedAssistantMessage('assistant-2', 'turn-2', 'second answer'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    const targets = await driver.listRewindTargets();

    assert.deepEqual(targets, [
      { turnId: 'turn-2', label: 'second question' },
      { turnId: 'turn-1', label: 'first question' },
    ]);
  });

  test('keeps the only prompted turn as a target after a compact', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'only question');
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'only question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'only answer'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-1', label: 'only question' },
    ]);
  });

  test('lists no rewind targets before a session starts, but the sole turn once one exists', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    assert.deepEqual(await driver.listRewindTargets(), []);

    await collectPrompt(driver, 'only question');
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'only question'),
      storedAssistantMessage('assistant-1', 'turn-1', 'only answer'),
    ]);
    // The single turn is now rewindable: reset to before it (an empty branch) and
    // refill its prompt.
    assert.deepEqual(await driver.listRewindTargets(), [
      { turnId: 'turn-1', label: 'only question' },
    ]);
  });

  test('rewinds by branching before the turn, switching onto the branch, and returning its prompt', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'maka-rewind-cwd-'));
    try {
      const runtime = new RecordingRuntime();
      runtime.sessionSummaries = [
        sessionSummary({ id: 'session-1', cwd: repo, orchestrationMode: 'swarm' }),
      ];
      runtime.sessionMessages.set('session-1', [
        storedUserMessage('user-1', 'turn-1', 'first question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
        storedUserMessage('user-2', 'turn-2', 'second question\nwith detail'),
      ]);
      const driver = createMakaSessionDriver({
        runtime,
        cwd: repo,
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-5',
      });
      await driver.switchSession('session-1');

      const result = await driver.rewindToTurn('turn-2');

      // Branches *before* turn-2 (dropping it), and returns turn-2's full prompt
      // — the whole text, not the one-line label — for the editor to refill.
      assert.deepEqual(runtime.branchedBefore, [
        { sessionId: 'session-1', sourceTurnId: 'turn-2' },
      ]);
      assert.deepEqual(runtime.branched, []);
      assert.equal(result.summary.id, 'session-1-branch');
      assert.equal(result.prompt, 'second question\nwith detail');
      assert.equal(driver.getSessionId(), 'session-1-branch');
      assert.equal(driver.getOrchestrationMode?.(), 'swarm');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('rejects rewind to a turn with no user prompt', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'first question');
    runtime.sessionMessages.set('session-1', [
      storedUserMessage('user-1', 'turn-1', 'first question'),
      storedContextCompactedNote('note-1', 'turn-compact'),
    ]);

    await assert.rejects(driver.rewindToTurn('turn-compact'), /no user prompt/);
    assert.deepEqual(runtime.branchedBefore, []);
  });

  test('rejects rewind before a session starts', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await assert.rejects(driver.rewindToTurn('turn-1'), /before a session starts/);
    assert.deepEqual(runtime.branchedBefore, []);
  });

  test('startNewSession makes the next prompt create a fresh session, keeping settings', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await driver.setModel('claude-opus-4-1');
    await collectPrompt(driver, 'first');
    assert.equal(driver.getSessionId(), 'session-1');

    driver.startNewSession();
    assert.equal(driver.getSessionId(), null);

    await collectPrompt(driver, 'second');
    // A second createSession call — the prompt started a new session rather than
    // reusing the old one — and it kept the current model.
    assert.equal(runtime.created.length, 2);
    assert.equal(runtime.created[1]?.model, 'claude-opus-4-1');
    assert.equal(runtime.created[1]?.name, 'New Chat');
  });

  test('steer / queueMessage / takePendingFollowup / retractQueued delegate to the runtime', async () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collectPrompt(driver, 'run tests');

    runtime.steerOutcome = { kind: 'queued' };
    assert.deepEqual(driver.steer?.('x'), { kind: 'queued' });
    assert.deepEqual(runtime.steered, [{ sessionId: 'session-1', text: 'x' }]);

    runtime.queueOutcome = { kind: 'queued' };
    assert.deepEqual(driver.queueMessage?.('y'), { kind: 'queued' });
    assert.deepEqual(runtime.queued, [{ sessionId: 'session-1', text: 'y' }]);

    runtime.followupText = 'a\n\nb';
    assert.equal(driver.takePendingFollowup?.(), 'a\n\nb');
    assert.deepEqual(runtime.followupDrains, ['session-1']);

    runtime.retractText = 'x\n\ny';
    assert.equal(driver.retractQueued?.(), 'x\n\ny');
    assert.deepEqual(runtime.retracted, ['session-1']);
  });

  test('steer / queueMessage fall back before any session exists', () => {
    const runtime = new RecordingRuntime();
    const driver = createMakaSessionDriver({
      runtime,
      cwd: '/repo',
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    assert.deepEqual(driver.steer?.('x'), { kind: 'fallback' });
    assert.deepEqual(driver.queueMessage?.('y'), { kind: 'fallback' });
    assert.equal(driver.takePendingFollowup?.(), null);
    assert.equal(driver.retractQueued?.(), '');
    assert.deepEqual(runtime.steered, []);
  });

  test('context diagnostics follow the active persisted session across switch and resume', async () => {
    const runtime = new RecordingRuntime();
    const cwd = process.cwd();
    runtime.sessionSummaries = [sessionSummary({ id: 'session-2', cwd })];
    runtime.contextDiagnostics.set('session-2', {
      status: 'available',
      providerId: 'anthropic',
      modelId: 'claude-test',
      completedAt: 10,
      inputTokens: 40,
      contextWindow: 200,
      segments: [],
    });
    const driver = createMakaSessionDriver({
      runtime,
      cwd,
      llmConnectionSlug: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await driver.switchSession('session-2');
    const beforeResume = await driver.getContextDiagnostics?.();
    await collect(driver.resumeLatest!());
    const afterResume = await driver.getContextDiagnostics?.();

    assert.deepEqual(afterResume, beforeResume);
    assert.deepEqual(runtime.contextReads, ['session-2', 'session-2']);
  });
});

class RecordingRuntime {
  readonly created: CreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; input: UserMessageInput }> = [];
  readonly compacted: Array<{ sessionId: string; input: { turnId?: string } }> = [];
  readonly resumePlanSessions: string[] = [];
  readonly resumedContinuations: RuntimeContinuation[] = [];
  readonly sandboxBoundaryResponses: Array<{
    sessionId: string;
    response: import('@maka/core/sandbox-boundary').SandboxBoundaryResponse;
  }> = [];
  readonly userQuestionResponses: Array<{ sessionId: string; response: UserQuestionResponse }> = [];
  readonly permissionModes: Array<{ sessionId: string; mode: PermissionMode }> = [];
  readonly orchestrationModes: Array<{
    sessionId: string;
    mode: import('@maka/core/orchestration').OrchestrationMode;
  }> = [];
  readonly sessionUpdates: Array<{
    sessionId: string;
    patch: {
      cwd?: string;
      model?: string;
      llmConnectionSlug?: string;
      thinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel | undefined;
      name?: string;
    };
  }> = [];
  readonly branched: Array<{ sessionId: string; sourceTurnId: string }> = [];
  readonly branchedBefore: Array<{ sessionId: string; sourceTurnId: string }> = [];
  readonly sessionMessages = new Map<string, StoredMessage[]>();
  readonly executionBoundaries = new Map<string, ExecutionBoundary>();
  readonly contextDiagnostics = new Map<string, ContextDiagnostics>();
  readonly contextReads: string[] = [];
  sessionSummaries: SessionSummary[] = [];
  updatedSessionName = 'New Chat';

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    this.created.push(input);
    return {
      id: 'session-1',
      name: input.name ?? 'New Chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: input.status ?? 'active',
      backend: input.backend,
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: false,
      model: input.model ?? '',
      permissionMode: input.permissionMode,
    };
  }

  async *sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent> {
    this.sent.push({ sessionId, input });
    yield {
      type: 'text_delta',
      id: 'event-1',
      turnId: input.turnId,
      ts: 1,
      messageId: 'message-1',
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: 'event-2',
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  async *compactSession(
    sessionId: string,
    input: { turnId?: string } = {},
  ): AsyncIterable<SessionEvent> {
    this.compacted.push({ sessionId, input });
    yield {
      type: 'complete',
      id: 'event-compact-complete',
      turnId: input.turnId ?? 'turn-compact',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async planLatestAuthoritativeSafeBoundaryContinuation(
    sessionId: string,
  ): Promise<SafeBoundaryContinuationPlan> {
    this.resumePlanSessions.push(sessionId);
    return {
      disposition: 'continue',
      rejectionReasons: [],
      diagnostics: [],
      continuation: {
        sessionId,
        runId: 'resume-run',
        turnId: 'resume-turn',
      } as RuntimeContinuation,
    };
  }

  async *resumeSafeBoundaryContinuation(
    continuation: RuntimeContinuation,
  ): AsyncIterable<SessionEvent> {
    this.resumedContinuations.push(continuation);
    yield {
      type: 'text_complete',
      id: 'resume-text',
      turnId: continuation.turnId,
      ts: 4,
      messageId: 'resume-message',
      text: 'resumed',
    };
    yield {
      type: 'complete',
      id: 'resume-complete',
      turnId: continuation.turnId,
      ts: 5,
      stopReason: 'end_turn',
    };
  }

  async stopSession(_sessionId: string): Promise<void> {}

  readonly steered: Array<{ sessionId: string; text: string }> = [];
  readonly queued: Array<{ sessionId: string; text: string }> = [];
  readonly followupDrains: string[] = [];
  readonly retracted: string[] = [];
  steerOutcome: QueueEnqueueOutcome = { kind: 'queued' };
  queueOutcome: QueueEnqueueOutcome = { kind: 'queued' };
  followupText: string | null = null;
  retractText = '';

  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    this.steered.push({ sessionId, text });
    return this.steerOutcome;
  }

  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    this.queued.push({ sessionId, text });
    return this.queueOutcome;
  }

  drainFollowup(sessionId: string): string | null {
    this.followupDrains.push(sessionId);
    return this.followupText;
  }

  retractQueue(sessionId: string): string {
    this.retracted.push(sessionId);
    return this.retractText;
  }

  async respondToSandboxBoundary(
    sessionId: string,
    response: import('@maka/core/sandbox-boundary').SandboxBoundaryResponse,
  ): Promise<void> {
    this.sandboxBoundaryResponses.push({ sessionId, response });
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    this.userQuestionResponses.push({ sessionId, response });
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    this.permissionModes.push({ sessionId, mode });
    // The real runtime replaces the session's execution boundary when the mode
    // changes; surfaces read that boundary, so the fake must move it too.
    this.executionBoundaries.set(sessionId, createGenesisExecutionBoundary(mode));
    return {
      id: sessionId,
      name: 'New Chat',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic',
      connectionLocked: false,
      model: 'claude-sonnet-4-5',
      permissionMode: mode,
    };
  }

  async setOrchestrationMode(
    sessionId: string,
    mode: import('@maka/core/orchestration').OrchestrationMode,
  ): Promise<SessionSummary> {
    this.orchestrationModes.push({ sessionId, mode });
    return {
      ...sessionSummary({ id: sessionId }),
      orchestrationMode: mode,
    };
  }

  async updateSession(
    sessionId: string,
    patch: {
      cwd?: string;
      model?: string;
      llmConnectionSlug?: string;
      thinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel | undefined;
      name?: string;
    },
  ): Promise<SessionSummary> {
    this.sessionUpdates.push({ sessionId, patch });
    return {
      id: sessionId,
      cwd: patch.cwd ?? '/repo',
      name: this.updatedSessionName,
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: patch.llmConnectionSlug ?? 'anthropic',
      connectionLocked: false,
      model: patch.model ?? 'claude-sonnet-4-5',
      permissionMode: 'ask',
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessionSummaries;
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.sessionMessages.get(sessionId) ?? [];
  }

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    return (
      this.executionBoundaries.get(sessionId) ?? {
        kind: 'managed',
        profile: {
          type: 'managed',
          fileSystem: { kind: 'restricted', entries: [] },
          network: { kind: 'restricted' },
        },
        revision: 0,
      }
    );
  }

  async getContextDiagnostics(sessionId: string): Promise<ContextDiagnostics> {
    this.contextReads.push(sessionId);
    return (
      this.contextDiagnostics.get(sessionId) ?? {
        status: 'unavailable',
        reason: 'no_completed_request',
      }
    );
  }

  async branchFromTurn(
    sessionId: string,
    input: { sourceTurnId: string; name?: string },
  ): Promise<SessionSummary> {
    this.branched.push({ sessionId, sourceTurnId: input.sourceTurnId });
    return this.recordBranch(sessionId);
  }

  async branchBeforeTurn(
    sessionId: string,
    input: { sourceTurnId: string; name?: string },
  ): Promise<SessionSummary> {
    this.branchedBefore.push({ sessionId, sourceTurnId: input.sourceTurnId });
    return this.recordBranch(sessionId);
  }

  private recordBranch(sessionId: string): SessionSummary {
    // Model a branch by adding a new summary to the list switchSession reads.
    const source = this.sessionSummaries.find((session) => session.id === sessionId);
    const branch: SessionSummary = {
      ...(source ?? sessionSummary({ id: sessionId })),
      id: `${sessionId}-branch`,
    };
    this.sessionSummaries = [...this.sessionSummaries, branch];
    this.sessionMessages.set(branch.id, this.sessionMessages.get(sessionId) ?? []);
    return branch;
  }
}

function nextId(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

function fixedIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? ids[ids.length - 1] ?? 'id';
}

function sessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'session',
    cwd: '/repo',
    name: 'Existing chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...overrides,
  };
}

function storedUserMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'user',
    id,
    turnId,
    ts: 1,
    text,
  };
}

function storedAssistantMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 2,
    text,
    modelId: 'claude-sonnet-4-5',
  };
}

function storedContextCompactedNote(id: string, turnId: string): StoredMessage {
  return {
    type: 'system_note',
    id,
    turnId,
    ts: 3,
    kind: 'context_compacted',
  };
}

function storedTurnState(
  id: string,
  turnId: string,
  status: 'completed' | 'aborted' | 'failed',
): StoredMessage {
  return {
    type: 'turn_state',
    id,
    turnId,
    ts: 4,
    status,
    partialOutputRetained: false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function collectPrompt(
  driver: ReturnType<typeof createMakaSessionDriver>,
  prompt: string,
): Promise<SessionEvent[]> {
  return collect((await driver.preparePrompt(prompt)).events);
}
