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
import { test } from 'node:test';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { retractQueueEntryToDraft } from '../../renderer/app-shell-queue-entry-actions.js';

test('restores a retracted entry to its owning session after the active session changes', async () => {
  const response = deferred<void>();
  const restoreWindow = installWindow(() => response.promise);
  const activeIdRef = { current: 'session-a' as string | undefined };
  const drafts = new Map([
    ['session-a', 'existing A'],
    ['session-b', 'existing B'],
  ]);
  const attachments: Array<{ draftKey: string; names: string[] }> = [];
  const quotes: Array<{ draftKey: string; texts: string[] }> = [];
  const references: Array<{ draftKey: string; starts: number[] }> = [];
  let focusCount = 0;
  const deps = {
    activeIdRef,
    composerRef: {
      current: {
        appendDraft(draftKey, text) {
          const before = drafts.get(draftKey) ?? '';
          drafts.set(draftKey, before ? `${before}\n\n${text}` : text);
        },
        getDraft: (draftKey) => drafts.get(draftKey) ?? '',
        focus: () => {
          focusCount += 1;
        },
      },
    },
    restoreAttachments: (draftKey, restored) => {
      attachments.push({ draftKey, names: restored.map((attachment) => attachment.name) });
    },
    restoreQuotes: (draftKey, restored) => {
      quotes.push({ draftKey, texts: restored.map((quote) => quote.text) });
    },
    setRestoredWorkspaceReferences: (draftKey, restored) => {
      references.push({ draftKey, starts: restored.map((reference) => reference.start) });
    },
    requestFocus: (callback) => callback(),
  } satisfies Parameters<typeof retractQueueEntryToDraft>[0];
  const entry = queuedEntry();

  try {
    const retracting = retractQueueEntryToDraft(deps, 'session-a', entry);
    activeIdRef.current = 'session-b';
    response.resolve();
    await retracting;

    assert.equal(drafts.get('session-a'), 'existing A\n\nrestore @src/app.ts');
    assert.equal(drafts.get('session-b'), 'existing B');
    assert.deepEqual(attachments, [{ draftKey: 'session-a', names: ['notes.md'] }]);
    assert.deepEqual(quotes, [{ draftKey: 'session-a', texts: ['quoted'] }]);
    assert.deepEqual(references, [{ draftKey: 'session-a', starts: [20] }]);
    assert.equal(focusCount, 0);
  } finally {
    restoreWindow();
  }
});

function queuedEntry(): MessageQueueEntryProjection {
  return {
    entryId: 'entry-a',
    messageId: 'message-a',
    placement: 'next_turn',
    state: 'queued',
    content: {
      text: 'model text',
      displayText: 'restore @src/app.ts',
      attachments: [{
        kind: 'doc',
        name: 'notes.md',
        mimeType: 'text/markdown',
        bytes: 5,
        ref: {
          kind: 'session_file',
          sessionId: 'session-a',
          relativePath: 'attachments/notes.md',
        },
      }],
      quotes: [{ text: 'quoted' }],
      inlineReferences: [{
        kind: 'workspace_file',
        value: '@src/app.ts',
        label: 'src/app.ts',
        start: 8,
      }],
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function installWindow(retractQueueEntry: () => Promise<void>): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: { maka: { sessions: { retractQueueEntry } } },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}
