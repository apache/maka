import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteArtifactStore as createArtifactStore } from '../artifact-store.js';
import * as storage from '../index.js';

test('persists the exact prepared request as a private artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-capture-'));
  const store = createArtifactStore(root);
  const persist = Reflect.get(storage, 'persistProviderRequestCaptureArtifact') as unknown as
    | ((
        store: ReturnType<typeof createArtifactStore>,
        input: Record<string, unknown>,
      ) => Promise<{ id: string; source?: string; sizeBytes: number }>)
    | undefined;
  assert.equal(typeof persist, 'function');
  const serializedRequest = '{"messages":[{"role":"user","content":"exact"}]}';

  const artifact = await persist!(store, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    captureId: 'capture-1',
    step: 2,
    serializedRequest,
    now: 1,
  });

  assert.equal(artifact.source, 'provider_request_capture');
  assert.equal(artifact.sizeBytes, Buffer.byteLength(serializedRequest));
  assert.deepEqual(await store.readText(artifact.id), { ok: true, text: serializedRequest });
});
