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
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { spawn as SpawnFn } from 'node:child_process';
// Deep import (pi-tui does not re-export it): the layout frame is what
// TuiAltScreen's doRender builds every frame, so rendering one here exercises
// the exact composition path the fullscreen trial uses.
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { VStack, type Component, type Terminal } from '@earendil-works/pi-tui';
import { createMakaPiTranscriptState } from '../pi-transcript.js';
import {
  MakaActivityStripComponent,
  MakaFullscreenChromeComponent,
  MakaPendingQueueComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
  MakaTranscriptDocumentComponent,
  MakaTranscriptScrollView,
} from '../pi-tui-layout.js';
import {
  isOpenableExternalUrl,
  isNightlyPackageVersion,
  openExternalUrl,
  renderUnreadIndicator,
  resolveTuiFullscreen,
  UnreadOutputCounter,
  type UnreadOutputFeed,
  type TranscriptWindowSnapshot,
} from '../fullscreen-mode.js';
import { stripAnsi } from '../tui-ansi.js';

function fakeTerminal(rows: number): Terminal {
  return { rows, columns: 80 } as Terminal;
}

interface RecordingEditor extends Component {
  readonly viewportRowsHistory: number[];
  showingAutocomplete: boolean;
  setViewportRows(rows: number): void;
  isShowingAutocomplete(): boolean;
  minimumViewportRows(): number;
}

function recordingEditor(lines: string[] = ['╭─╮', '│ │', '╰─╯']): RecordingEditor {
  return {
    showingAutocomplete: false,
    viewportRowsHistory: [],
    invalidate() {},
    render(): string[] {
      // Editor-shaped: with the autocomplete open the real above-editor
      // component fills its whole viewport with suggestion rows above the
      // editor frame, so the fake renders exactly the rows it was budgeted.
      if (this.showingAutocomplete) {
        const budgeted = this.viewportRowsHistory.at(-1) ?? lines.length;
        return Array.from({ length: budgeted }, (_, index) =>
          index < lines.length ? lines[index] : '│ autocomplete suggestion          │',
        );
      }
      return [...lines];
    },
    setViewportRows(rows: number): void {
      this.viewportRowsHistory.push(rows);
    },
    isShowingAutocomplete(): boolean {
      return this.showingAutocomplete;
    },
    minimumViewportRows(): number {
      return 4;
    },
  };
}

function makePendingQueue(
  state: ReturnType<typeof createMakaPiTranscriptState>,
): MakaPendingQueueComponent {
  // The post-merge pending queue takes a UiLocale for localized copy; the
  // branch's predates it and ignores the argument. Going through a variadic
  // constructor view keeps this file compiling in both trees, and 'en' is the
  // catalog these structural assertions see either way.
  return new (
    MakaPendingQueueComponent as unknown as new (
      state: ReturnType<typeof createMakaPiTranscriptState>,
      locale?: 'en' | 'zh',
    ) => MakaPendingQueueComponent
  )(state, 'en');
}

function snapshot(overrides: Partial<TranscriptWindowSnapshot> = {}): TranscriptWindowSnapshot {
  return { followingEnd: true, documentLines: 10, ...overrides };
}

/** An in-memory UnreadOutputFeed, mirroring the runner's scroll-view wiring. */
function memoryFeed(initial = 0): UnreadOutputFeed & { set(value: number): void } {
  let value = initial;
  return {
    current: () => value,
    present: (unreadLines) => {
      value = unreadLines;
    },
    set: (next) => {
      value = next;
    },
  };
}

describe('fullscreen TUI trial switch', () => {
  test('an explicit setting wins over everything else', () => {
    assert.equal(
      resolveTuiFullscreen({
        setting: false,
        override: '1',
        packageVersion: '0.2.0-dev.42.20260829',
      }),
      false,
    );
    assert.equal(
      resolveTuiFullscreen({ setting: true, override: '0', packageVersion: '0.2.0' }),
      true,
    );
  });

  test('the environment override opts a release build in and a nightly out', () => {
    assert.equal(resolveTuiFullscreen({ override: '1', packageVersion: '0.2.0' }), true);
    assert.equal(resolveTuiFullscreen({ override: 'true', packageVersion: '0.2.0' }), true);
    assert.equal(
      resolveTuiFullscreen({ override: '0', packageVersion: '0.2.0-dev.42.20260829' }),
      false,
    );
    assert.equal(
      resolveTuiFullscreen({ override: 'false', packageVersion: '0.2.0-dev.42.20260829' }),
      false,
    );
  });

  test('a malformed override falls through to the channel default', () => {
    assert.equal(resolveTuiFullscreen({ override: 'yes', packageVersion: '0.2.0' }), false);
    assert.equal(
      resolveTuiFullscreen({ override: 'yes', packageVersion: '0.2.0-dev.42.20260829' }),
      true,
    );
    assert.equal(resolveTuiFullscreen({ override: '' }), false);
  });

  test('the default follows the build channel', () => {
    assert.equal(resolveTuiFullscreen({}), false);
    assert.equal(resolveTuiFullscreen({ packageVersion: '0.2.0' }), false);
    assert.equal(resolveTuiFullscreen({ packageVersion: '0.2.0-dev.42.20260829' }), true);
  });

  test('nightly identity detection matches the Product Nightly version format', () => {
    assert.equal(isNightlyPackageVersion('0.2.0-dev.1.20260101'), true);
    assert.equal(isNightlyPackageVersion('0.2.0-dev.999.20261231'), true);
    assert.equal(isNightlyPackageVersion('0.2.0'), false);
    assert.equal(isNightlyPackageVersion('0.2.0-dev.0.20260101'), false);
    assert.equal(isNightlyPackageVersion('0.2.0-dev.42.2026010'), false);
    assert.equal(isNightlyPackageVersion(undefined), false);
    assert.equal(isNightlyPackageVersion(''), false);
  });
});

describe('unread output counter', () => {
  test('stays at zero while following the end', () => {
    const counter = new UnreadOutputCounter();
    assert.equal(counter.update(snapshot({ documentLines: 10 })), 0);
    assert.equal(counter.update(snapshot({ documentLines: 25 })), 0);
  });

  test('accumulates growth while the user is scrolled away', () => {
    const counter = new UnreadOutputCounter();
    assert.equal(counter.update(snapshot({ followingEnd: true, documentLines: 40 })), 0);
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 40 })), 0);
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 45 })), 5);
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 52 })), 12);
  });

  test('returning to the bottom clears the count', () => {
    const counter = new UnreadOutputCounter();
    counter.update(snapshot({ followingEnd: true, documentLines: 40 }));
    counter.update(snapshot({ followingEnd: false, documentLines: 40 }));
    counter.update(snapshot({ followingEnd: false, documentLines: 50 }));
    assert.equal(counter.update(snapshot({ followingEnd: true, documentLines: 50 })), 0);
    // And new growth afterwards is counted from the new baseline.
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 53 })), 3);
  });

  test('a shrinking document never manufactures unread lines', () => {
    const counter = new UnreadOutputCounter();
    counter.update(snapshot({ followingEnd: true, documentLines: 40 }));
    counter.update(snapshot({ followingEnd: false, documentLines: 40 }));
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 30 })), 0);
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 45 })), 15);
  });

  test('the first frame away from the bottom has no baseline to count from', () => {
    const counter = new UnreadOutputCounter();
    assert.equal(counter.update(snapshot({ followingEnd: false, documentLines: 40 })), 0);
  });
});

describe('unread indicator rendering', () => {
  test('renders nothing while there is no unread output', () => {
    assert.deepEqual(
      renderUnreadIndicator(0, (text) => text),
      [],
    );
  });

  test('renders a singular hint for one new line', () => {
    assert.deepEqual(
      renderUnreadIndicator(1, (text) => text),
      ['↓ 1 new line — End to jump to latest'],
    );
  });

  test('renders a plural hint and the jump key for more', () => {
    const [line] = renderUnreadIndicator(14, (text) => text);
    assert.equal(line, '↓ 14 new lines — End to jump to latest');
  });
});

describe('fullscreen chrome component', () => {
  function buildChrome(
    rows: number,
    feed: UnreadOutputFeed,
    metadataOverrides: Record<string, unknown> = {},
  ) {
    const state = createMakaPiTranscriptState();
    const metadata = () => ({
      title: 'Maka',
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      ...metadataOverrides,
    });
    const editor = recordingEditor();
    const chrome = new MakaFullscreenChromeComponent(
      state,
      new MakaActivityStripComponent(metadata),
      makePendingQueue(state),
      editor,
      new MakaStatusLineComponent(metadata),
      fakeTerminal(rows),
      feed,
      (text) => text,
    );
    return { state, chrome, editor };
  }

  test('renders the unread indicator only while lines accumulated away from the bottom', () => {
    const feed = memoryFeed();
    const { chrome } = buildChrome(24, feed);
    assert.deepEqual(
      chrome.render(80).filter((line) => line.includes('new lines')),
      [],
    );
    feed.set(10);
    const lines = chrome.render(80);
    assert.equal(
      lines.some((line) => line.includes('↓ 10 new lines — End to jump to latest')),
      true,
    );
  });

  test('reserves a transcript row and the chrome rows when sizing the editor', () => {
    const { chrome, editor } = buildChrome(24, memoryFeed());
    chrome.render(80);
    // Editor budget = rows − status (1) − transcript minimum (1). The editor
    // renders 3 border/content rows, activity strip 0, pending 0, indicator 0 —
    // so the transcript keeps its row and nothing overflows.
    assert.equal(editor.viewportRowsHistory.at(-1), 22);
  });

  test('sizes the editor to its full budget when the autocomplete is open on a short terminal', () => {
    const { chrome, editor } = buildChrome(8, memoryFeed());
    editor.showingAutocomplete = true;
    const lines = chrome.render(80);
    // rows 8 − transcript 1 − status 1 = 6 available below the transcript;
    // with the autocomplete open the queue trims first, so the editor gets
    // all 6 rows and the editor-shaped fake fills them, leaving the reserved
    // transcript row intact: 6 chrome rows + 1 status + 1 transcript = 8.
    assert.equal(editor.viewportRowsHistory.at(-1), 6);
    assert.equal(lines.length, 7);
  });

  test('keeps a blank separator between the transcript and a running activity strip', () => {
    const feed = memoryFeed();
    const { chrome } = buildChrome(24, feed, { turnElapsedMs: 5_000 });
    const lines = chrome.render(80);
    const stripIndex = lines.findIndex((line) => stripAnsi(line).startsWith('Working…'));
    assert.ok(stripIndex >= 1, 'expected the activity strip in the chrome output');
    assert.equal(lines[stripIndex - 1], '');
  });
});

describe('fullscreen layout frame', () => {
  const ROWS = 10;

  interface FrameHarness {
    state: ReturnType<typeof createMakaPiTranscriptState>;
    scrollView: MakaTranscriptScrollView;
    document: MakaTranscriptDocumentComponent;
    /** Renders one frame exactly the way TuiAltScreen.doRender does. */
    render(): ReturnType<typeof renderLayoutFrame>;
    /** Plain-text lines of a freshly rendered frame. */
    plainLines(): string[];
    /**
     * Catch-up requests raised during the most recent frame render. Scroll
     * gestures between frames also fire pi-tui's persisted request callback;
     * only in-frame requests come from the unread convergence.
     */
    frameCatchUps: number;
    addEntries(count: number): void;
    documentLines(): number;
  }

  function build(): FrameHarness {
    const state = createMakaPiTranscriptState();
    const metadata = () => ({
      title: 'Maka',
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
    });
    const transcript = new MakaTranscriptComponent(state, metadata);
    const document = new MakaTranscriptDocumentComponent(transcript);
    const scrollView = new MakaTranscriptScrollView(document, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'hidden',
    });
    const editor = recordingEditor();
    const chrome = new MakaFullscreenChromeComponent(
      state,
      new MakaActivityStripComponent(metadata),
      makePendingQueue(state),
      editor,
      new MakaStatusLineComponent(metadata),
      fakeTerminal(ROWS),
      {
        current: () => scrollView.computedUnread,
        present: (unreadLines) => {
          scrollView.presentedUnread = unreadLines;
        },
      },
      (text) => text,
    );
    const root = new VStack([
      { component: scrollView, basis: 0, grow: 1, minSize: 1 },
      { component: chrome, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
    const harness: FrameHarness = {
      state,
      scrollView,
      document,
      frameCatchUps: 0,
      render: () => {
        // Count only requests raised inside this frame's layout walk — the
        // unread convergence. Scroll gestures between frames also fire
        // pi-tui's persisted request callback; those are not catch-ups.
        let inFrame = 0;
        const frame = renderLayoutFrame(root, 80, ROWS, () => {
          inFrame += 1;
        });
        harness.frameCatchUps = inFrame;
        return frame;
      },
      plainLines: () => harness.render().lines.map((line) => stripAnsi(line)),
      addEntries: (count) => {
        for (let index = 0; index < count; index += 1) {
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: `HISTORY-ENTRY-${state.entries.length}-${'x'.repeat(40)}`,
          });
        }
      },
      documentLines: () => document.documentLines,
    };
    return harness;
  }

  test('keeps the composer anchored at the bottom of the viewport', () => {
    const harness = build();
    harness.addEntries(6);
    const lines = harness.plainLines();
    assert.equal(lines.length, ROWS);
    assert.match(lines.at(-1) ?? '', /claude-sonnet-4-5/);
    // The editor's bottom border sits directly above the status line — the
    // composer is anchored to the screen bottom regardless of transcript size.
    assert.match(lines.at(-2) ?? '', /╰/);
  });

  test('follows the newest output while at the bottom', () => {
    const harness = build();
    harness.addEntries(30);
    harness.render();
    const firstFrameDocument = harness.documentLines();
    harness.addEntries(3);
    harness.render();
    assert.ok(harness.documentLines() > firstFrameDocument);
    assert.equal(harness.scrollView.isFollowingEnd, true);
    // The transcript window above the chrome shows the newest entry.
    const lines = harness.plainLines();
    assert.match(lines.join('\n'), /HISTORY-ENTRY-32/);
  });

  test('preserves the reading position when content grows while scrolled away', () => {
    const harness = build();
    harness.addEntries(40);
    harness.render();
    harness.scrollView.scrollBy(-6);
    harness.render();
    const scrollTop = harness.scrollView.scrollTop;
    const topLineBefore = harness.plainLines()[0];
    harness.addEntries(5);
    harness.render();
    assert.equal(harness.scrollView.scrollTop, scrollTop);
    assert.equal(harness.scrollView.isFollowingEnd, false);
    assert.equal(harness.plainLines()[0], topLineBefore);
    assert.ok(scrollTop > 0);
  });

  test('counts lines appended while scrolled away, settling on the catch-up frame', () => {
    const harness = build();
    harness.addEntries(40);
    harness.plainLines();
    harness.scrollView.scrollBy(-6);
    harness.plainLines();
    const baseline = harness.documentLines();
    harness.addEntries(5);
    // First frame after growth: the chrome was measured before the scroll view
    // laid out, so it still renders the previous count — and the scroll view
    // schedules the catch-up frame.
    assert.doesNotMatch(harness.plainLines().join('\n'), /new lines — End to jump to latest/);
    assert.equal(harness.frameCatchUps, 1);
    const expected = harness.documentLines() - baseline;
    // Catch-up frame: the indicator appears with the exact appended-line count.
    assert.match(
      harness.plainLines().join('\n'),
      new RegExp(`↓ ${expected} new lines — End to jump to latest`),
    );
    assert.equal(harness.frameCatchUps, 0, 'a settled count must not request further frames');
  });

  test('jumping back to the bottom clears the indicator on the catch-up frame', () => {
    const harness = build();
    harness.addEntries(40);
    harness.plainLines();
    harness.scrollView.scrollBy(-6);
    harness.addEntries(5);
    harness.plainLines();
    harness.plainLines();
    assert.match(harness.plainLines().join('\n'), /new lines — End to jump to latest/);
    // The End-key path: scroll view returns to follow-end…
    harness.scrollView.scrollToEnd();
    // …the still-rendered count lags one frame…
    assert.match(harness.plainLines().join('\n'), /new lines — End to jump to latest/);
    assert.equal(harness.frameCatchUps, 1);
    // …and the catch-up frame clears it.
    assert.doesNotMatch(harness.plainLines().join('\n'), /new lines — End to jump to latest/);
    assert.equal(harness.frameCatchUps, 0);
  });
});

describe('external URL opener hardening', () => {
  interface RecordedSpawn {
    command: string;
    args: readonly string[];
    /** Live error-listener count on the returned child. */
    errorListeners(): number;
  }

  function recordingSpawn(): { calls: RecordedSpawn[]; spawn: typeof SpawnFn } {
    const calls: RecordedSpawn[] = [];
    const spawn = ((command: string, args: readonly string[], _options?: SpawnOptions) => {
      let errorListeners = 0;
      calls.push({ command, args, errorListeners: () => errorListeners });
      return {
        on(event: string, listener: () => void) {
          if (event === 'error') errorListeners += 1;
          return listener;
        },
        unref() {},
      } as unknown as ChildProcess;
    }) as unknown as typeof SpawnFn;
    return { calls, spawn };
  }

  test('opens web and mail targets with the platform opener', () => {
    assert.equal(isOpenableExternalUrl('https://apache.org'), true);
    assert.equal(isOpenableExternalUrl('http://localhost:8080/?x=1'), true);
    assert.equal(isOpenableExternalUrl('mailto:someone@example.com'), true);
    // `URL` normalizes the scheme to lowercase, so a hostile casing cannot
    // smuggle a scheme past the allowlist either.
    assert.equal(isOpenableExternalUrl('HTTPS://APACHE.ORG'), true);
  });

  test('rejects every non-allowlisted scheme without spawning an opener', () => {
    const rejected = [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ftp://example.com/pub',
      'calc://payload',
      'ms-msdt:id',
      '\\\\server\\share\\payload',
      'not a url',
      '',
      'https://example.com trailing text',
    ];
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const url of rejected) {
        const { calls, spawn } = recordingSpawn();
        openExternalUrl(url, platform, spawn);
        assert.deepEqual(calls, [], `expected no opener for ${JSON.stringify(url)} on ${platform}`);
      }
    }
    assert.equal(isOpenableExternalUrl('file:///etc/passwd'), false);
  });

  test('never routes a URL through cmd.exe, whatever metacharacters it carries', () => {
    const hostile = [
      'https://example.com/?x=1&calc.exe',
      'https://example.com/?x=1|calc.exe',
      'https://example.com/?x=%PATH%',
      'https://example.com/?q="quoted"&x=1',
    ];
    for (const url of hostile) {
      const { calls, spawn } = recordingSpawn();
      openExternalUrl(url, 'win32', spawn);
      assert.deepEqual(
        calls.map((call) => call.command),
        ['rundll32'],
        `expected the shell-free rundll32 opener for ${JSON.stringify(url)}`,
      );
      assert.deepEqual(calls[0]?.args, ['url.dll,FileProtocolHandler', url]);
    }
  });

  test('passes macOS and Linux targets as plain argv elements', () => {
    const { calls, spawn } = recordingSpawn();
    openExternalUrl('https://apache.org?x=1&y=2', 'darwin', spawn);
    openExternalUrl('https://apache.org?x=1&y=2', 'linux', spawn);
    assert.deepEqual(
      { command: calls[0]?.command, args: calls[0]?.args },
      { command: 'open', args: ['https://apache.org?x=1&y=2'] },
    );
    assert.deepEqual(
      { command: calls[1]?.command, args: calls[1]?.args },
      { command: 'xdg-open', args: ['https://apache.org?x=1&y=2'] },
    );
  });

  test('keeps the spawned child and swallows its asynchronous error event', () => {
    // spawn reports a missing binary via the child's 'error' event, not a
    // synchronous throw; with no listener attached Node re-emits it as an
    // uncaughtException, which the TUI treats as fatal and begins teardown.
    // The opener must attach exactly one listener so a dead link degrades to
    // "nothing opened" on every platform shape.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const { calls, spawn } = recordingSpawn();
      openExternalUrl('https://apache.org', platform, spawn);
      assert.equal(calls.length, 1, `expected one spawn on ${platform}`);
      assert.equal(calls[0]?.errorListeners(), 1, `expected the error listener on ${platform}`);
    }
  });

  test('a missing opener binary fires the async error and the session survives it', async () => {
    // Real child process, no mocks: xdg-open does not exist on most hosts
    // this suite runs on, so libuv reports ENOENT asynchronously — exactly
    // the path that surfaced as an uncaughtException before the fix.
    // Observing the error through an extra listener proves the event fired;
    // this test completing at all proves it was swallowed instead of ending
    // the process.
    let child: ChildProcess | undefined;
    const recorder = ((command: string, args: readonly string[], options?: SpawnOptions) => {
      child = spawn(command, args, options ?? {});
      return child;
    }) as unknown as typeof SpawnFn;
    openExternalUrl('https://apache.org', 'linux', recorder);
    assert.ok(child, 'expected the opener to spawn');
    const error = await Promise.race([
      new Promise<NodeJS.ErrnoException>((resolve) => child!.once('error', resolve)),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('spawn error never fired')), 5_000);
        timer.unref();
      }),
    ]);
    assert.equal(error.code, 'ENOENT');
  });
});
