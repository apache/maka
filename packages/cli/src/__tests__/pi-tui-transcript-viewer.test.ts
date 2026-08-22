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
      renderTranscript: () => document,
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
      renderTranscript: () => document,
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
      renderTranscript: () => document,
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

  test('resumes following after a resize clamps a detached viewport to the tail', () => {
    const document = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    let viewportRows = 6;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => document,
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
      'line 9',
      'line 10',
      'line 11',
      'line 12',
      'line 13',
    ]);
  });

  test('closes with q or Escape', () => {
    let closed = 0;
    const viewer = new TranscriptViewerOverlay({
      renderTranscript: () => [],
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
      renderTranscript: () => document,
      viewportRows: () => viewportRows,
      onChange: () => {},
      onClose: () => {},
    });

    assert.deepEqual(plain(viewer.render(30)).map(trim), ['TRANSCRIPT 3-3 of 3', 'line 3']);

    viewportRows = 1;
    assert.deepEqual(plain(viewer.render(30)).map(trim), ['TRANSCRIPT 0-0 of 3']);

    viewportRows = 4;
    const resized = plain(viewer.render(30)).map(trim);
    assert.deepEqual(resized.slice(0, 3), ['TRANSCRIPT 2-3 of 3', 'line 2', 'line 3']);
    assert.match(resized[3] ?? '', /PgUp\/PgDn page/);
  });

  test('renders through a detached geometry projection', () => {
    const state = createMakaPiTranscriptState();
    const entry = { kind: 'user' as const, text: 'oldest prompt' };
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
    assert.ok(plain(renderDocument(40)).some((line) => line.includes('oldest prompt')));
    assert.equal(state.renderGeometry.viewportTop, 16);
    assert.strictEqual(state.renderGeometry.entryFirstLine, entryFirstLine);
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
    assert.ok(plain(renderDocument(40)).some((line) => line.includes('background update')));

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
