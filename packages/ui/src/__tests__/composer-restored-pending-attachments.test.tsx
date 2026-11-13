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
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AttachmentRef } from '@maka/core/events';
import type { PendingAttachment } from '../composer-attachments.js';
import {
  stageRevisionSourceContext,
  type RevisionStagedContext,
} from '../revision-staged-context.js';
import { useComposerAttachments } from '../use-composer-attachments.js';

type Hook = ReturnType<typeof useComposerAttachments>;

async function withAttachments(run: (hook: () => Hook) => Promise<void>): Promise<void> {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  let latest: Hook | undefined;
  function Harness() {
    latest = useComposerAttachments({
      copy: {
        attachmentFailedTitle: 'failed',
        tryAgain: 'try again',
        imageAttachmentNotDirectTitle: 'image',
        imageAttachmentNotDirectDescription: 'image context',
        folderNotAttachable: 'folder',
        folderNotAttachableUseReference: 'folder reference',
      },
      formatError: (_error, fallback) => fallback,
      draftKey: 'session-1',
      toastApi: { error() {} },
      service: {
        pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
        previewApproval: async () => ({ ok: false, reason: 'unused' }),
      },
    });
    return null;
  }
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await run(() => {
      assert.ok(latest);
      return latest;
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    Object.assign(globalThis, original);
  }
}

const sourceRef: AttachmentRef = {
  kind: 'code',
  name: 'source.txt',
  mimeType: 'text/plain',
  bytes: 14,
  ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'a/src' },
};

test('the revision restorer stages pending items verbatim, never re-wrapped (#6246 review)', async () => {
  await withAttachments(async (hook) => {
    // The desktop stagedContext binds this hook entry as the lifecycle's
    // restorer — the revision lifecycle hands it PendingAttachment[] items it
    // created from the source message. Binding the ref-based restoreAttachments
    // here instead is what double-wrapped every restaged item (#6246 review).
    const staged: RevisionStagedContext = {
      quotes: [],
      attachments: [],
      restoreQuotes: () => {},
      clearQuotes: () => [],
      restoreAttachments: hook().restorePendingAttachments,
      clearAttachments: hook().clearAttachmentsAt,
    };
    await act(async () => {
      stageRevisionSourceContext(staged, 'session-1', { attachments: [sourceRef] });
    });
    const plate = hook().pendingAttachments;
    assert.deepEqual(plate.map((item) => item.displayName), ['source.txt']);
    assert.deepEqual(plate.map((item) => item.size), [14]);
    assert.deepEqual(
      plate[0]?.source.type === 'retained' ? plate[0].source.attachment : undefined,
      sourceRef,
      'the pending item carries the source-owned ref, not a wrapped pending item',
    );
    // The restored keys are live, so preview cleanup tracks the items.
    assert.ok(hook().imageNoticeLifecycle.stagedKeys.has(plate[0]?.stagingKey ?? ''));

    // The cancel path re-restores survivors through the same entry: they come
    // back exactly as they left, identity included.
    let cleared: readonly PendingAttachment[] = [];
    await act(async () => {
      cleared = hook().clearAttachmentsAt('session-1');
    });
    assert.deepEqual(cleared, plate);
    await act(async () => {
      hook().restorePendingAttachments('session-1', cleared);
    });
    assert.deepEqual(hook().pendingAttachments, [...cleared], 're-restored items keep their identity');
  });
});
