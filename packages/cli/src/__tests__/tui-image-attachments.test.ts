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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { AttachmentRef, SessionEvent } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import type { TurnMessageSubmitResult } from '@maka/runtime-host/protocol';
import {
  isImageMimeType,
  readFileCapped,
  resolveLocalImageFile,
  stagedImageLabel,
  TuiImageStaging,
} from '../tui-attachments.js';
import type {
  MakaAttachedSessionTurn,
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaRetractedMessages,
  MakaSessionDriver,
  MakaSessionSwitchResult,
  MakaSubmitMessageOptions,
} from '../session-driver.js';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { PermissionMode } from '@maka/core/permission';
import type { RewindTarget } from '../session-driver.js';
import { runMakaPiTui } from '../pi-tui-runner.js';
import {
  FakeTerminal,
  WAIT_BUDGET_MS,
  findInputSurfaceRows,
  plainTerminalOutput,
  waitFor,
  waitForTuiPaint,
} from './tui-terminal-mock.js';

const CLOSE_BUDGET_MS = Math.max(WAIT_BUDGET_MS, 500);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeSessionSummary(sessionId: string, cwd = '/repo'): SessionSummary {
  return {
    id: sessionId,
    cwd,
    name: 'Attachment session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'claude-subscription',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

function imageAttachmentRef(name: string, bytes: number, index: number): AttachmentRef {
  return {
    kind: 'image',
    name,
    mimeType: 'image/png',
    bytes,
    ref: {
      kind: 'session_file',
      sessionId: 'session-1',
      relativePath: `attachment-${index}`,
    },
  };
}

/**
 * The one image-attachment driver for this file: it records what the TUI
 * submits and answers exactly like the Runtime Host does — committed
 * AttachmentRefs from ingest, per-entry attachment grouping on retraction.
 */
class AttachmentDriver implements MakaSessionDriver {
  protected sessionId = 'session-1';
  private turnSeq = 0;
  private ingestSeq = 0;
  readonly ingests: Array<{ name: string; mimeType: string; content: Uint8Array }> = [];
  readonly submits: Array<{ text: string; options: MakaSubmitMessageOptions }> = [];
  readonly deleted: AttachmentRef[] = [];
  readonly switchCalls: string[] = [];
  /** Scripted ingest outcomes, shifted per call; empty means every ingest commits. */
  readonly ingestScript: Array<Error | undefined> = [];
  /** Holds every ingest open until released, so tests can race Send against staging. */
  ingestGate: Promise<void> | undefined;
  /** When set, the next submit rejects once (a refused dispatch, not a lost one). */
  nextSubmitError: Error | undefined;
  /** When set, the next submit resolves undefined (an unprovable admission outcome). */
  nextSubmitUnknown = false;
  /** Live session id for getSessionId; switchSession mutates it. */
  liveSessionId = 'session-1';
  /** When set, ingestAttachment moves the live Session to this id as it
   * resolves — modeling a /session switch landing between ingest and dispatch. */
  switchAfterIngest: string | undefined;
  retracted: MakaRetractedMessages = { text: '', messageIds: [], entries: [] };
  switchedInMessages: StoredMessage[] = [];
  startedTurnListener: ((turn: MakaAttachedSessionTurn) => void) | undefined;

  async ingestAttachment(input: {
    name: string;
    mimeType: string;
    content: Uint8Array;
  }): Promise<AttachmentRef> {
    this.ingests.push({ ...input });
    await this.ingestGate;
    const outcome = this.ingestScript.shift();
    if (this.switchAfterIngest) {
      this.liveSessionId = this.switchAfterIngest;
      this.switchAfterIngest = undefined;
    }
    if (outcome) throw outcome;
    this.ingestSeq += 1;
    return imageAttachmentRef(input.name, input.content.byteLength, this.ingestSeq);
  }

  async deleteAttachment(attachment: AttachmentRef): Promise<void> {
    this.deleted.push(attachment);
  }

  async retractQueued(): Promise<MakaRetractedMessages> {
    return this.retracted;
  }

  preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const turnId = options.turnId ?? `turn-${++this.turnSeq}`;
    return Promise.resolve({
      sessionId: this.sessionId,
      turnId,
      events: this.turnEvents(turnId),
    });
  }

  async submitMessage(
    text: string,
    options: MakaSubmitMessageOptions,
  ): Promise<TurnMessageSubmitResult | undefined> {
    if (this.nextSubmitError) {
      const error = this.nextSubmitError;
      this.nextSubmitError = undefined;
      throw error;
    }
    const unknown = this.nextSubmitUnknown;
    this.nextSubmitUnknown = false;
    this.submits.push({ text, options });
    if (unknown) return undefined;
    const turn = await this.preparePrompt(text, {
      turnId: options.messageId,
      ...(options.modelText !== undefined ? { modelText: options.modelText } : {}),
      ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
    });
    queueMicrotask(() =>
      this.startedTurnListener?.({
        ...turn,
        // Canonical Host admission carries the user Message back: the
        // transcript replacement retires the transient row in favor of the
        // durable one (with its attachment chips).
        messages: [
          {
            type: 'user',
            id: options.messageId,
            turnId: turn.turnId,
            ts: 1,
            text,
            ...(options.attachments ? { attachments: [...options.attachments] } : {}),
          } satisfies StoredMessage,
        ],
        summary: fakeSessionSummary(turn.sessionId),
      }),
    );
    return {
      disposition: 'turn_started',
      turnId: turn.turnId,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    };
  }

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.startedTurnListener = listener;
    return () => {
      if (this.startedTurnListener === listener) this.startedTurnListener = undefined;
    };
  }

  async *turnEvents(turnId: string): AsyncIterable<SessionEvent> {
    yield { type: 'complete', id: `complete-${turnId}`, turnId, ts: 1, stopReason: 'end_turn' };
  }

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    this.switchCalls.push(sessionId);
    this.liveSessionId = sessionId;
    return {
      summary: fakeSessionSummary(sessionId),
      messages: this.switchedInMessages,
    };
  }

  async queryCancelledMessages(): Promise<{ cancelledMessageIds: string[] }> {
    return { cancelledMessageIds: [] };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<SessionEvent> {}

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}
  async renameSession(_name: string): Promise<string | void> {}
  async setModel(_model: string, _connectionSlug?: string, _connectionId?: string): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setThinkingLevel(_level: ThinkingLevel | undefined): Promise<void> {}
  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(_turnId: string): Promise<never> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string | null {
    return this.liveSessionId;
  }
}

function exitMaka(_terminal: FakeTerminal): void {
  const previousExitCode = process.exitCode;
  process.emit('SIGTERM');
  process.exitCode = previousExitCode;
}

async function closeRunner(run: Promise<void>): Promise<void> {
  await Promise.race([
    run,
    delay(CLOSE_BUDGET_MS).then(() => {
      throw new Error('TUI did not close during test cleanup');
    }),
  ]);
}

function editorText(terminal: FakeTerminal): string {
  const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
  // No settled input surface yet (the TUI may still be painting its first
  // frames): an empty read keeps this safe to poll inside waitFor.
  const rows = findInputSurfaceRows(lines);
  if (!rows) return '';
  return lines
    .slice(rows[0] + 1, rows[1])
    .join('\n')
    .trim();
}

function startTui(
  driver: MakaSessionDriver,
  cwd: string,
): {
  terminal: FakeTerminal;
  run: Promise<void>;
} {
  const terminal = new FakeTerminal();
  const run = runMakaPiTui({
    title: 'Maka',
    driver,
    cwd,
    model: 'claude-sonnet-4-5',
    connectionSlug: 'claude-subscription',
    permissionMode: 'ask',
    terminal,
    // The platform default disables taskbar progress on Windows, which would
    // leave progressStates empty and turn-lifecycle waits blind.
    taskbarProgress: true,
    turnActivity: { activities: new SessionActivityRegistry() },
  });
  return { terminal, run };
}

describe('TUI image staging logic', () => {
  test('staging keeps order; descriptors become retained refs in place', () => {
    const staging = new TuiImageStaging();
    staging.stageFile({ name: 'a.png', mimeType: 'image/png', path: '/repo/a.png', bytes: 10 });
    staging.stageFile({ name: 'b.jpg', mimeType: 'image/jpeg', path: '/repo/b.jpg', bytes: 20 });
    assert.deepEqual(
      staging.list().map((item) => (item.kind === 'local' ? item.name : item.attachment.name)),
      ['a.png', 'b.jpg'],
    );

    const first = staging.list()[0]!;
    const ref = imageAttachmentRef('a.png', 10, 1);
    staging.replace(first.stagingKey, ref);
    assert.deepEqual(
      staging.list().map((item) => item.kind),
      ['retained', 'local'],
    );
    const replaced = staging.list()[0]!;
    assert.ok(replaced.kind === 'retained' && replaced.attachment === ref);

    const removed = staging.remove(staging.list()[1]!.stagingKey);
    assert.equal(removed?.kind, 'local');
    assert.equal(staging.size, 1);

    const cleared = staging.clear();
    assert.equal(cleared.length, 1);
    assert.equal(staging.size, 0);
  });

  test('stageRetained registers an already-committed ref for reuse', () => {
    const staging = new TuiImageStaging();
    const ref = imageAttachmentRef('kept.png', 9, 1);
    staging.stageRetained(ref);
    assert.equal(staging.size, 1);
    const item = staging.list()[0]!;
    assert.equal(item.kind, 'retained');
    assert.ok(item.kind === 'retained' && item.attachment === ref);
  });

  test('strip labels carry name, media type, and size — never a path', () => {
    const staging = new TuiImageStaging();
    staging.stageFile({
      name: 'a.png',
      mimeType: 'image/png',
      path: '/secret/dir/a.png',
      bytes: 2048,
    });
    const item = staging.list()[0]!;
    assert.equal(stagedImageLabel(item), '📎 a.png · image/png · 2.0 KB');
    assert.ok(!stagedImageLabel(item).includes('/secret'));
  });

  test('readFileCapped reads a small file and rejects an oversized one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    try {
      const path = join(dir, 'small.png');
      await writeFile(path, new Uint8Array([1, 2, 3, 4]));
      const bytes = await readFileCapped(path, 4);
      assert.equal(bytes.byteLength, 4);

      await assert.rejects(readFileCapped(path, 3), /attachment limit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('resolveLocalImageFile resolves relative paths and derives name and MIME', () => {
    const file = resolveLocalImageFile('shot.PNG', '/repo');
    // Path shape is platform-dependent (Windows resolves a drive root); the
    // contract is: the draft's folder wins, and the file name + MIME derive
    // from the path itself.
    assert.ok(file.absolutePath.endsWith('shot.PNG'), file.absolutePath);
    assert.equal(file.name, 'shot.PNG');
    assert.equal(file.mimeType, 'image/png');
    assert.equal(isImageMimeType(file.mimeType, file.name), true);
    assert.equal(isImageMimeType('text/plain', 'notes.txt'), false);
  });
});

describe('TUI image attachments through Runtime Host', () => {
  test('/attach stages a local descriptor only: no ingest, no editor text, strip chip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'photo.png');
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
      // Ingest belongs to the submit boundary: attaching must not touch the Host.
      assert.deepEqual(driver.ingests, []);
      assert.deepEqual(driver.submits, []);
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.ok(screen.includes('📎 photo.png'));
      assert.ok(!screen.includes(dir), 'no local path may leak into the UI');
      // The editable draft text stays empty — staged images render separately.
      assert.equal(editorText(terminal), '');
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('submit ingests at the submit boundary and dispatches the exact committed refs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const firstPath = join(dir, 'one.png');
    const secondPath = join(dir, 'two.png');
    await writeFile(firstPath, new Uint8Array([1, 2]));
    await writeFile(secondPath, new Uint8Array([3, 4, 5]));
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${secondPath}`);
      terminal.input('\r');
      terminal.input(`/attach ${firstPath}`);
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.screenOutput()).split('Staged:').length >= 3,
      );

      terminal.input('what are these');
      terminal.input('\r');
      await waitFor(() => driver.ingests.length === 2);
      // Ingest order follows staging order.
      assert.deepEqual(
        driver.ingests.map(({ name }) => name),
        ['two.png', 'one.png'],
      );
      await waitFor(() => driver.submits.length === 1);
      const submit = driver.submits[0]!;
      assert.deepEqual(submit.options.attachments, [
        imageAttachmentRef('two.png', 3, 1),
        imageAttachmentRef('one.png', 2, 2),
      ]);
      assert.equal(submit.text, 'what are these');
      // The user row renders the committed refs as chips — the transient row
      // and its canonical replacement both carry them.
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 two.png'));
      // Success consumes staging: the Message owns the refs now.
      assert.ok(!plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
      assert.deepEqual(driver.deleted, []);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a failed ingest inside the submit boundary dispatches nothing and orphans nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const firstPath = join(dir, 'good.png');
    const secondPath = join(dir, 'bad.png');
    await writeFile(firstPath, new Uint8Array([1]));
    await writeFile(secondPath, new Uint8Array([2]));
    const driver = new AttachmentDriver();
    driver.ingestScript.push(undefined, new Error('Host rejected the upload'));
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${firstPath}`);
      terminal.input('\r');
      terminal.input(`/attach ${secondPath}`);
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.screenOutput()).split('Staged:').length >= 3,
      );

      terminal.input('send both');
      terminal.input('\r');
      await waitFor(() => driver.ingests.length === 2);
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('Host rejected the upload'),
      );
      assert.deepEqual(driver.submits, [], 'the Message must not dispatch half-ingested');
      // The artifact committed by the first ingest would be orphaned: it is
      // deleted best-effort, and staging keeps both items for a retry.
      await waitFor(() => driver.deleted.length === 1);
      assert.deepEqual(driver.deleted, [imageAttachmentRef('good.png', 1, 1)]);
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.ok(screen.split('Staged:').length - 1 >= 2);
      // The failed text is recoverable from editor history; the draft text and
      // both staged items survive for the retry.
      assert.ok(screen.includes('Host rejected the upload'));
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a failed dispatch keeps the retained refs, and the retry reuses the same Artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'retry.png');
    await writeFile(imagePath, new Uint8Array([1]));
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      driver.nextSubmitError = new Error('Host refused the message');
      terminal.input(' send me');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('Host refused the message'),
      );
      await waitFor(() => driver.ingests.length === 1);
      assert.equal(driver.submits.length, 0);
      const committedRef = imageAttachmentRef('retry.png', 1, 1);
      // The ingested ref is now retained in staging — nothing was orphaned, and
      // the strip still shows it.
      assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('📎 retry.png'));

      driver.nextSubmitError = undefined;
      terminal.input('\x1b[A'); // Up: recall the failed draft from history
      await waitFor(() => editorText(terminal).includes('send me'));
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      // The retry reuses the exact committed Artifact — no second ingest.
      assert.equal(driver.ingests.length, 1);
      assert.deepEqual(driver.submits[0]?.options.attachments, [committedRef]);
      assert.deepEqual(driver.deleted, []);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('/detach removes a staged image client-side without touching the Host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const firstPath = join(dir, 'a.png');
    const secondPath = join(dir, 'b.png');
    await writeFile(firstPath, new Uint8Array([1]));
    await writeFile(secondPath, new Uint8Array([2]));
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${firstPath}`);
      terminal.input('\r');
      terminal.input(`/attach ${secondPath}`);
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.screenOutput()).split('Staged:').length >= 3,
      );

      terminal.input('/detach 1');
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.screenOutput()).split('Staged:').length - 1 === 1,
      );
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.ok(screen.includes('📎 b.png'));
      assert.ok(!screen.includes('📎 a.png'));
      assert.deepEqual(driver.deleted, [], 'local descriptors leave nothing to clean');

      terminal.input('/detach 9');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('/detach <number>'),
      );

      terminal.input('text only');
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      assert.deepEqual(driver.submits[0]?.options.attachments, [imageAttachmentRef('b.png', 1, 1)]);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a retracted queued message restages its committed attachments and resubmission reuses them', async () => {
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, '/repo');
    try {
      await waitForTuiPaint(terminal);
      // Simulate the Host: a queued message carrying a committed image comes
      // back with Alt+↑.
      const ref = imageAttachmentRef('queued.png', 5, 1);
      driver.retracted = {
        text: 'look at this',
        messageIds: ['m-1'],
        entries: [{ text: 'look at this', attachments: [ref] }],
      };
      terminal.input('\x1b[1;3A'); // Alt+Up
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 queued.png'));
      await waitFor(() => editorText(terminal).includes('look at this'));

      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      // The retained ref rides the new Message untouched — no re-ingest.
      assert.deepEqual(driver.ingests, []);
      assert.deepEqual(driver.submits[0]?.options.attachments, [ref]);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
    }
  });

  test('switching sessions abandons the staged draft and deletes retained Artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'stale.png');
    await writeFile(imagePath, new Uint8Array([1, 2]));
    const driver = new AttachmentDriver();
    const committed = imageAttachmentRef('kept.png', 9, 1);
    driver.switchedInMessages = [
      {
        type: 'user',
        id: 'stored-1',
        turnId: 'turn-stored',
        ts: 1,
        text: 'earlier photo',
        attachments: [committed],
      } satisfies StoredMessage,
    ];
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      // A retracted image is also staged before the switch: its committed
      // Artifact must be cleaned up, the local descriptor just drops.
      const retained = imageAttachmentRef('retracted.png', 4, 2);
      driver.retracted = {
        text: 'recalled',
        messageIds: ['m-1'],
        entries: [{ text: 'recalled', attachments: [retained] }],
      };
      terminal.input('\x1b[1;3A'); // Alt+Up
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('📎 retracted.png'),
      );

      terminal.input('\x03'); // Ctrl+C: destroy the draft
      await waitFor(() => driver.deleted.length === 1);
      assert.deepEqual(driver.deleted, [retained]);

      terminal.input('/session session-2');
      terminal.input('\r');
      await waitFor(() => driver.switchCalls.includes('session-2'));
      // Recovery: the resumed transcript renders the committed attachment as a
      // chip — name and media type, never a local path.
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 kept.png'));
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.ok(!screen.includes(dir), 'no local path may leak into the transcript');

      // A fresh submit in the adopted session carries no stale references.
      terminal.input('after switch');
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      assert.equal(driver.submits[0]?.options.attachments, undefined);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a driver without an attachment authority refuses /attach up front', async () => {
    const driver = new AttachmentDriver();
    // A connection without the artifact authority: the optional methods are
    // simply absent from the surface it exposes.
    const stripped: MakaSessionDriver = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'ingestAttachment' || property === 'deleteAttachment') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { terminal, run } = startTui(stripped, '/repo');
    try {
      await waitForTuiPaint(terminal);
      terminal.input('/attach /tmp/whatever.png');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('attachment authority'),
      );
      assert.equal(stripped.ingestAttachment, undefined);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
    }
  });

  test('a non-image path is refused before anything is staged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const notesPath = join(dir, 'notes.txt');
    await writeFile(notesPath, 'plain text');
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${notesPath}`);
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('Only image files'),
      );
      assert.deepEqual(driver.ingests, []);
      assert.ok(!plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('at most MAX_ATTACHMENT_COUNT images can ride one draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const paths: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const path = join(dir, `img${index}.png`);
      await writeFile(path, new Uint8Array([index]));
      paths.push(path);
    }
    const driver = new AttachmentDriver();
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      for (const path of paths) {
        terminal.input(`/attach ${path}`);
        terminal.input('\r');
      }
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('At most 8'));
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.equal(screen.split('Staged:').length - 1, 8);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('submit-ownership and lifecycle review fixes (#4248 review)', () => {
  test('a second Send cannot duplicate an in-flight batch: it goes out with no attachments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'raced.png');
    await writeFile(imagePath, new Uint8Array([1, 2, 3]));
    const driver = new AttachmentDriver();
    const gate = deferred<void>();
    driver.ingestGate = gate.promise;
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      terminal.input('first send');
      terminal.input('\r');
      await waitFor(() => driver.ingests.length === 1);
      // The attempt synchronously claimed the batch: the strip is empty while
      // the ingest is in flight, and a second Send has nothing to claim.
      assert.ok(!plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
      terminal.input('second send');
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      assert.equal(driver.submits[0]?.text, 'second send');
      assert.equal(driver.submits[0]?.options.attachments, undefined);

      gate.resolve();
      await waitFor(() => driver.submits.length === 2);
      // The exact claimed batch rides the first send — once.
      assert.deepEqual(driver.submits[1]?.text, 'first send');
      assert.deepEqual(driver.submits[1]?.options.attachments, [
        imageAttachmentRef('raced.png', 3, 1),
      ]);
      assert.equal(driver.ingests.length, 1);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('/attach and /detach during an in-flight attempt shape a fresh batch only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const firstPath = join(dir, 'claimed.png');
    const secondPath = join(dir, 'later.png');
    await writeFile(firstPath, new Uint8Array([1]));
    await writeFile(secondPath, new Uint8Array([2]));
    const driver = new AttachmentDriver();
    const gate = deferred<void>();
    driver.ingestGate = gate.promise;
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${firstPath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      terminal.input('send claimed');
      terminal.input('\r');
      await waitFor(() => driver.ingests.length === 1);

      // Draft edits during the attempt shape the NEXT message only.
      terminal.input(`/attach ${secondPath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 later.png'));

      gate.resolve();
      await waitFor(() => driver.submits.length === 1);
      assert.deepEqual(driver.submits[0]?.options.attachments, [
        imageAttachmentRef('claimed.png', 1, 1),
      ]);
      assert.equal(driver.submits[0]?.text, 'send claimed');
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a session switch mid-attempt abandons it instead of submitting cross-session refs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'switched.png');
    await writeFile(imagePath, new Uint8Array([1, 2]));
    const driver = new AttachmentDriver();
    // A /session switch lands between ingest resolution and dispatch.
    driver.switchAfterIngest = 'session-2';
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      terminal.input('cross session');
      terminal.input('\r');
      // submitMessage flips the live Session; the attempt must refuse to send
      // another Session's references and must not restage them here either.
      await waitFor(() => driver.ingests.length === 1);
      await waitFor(() => driver.liveSessionId === 'session-2');
      await delay(60);
      assert.deepEqual(driver.submits, []);
      assert.deepEqual(driver.deleted, [imageAttachmentRef('switched.png', 2, 1)]);
      assert.ok(!plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a partial ingest failure rolls the batch back exactly, and the retry re-ingests cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const firstPath = join(dir, 'good.png');
    const secondPath = join(dir, 'bad.png');
    await writeFile(firstPath, new Uint8Array([1]));
    await writeFile(secondPath, new Uint8Array([2]));
    const driver = new AttachmentDriver();
    driver.ingestScript.push(undefined, new Error('Host rejected the upload'));
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${firstPath}`);
      terminal.input('\r');
      terminal.input(`/attach ${secondPath}`);
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.screenOutput()).split('Staged:').length >= 3,
      );

      terminal.input('send both');
      terminal.input('\r');
      await waitFor(() => driver.ingests.length === 2);
      await waitFor(() => driver.deleted.length === 1);
      assert.deepEqual(driver.deleted, [imageAttachmentRef('good.png', 1, 1)]);
      // The earlier descriptor was never converted to a ref-and-deleted pair:
      // both items return to the strip and a retry re-ingests fresh copies.
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 good.png'));
      assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('📎 bad.png'));
      assert.equal(driver.submits.length, 0);

      terminal.input('\x1b[A'); // Up: recall the failed draft
      await waitFor(() => editorText(terminal).includes('send both'));
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      assert.equal(driver.ingests.length, 4);
      const retrySubmit: MakaSubmitMessageOptions | undefined =
        driver.submits[driver.submits.length - 1]?.options;
      assert.deepEqual(retrySubmit?.attachments, [
        imageAttachmentRef('good.png', 1, 2),
        imageAttachmentRef('bad.png', 1, 3),
      ]);
      assert.equal(driver.deleted.length, 1);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an outcome-unknown dispatch keeps the transient row and keeps the refs staged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-tui-attach-'));
    const imagePath = join(dir, 'unknown.png');
    await writeFile(imagePath, new Uint8Array([1, 2, 3, 4]));
    const driver = new AttachmentDriver();
    driver.nextSubmitUnknown = true;
    const { terminal, run } = startTui(driver, dir);
    try {
      await waitForTuiPaint(terminal);
      terminal.input(`/attach ${imagePath}`);
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));

      terminal.input('maybe admitted');
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      // Ownership stays with the attempt: the refs return to staging so a
      // retry reuses the exact Artifacts and /detach can still clean them up.
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('📎 unknown.png'));
      assert.deepEqual(driver.deleted, []);
      // The transient row stays until reconciliation retires or replaces it.
      assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('maybe admitted'));

      // Reconnect-style reconciliation retires the transient row, but the
      // staged refs remain a user-owned retry/cleanup surface either way.
      terminal.input('/detach 1');
      terminal.input('\r');
      await waitFor(() => driver.deleted.length === 1);
      assert.deepEqual(driver.deleted, [imageAttachmentRef('unknown.png', 4, 1)]);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('/detach of a retained ref deletes its Artifact; local descriptors stay client-local', async () => {
    const driver = new AttachmentDriver();
    const retained = imageAttachmentRef('retracted.png', 5, 1);
    // Empty entry text keeps the editor free, so /detach can be typed cleanly.
    driver.retracted = {
      text: '',
      messageIds: ['m-1'],
      entries: [{ text: '', attachments: [retained] }],
    };
    const { terminal, run } = startTui(driver, '/repo');
    try {
      await waitForTuiPaint(terminal);
      terminal.input('\x1b[1;3A'); // Alt+Up restages the retained ref
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('📎 retracted.png'),
      );

      terminal.input('/detach 1');
      terminal.input('\r');
      await waitFor(() => driver.deleted.length === 1);
      assert.deepEqual(driver.deleted, [retained]);
      await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('Staged:'));
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
    }
  });

  test('a two-message retraction restages entry-bounded images so the draft stays submit-able', async () => {
    const driver = new AttachmentDriver();
    const firstBatch = Array.from({ length: 6 }, (_, index) =>
      imageAttachmentRef(`first-${index + 1}.png`, 1, index + 1),
    );
    const secondBatch = Array.from({ length: 6 }, (_, index) =>
      imageAttachmentRef(`second-${index + 1}.png`, 1, index + 7),
    );
    driver.retracted = {
      text: 'first queued\n\nsecond queued',
      messageIds: ['m-1', 'm-2'],
      entries: [
        { text: 'first queued', attachments: firstBatch },
        { text: 'second queued', attachments: secondBatch },
      ],
    };
    const { terminal, run } = startTui(driver, '/repo');
    try {
      await waitForTuiPaint(terminal);
      terminal.input('\x1b[1;3A'); // Alt+Up
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('first queued'));
      await waitFor(() => editorText(terminal).includes('second queued'));
      // Bounded restaging: 8 ride the draft, the 4 overflow are deleted
      // best-effort so nothing lingers without an owner.
      await waitFor(() => driver.deleted.length === 4);
      const screen = plainTerminalOutput(terminal.screenOutput());
      assert.equal(screen.split('Staged:').length - 1, 8);
      assert.ok(screen.includes('retracted image'));
      assert.ok(screen.includes('📎 first-1.png'));

      terminal.input('resubmit');
      terminal.input('\r');
      await waitFor(() => driver.submits.length === 1);
      assert.equal(driver.submits[0]?.options.attachments?.length, 8);
    } finally {
      exitMaka(terminal);
      await closeRunner(run);
    }
  });
});
