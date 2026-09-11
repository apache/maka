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
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { TranscriptViewerOverlay } from '../pi-tui-transcript-viewer.js';
import { MakaTranscriptComponent } from '../pi-tui-layout.js';
import { createMakaPiTranscriptState } from '../pi-transcript.js';
import { stripAnsi } from '../tui-ansi.js';

describe('TranscriptViewerOverlay', () => {
  test('opens at the tail and supports line, page, and boundary navigation', () => {
    const document = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    let changes = 0;
    let closed = 0;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: document, anchors: [] }),
      viewportRows: () => 6,
      onChange: () => {
        changes += 1;
      },
      onClose: () => {
        closed += 1;
      },
    });

    assert.deepEqual(plain(viewer.render(40)).slice(1, -1).map(trim), [
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);

    viewer.handleInput('\x1b[A');
    assert.deepEqual(plain(viewer.render(40)).slice(1, -1).map(trim), [
      'line 8',
      'line 9',
      'line 10',
      'line 11',
    ]);

    viewer.handleInput('\x1b[5~');
    assert.deepEqual(plain(viewer.render(40)).slice(1, -1).map(trim), [
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ]);

    viewer.handleInput('\x1b[H');
    assert.deepEqual(plain(viewer.render(40)).slice(1, -1).map(trim), [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);

    viewer.handleInput('\x1b[F');
    assert.deepEqual(plain(viewer.render(40)).slice(1, -1).map(trim), [
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);
    assert.equal(changes, 4);
    assert.equal(closed, 0);
  });

  test('follows appended output only while positioned at the end', () => {
    const document = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`);
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: document, anchors: [] }),
      viewportRows: () => 5,
      onChange: () => {},
      onClose: () => {},
    });

    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 4',
      'line 5',
      'line 6',
    ]);
    document.push('line 7');
    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 5',
      'line 6',
      'line 7',
    ]);

    viewer.handleInput('\x1b[A');
    document.push('line 8');
    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 4',
      'line 5',
      'line 6',
    ]);

    viewer.handleInput('\x1b[6~');
    document.push('line 9');
    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 7',
      'line 8',
      'line 9',
    ]);
  });

  test('keeps following after a no-op upward scroll on a short transcript', () => {
    const document = ['line 1', 'line 2'];
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: document, anchors: [] }),
      viewportRows: () => 6,
      onChange: () => {},
      onClose: () => {},
    });

    viewer.render(30);
    viewer.handleInput('\x1b[A');
    for (let index = 3; index <= 10; index += 1) document.push(`line ${index}`);

    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 7',
      'line 8',
      'line 9',
      'line 10',
    ]);
  });

  test('does not re-enable following merely because resizing reaches the tail', () => {
    const document = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    let viewportRows = 6;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: document, anchors: [] }),
      viewportRows: () => viewportRows,
      onChange: () => {},
      onClose: () => {},
    });

    viewer.render(30);
    viewer.handleInput('\x1b[A');
    viewportRows = 7;
    viewer.render(30);
    document.push('line 13');

    assert.deepEqual(plain(viewer.render(30)).slice(1, -1).map(trim), [
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);
  });

  test('closes with q or Escape', () => {
    let closed = 0;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: [], anchors: [] }),
      viewportRows: () => 4,
      onChange: () => {},
      onClose: () => {
        closed += 1;
      },
    });

    viewer.handleInput('q');
    viewer.handleInput('\x1b');
    assert.equal(closed, 2);
  });

  test('prioritizes content and keeps a valid range in tiny viewports', () => {
    const document = ['line 1', 'line 2', 'line 3'];
    let viewportRows = 2;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: document, anchors: [] }),
      viewportRows: () => viewportRows,
      onChange: () => {},
      onClose: () => {},
    });

    assert.match(stripAnsi(viewer.render(30)[0]!), /DETAILED TRANSCRIPT 3-3\/3/);
    assert.equal(trim(stripAnsi(viewer.render(30)[1]!)), 'line 3');

    viewportRows = 1;
    assert.match(stripAnsi(viewer.render(30)[0]!), /DETAILED TRANSCRIPT 0-0\/3/);

    viewportRows = 4;
    const resized = plain(viewer.render(30)).map(trim);
    assert.match(resized[0]!, /DETAILED TRANSCRIPT 2-3\/3/);
    assert.deepEqual(resized.slice(1, 3), ['line 2', 'line 3']);
    assert.match(resized[3] ?? '', /Esc\/Ctrl\+O close/);
  });

  test('renders through a detached geometry projection', () => {
    const state = createMakaPiTranscriptState();
    const entry = { kind: 'user' as const, messageId: 'oldest-message', text: 'oldest prompt' };
    const entryFirstLine = new Map([[entry, 17]]);
    state.entries.push(entry);
    state.renderGeometry = { entryFirstLine, viewportTop: 16 };
    const transcript = new MakaTranscriptComponent(state, () => ({
      title: 'Maka',
      cwd: '/repo',
      model: 'model',
      connectionSlug: 'connection',
      permissionMode: 'ask',
    }));

    const renderDocument = transcript.createDocumentRenderer();
    assert.ok(plain(renderDocument(40).lines).some((line) => line.includes('oldest prompt')));
    assert.equal(state.renderGeometry.viewportTop, 16);
    assert.strictEqual(state.renderGeometry.entryFirstLine, entryFirstLine);
  });

  test('keeps the same entry when earlier details collapse and new text arrives', () => {
    let extra = 0;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: (_, expanded) => {
        const before = expanded ? ['tool A', 'detail 1', 'detail 2', 'detail 3'] : ['tool A'];
        return {
          lines: [...before, 'answer B', 'answer line', 'tail', ...Array(extra).fill('new output')],
          anchors: [
            { id: 'a', line: 0 },
            { id: 'b', line: before.length },
            { id: 'c', line: before.length + 2 },
          ],
        };
      },
      viewportRows: () => 4,
      onClose: () => {},
      onChange: () => {},
    });
    viewer.render(80);
    viewer.handleInput('\x1b[A');
    assert.match(stripAnsi(viewer.render(80)[1]!), /answer B/);
    viewer.handleInput('\x05');
    extra = 5;
    assert.match(stripAnsi(viewer.render(80)[1]!), /answer B/);
    viewer.handleInput('\x05');
    assert.match(stripAnsi(viewer.render(80)[1]!), /answer B/);
  });

  test('search locates Chinese text without filtering the document and Escape restores reading', () => {
    const lines = Array.from({ length: 20 }, (_, i) => (i === 4 ? '账号隔离' : `line ${i}`));
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines, anchors: [] }),
      viewportRows: () => 6,
      onClose: () => assert.fail('search Escape must not close the viewer'),
      onChange: () => {},
    });
    const before = plain(viewer.render(80)).slice(1, -1);
    viewer.handleInput('/');
    viewer.handleInput('账号');
    assert.match(stripAnsi(viewer.render(80)[1]!), /账号隔离/);
    viewer.handleInput('\r');
    viewer.handleInput('\x1b[B');
    assert.match(stripAnsi(viewer.render(80)[1]!), /line 5/);
    viewer.handleInput('\x1b');
    assert.deepEqual(plain(viewer.render(80)).slice(1, -1), before);
  });

  test('focuses the search input and emits the hardware cursor marker', () => {
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => ({ lines: ['account isolation'], anchors: [] }),
      viewportRows: () => 6,
      onClose: () => {},
      onChange: () => {},
    });
    viewer.focused = true;
    viewer.handleInput('/');
    assert.ok(viewer.render(80).some((line) => line.includes(CURSOR_MARKER)));
  });

  test('expanding document tools and thinking never changes the live entries', () => {
    const state = createMakaPiTranscriptState();
    const thinking = {
      kind: 'thinking' as const,
      messageId: 'm',
      text: 'private reasoning',
      expanded: false,
    };
    state.entries.push(thinking);
    const transcript = new MakaTranscriptComponent(state, () => ({
      title: 'Maka',
      cwd: '/repo',
      model: 'model',
      connectionSlug: 'connection',
      permissionMode: 'ask',
    }));
    const render = transcript.createDocumentRenderer();
    assert.match(plain(render(80, true).lines).join('\n'), /private reasoning/);
    assert.equal(thinking.expanded, false);
    assert.doesNotMatch(plain(render(80, false).lines).join('\n'), /private reasoning/);
  });

  test('does not replace the frozen live-scrollback render cache', () => {
    const state = createMakaPiTranscriptState();
    const entry = { kind: 'assistant' as const, messageId: 'message-1', text: 'settled text' };
    state.entries.push(entry);
    const transcript = new MakaTranscriptComponent(state, () => ({
      title: 'Maka',
      cwd: '/repo',
      model: 'model',
      connectionSlug: 'connection',
      permissionMode: 'ask',
    }));

    assert.ok(plain(transcript.render(40)).some((line) => line.includes('settled text')));
    state.renderGeometry.viewportTop = 100;
    entry.text = 'background update';
    const renderDocument = transcript.createDocumentRenderer();
    assert.ok(plain(renderDocument(40).lines).some((line) => line.includes('background update')));

    const liveLines = plain(transcript.render(40));
    assert.ok(liveLines.some((line) => line.includes('settled text')));
    assert.equal(
      liveLines.some((line) => line.includes('background update')),
      false,
    );
  });
});

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

function trim(line: string): string {
  return line.trimEnd();
}
