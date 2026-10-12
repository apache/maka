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
import { AttachmentIngestBlockedError, MAX_ATTACHMENT_DROP_COUNT } from '@maka/core/attachments';
import {
  useComposerAttachments,
  type ComposerAttachmentService,
} from '../use-composer-attachments.js';

type Hook = ReturnType<typeof useComposerAttachments>;
type Toast = readonly [title: string, description: string | undefined];

const copy = {
  attachmentFailedTitle: 'Failed to add attachment',
  tryAgain: 'Try again later.',
  imageAttachmentNotDirectTitle: 'Image added as an attachment',
  imageAttachmentNotDirectDescription: 'The image has been provided as an attachment.',
  folderNotAttachable: 'Folders cannot be added as attachments.',
  folderNotAttachableUseReference:
    'Folders cannot be added as attachments. Use Reference folder instead.',
};

function service(
  detectDirectories?: ComposerAttachmentService['detectDirectories'],
): ComposerAttachmentService {
  return {
    pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
    previewApproval: async () => ({ ok: false, reason: 'unused' }),
    pickDirectory: async () => ({ ok: false, reason: 'cancelled' }),
    ...(detectDirectories ? { detectDirectories } : {}),
  };
}

async function withAttachments(
  options: { directoryHostId?: string; service: ComposerAttachmentService },
  run: (hook: () => Hook, toasts: Toast[]) => Promise<void>,
): Promise<void> {
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
  const toasts: Toast[] = [];
  let latest: Hook | undefined;
  function Harness() {
    latest = useComposerAttachments({
      copy,
      formatError: (error, fallback) =>
        error instanceof AttachmentIngestBlockedError ? `blocked:${error.code}` : fallback,
      draftKey: 'draft-1',
      ...(options.directoryHostId ? { directoryHostId: options.directoryHostId } : {}),
      toastApi: {
        error(title, description) {
          toasts.push([title, description]);
        },
      },
      service: options.service,
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
    }, toasts);
  } finally {
    await act(async () => {
      root.unmount();
    });
    Object.assign(globalThis, original);
  }
}

const folder = () => new File([], 'Project');
const notes = () => new File(['notes'], 'notes.txt', { type: 'text/plain' });

test('a dropped or pasted folder is refused and pointed at Reference folder, while its siblings stage (#5279)', async () => {
  const seen: File[][] = [];
  const dropped = [folder(), notes()];
  await withAttachments(
    {
      directoryHostId: 'local-host',
      service: service(async (files) => {
        seen.push([...files]);
        return [true, false];
      }),
    },
    async (hook, toasts) => {
      await act(async () => {
        await hook().attachFilePaths(dropped);
      });
      assert.deepEqual(seen, [dropped], 'the detector sees the files exactly as dropped');
      assert.deepEqual(hook().pendingAttachments.map(({ displayName }) => displayName), ['notes.txt']);
      assert.deepEqual(toasts, [[copy.attachmentFailedTitle, copy.folderNotAttachableUseReference]]);
    },
  );
});

test('without a local folder picker the refusal does not point at Reference folder (#5279)', async () => {
  await withAttachments({ service: service(async () => [true]) }, async (hook, toasts) => {
    await act(async () => {
      await hook().attachFilePaths([folder()]);
    });
    assert.deepEqual(hook().pendingAttachments, []);
    assert.deepEqual(toasts, [[copy.attachmentFailedTitle, copy.folderNotAttachable]]);
  });
});

test('the largest drop a composer takes is still checked in full (#5279)', async () => {
  const asked: number[] = [];
  await withAttachments(
    {
      directoryHostId: 'local-host',
      service: service(async (files) => {
        asked.push(files.length);
        return files.map(() => true);
      }),
    },
    async (hook, toasts) => {
      await act(async () => {
        await hook().attachFilePaths(Array.from({ length: MAX_ATTACHMENT_DROP_COUNT }, folder));
      });
      assert.deepEqual(asked, [MAX_ATTACHMENT_DROP_COUNT]);
      assert.deepEqual(hook().pendingAttachments, []);
      assert.deepEqual(toasts, [[copy.attachmentFailedTitle, copy.folderNotAttachableUseReference]]);
    },
  );
});

test('a larger drop is refused whole, unchecked, in the send limit\'s words (#5279)', async () => {
  let asked = 0;
  await withAttachments(
    {
      directoryHostId: 'local-host',
      service: service(async (files) => {
        asked += 1;
        return files.map(() => false);
      }),
    },
    async (hook, toasts) => {
      await act(async () => {
        await hook().attachFilePaths(Array.from({ length: MAX_ATTACHMENT_DROP_COUNT + 1 }, notes));
      });
      assert.equal(asked, 0);
      assert.deepEqual(hook().pendingAttachments, []);
      assert.deepEqual(toasts, [[copy.attachmentFailedTitle, 'blocked:count_limit']]);
    },
  );
});

test('files stage unchanged when a surface cannot detect directories, or detection fails (#5279)', async () => {
  for (const detector of [
    undefined,
    async (): Promise<readonly boolean[]> => {
      throw new Error('detection unavailable');
    },
  ]) {
    await withAttachments({ directoryHostId: 'local-host', service: service(detector) }, async (hook, toasts) => {
      await act(async () => {
        await hook().attachFilePaths([folder(), notes()]);
      });
      assert.deepEqual(
        hook().pendingAttachments.map(({ displayName }) => displayName),
        ['Project', 'notes.txt'],
      );
      assert.deepEqual(toasts, []);
    });
  }
});
