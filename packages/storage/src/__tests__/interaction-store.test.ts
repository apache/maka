import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, mock, test } from 'node:test';
import {
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core';
import {
  interactionLocator,
  openInteractiveInteractionStoreForRead,
  openInteractiveInteractionStoreForWrite,
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import {
  InteractionLocatorLane,
  runInteractionStoreOperation,
} from '../interaction-locator-lane.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootReader,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';

const execFileAsync = promisify(execFile);

describe('Interaction Store', () => {
  test('rejects an open whose owner closes while recovery is blocked without caching a facade', {
    skip: process.platform === 'win32',
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-interaction-open-close-race-'));
    const root = join(base, 'root');
    await mkdir(root);
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;

    const probe = await open(root, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    const recoveryBlocked = deferred<void>();
    const releaseRecovery = deferred<void>();
    let blocked = false;
    const syncMock = mock.method(fileHandlePrototype, 'sync', async function (this: typeof probe) {
      if (!blocked) {
        blocked = true;
        recoveryBlocked.resolve();
        await releaseRecovery.promise;
      }
      return originalSync.call(this);
    });

    let opening: Promise<InteractiveInteractionStoreWriterFacade> | undefined;
    let closing: Promise<void> | undefined;
    try {
      opening = openInteractiveInteractionStoreForWrite(owner.lease);
      await recoveryBlocked.promise;
      closing = owner.close();
      assert.equal(owner.closed, true);
      releaseRecovery.resolve();

      await assert.rejects(opening, { code: 'invalid_lease' });
      await closing;
      await assert.rejects(openInteractiveInteractionStoreForWrite(owner.lease), {
        code: 'invalid_lease',
      });
    } finally {
      releaseRecovery.resolve();
      await Promise.allSettled([opening, closing].filter((task) => task !== undefined));
      syncMock.mock.restore();
      if (!owner.closed) await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });

  test('keeps one immutable winner across concurrent calls on the same lease facade', async () => {
    await withStore(async ({ owner, store }) => {
      const sameLeaseStore = await openInteractiveInteractionStoreForWrite(owner.lease);
      const request = storedQuestion('request_winner', 100);
      const established = await Promise.all([
        store.establishRequest(request),
        sameLeaseStore.establishRequest({ ...request, runId: 'run_competing' }),
      ]);
      assert.equal(
        established.filter((result) => result.status === 'stable' && result.matches).length,
        1,
      );
      assert.equal(
        established.filter((result) => result.status === 'stable' && !result.matches).length,
        1,
      );

      const winner = await store.readInteraction(request.requestId);
      assert.ok(winner);
      const equivalentRetry = await store.establishRequest(winner.request);
      assert.equal(equivalentRetry.status, 'stable');
      if (equivalentRetry.status === 'stable') assert.equal(equivalentRetry.matches, true);
      const first = questionOutcome('first', 200);
      const second = questionOutcome('second', 201);
      const outcomes = await Promise.all([
        store.commitOutcome(request.requestId, first),
        sameLeaseStore.commitOutcome(request.requestId, second),
      ]);
      assert.equal(
        outcomes.filter((result) => result.status === 'stable' && result.matches).length,
        1,
      );
      assert.equal(
        outcomes.filter((result) => result.status === 'stable' && !result.matches).length,
        1,
      );
      const canonical = await store.readInteraction(request.requestId);
      assert.ok(canonical?.outcome);
      const equivalent = {
        ...canonical.outcome.outcome,
        committedAt: canonical.outcome.outcome.committedAt + 1,
      } as InteractionCanonicalOutcome;
      const retry = await store.commitOutcome(request.requestId, equivalent);
      assert.equal(retry.status, 'stable');
      if (retry.status === 'stable') assert.equal(retry.matches, true);
    });
  });

  test('filters pending requests and excludes committed records', async () => {
    await withStore(async ({ store }) => {
      const first = storedQuestion('request_first', 200);
      const second = {
        ...storedQuestion('request_second', 100),
        turnId: 'turn_2',
      };
      await store.establishRequest(first);
      await store.establishRequest(second);
      assert.deepEqual(await store.listPending({ turnId: 'turn_2', kind: 'question' }), [second]);
      assert.deepEqual(
        await store.listPending({ sessionId: 'session_1', turnId: 'turn_2', kind: 'question' }),
        [second],
      );
      await store.commitOutcome(second.requestId, questionOutcome('done', 300));
      assert.deepEqual(await store.listPending(), [first]);
    });
  });

  test('lists one Session without reading unrelated canonical history', async () => {
    await withStore(async ({ root, store }) => {
      const target = storedQuestion('request_target', 100);
      await store.establishRequest(target);
      for (let index = 0; index < 64; index += 1) {
        await store.establishRequest({
          ...storedQuestion(`request_unrelated_${index}`, index),
          sessionId: 'session_unrelated',
        });
      }
      const damagedLocator = interactionLocator('request_unrelated_31');
      await writeFile(join(root, 'interactions', damagedLocator, 'request.json'), '{broken');

      assert.deepEqual(await store.listSessionPending(target.sessionId), [target]);
      assert.deepEqual(await store.listPending({ sessionId: target.sessionId }), [target]);
    });
  });

  test('recovery repairs missing and stale Session pending markers', async () => {
    await withStore(async ({ root, owner, store }) => {
      const pending = storedQuestion('request_pending_recovery', 100);
      const settled = storedQuestion('request_settled_recovery', 101);
      await store.establishRequest(pending);
      await store.establishRequest(settled);
      await store.commitOutcome(settled.requestId, questionOutcome('done', 200));

      const sessionPending = join(root, 'interactions', 'pending', interactionLocator('session_1'));
      const missingMarker = join(sessionPending, interactionLocator(pending.requestId));
      const staleMarker = join(sessionPending, interactionLocator(settled.requestId));
      await unlink(missingMarker);
      await writeFile(staleMarker, '');
      assert.deepEqual(await store.listSessionPending('session_1'), []);
      await owner.close();

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      try {
        const reader = await openInteractiveInteractionStoreForRead(readerOwner.lease);
        assert.deepEqual(await reader.listSessionPending('session_1'), [pending]);
        assert.deepEqual(await reader.listPending({ sessionId: 'session_1' }), [pending]);
      } finally {
        await readerOwner.close();
      }

      const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(recoveredOwner);
      if (!recoveredOwner) return;
      try {
        const recovered = await openInteractiveInteractionStoreForWrite(recoveredOwner.lease);
        assert.deepEqual(await recovered.listSessionPending('session_1'), [pending]);
        assert.equal(await readFile(missingMarker, 'utf8'), '');
        await assert.rejects(readFile(staleMarker), { code: 'ENOENT' });
      } finally {
        await recoveredOwner.close();
      }
    });
  });

  test('rejects symlinked pending index directories without writing outside the root', {
    skip: process.platform === 'win32',
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-interaction-index-parent-'));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      await mkdir(join(root, 'interactions'));
      await symlink(outside, join(root, 'interactions', 'pending'), 'dir');
      await assert.rejects(openInteractiveInteractionStoreForWrite(owner.lease), {
        code: 'invalid_record',
      });
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });

  test('rejects a symlinked Session index directory without writing outside the root', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-index-session-'));
      const request = storedQuestion('request_session_symlink', 100);
      const sessionDirectory = join(
        root,
        'interactions',
        'pending',
        interactionLocator(request.sessionId),
      );
      try {
        await symlink(outside, sessionDirectory, 'dir');
        const result = await store.establishRequest(request);
        assert.equal(result.status, 'unresolved');
        if (result.status === 'unresolved') {
          assert.equal(result.failure.code, 'invalid_record');
        }
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('does not publish a request through a pre-existing locator symlink', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-locator-request-'));
      const request = storedQuestion('request_locator_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const sentinel = join(outside, 'sentinel');
      try {
        await writeFile(sentinel, 'unchanged');
        await symlink(outside, locator, 'dir');

        const result = await store.establishRequest(request);
        assert.equal(result.status, 'unresolved');
        if (result.status === 'unresolved') assert.equal(result.failure.code, 'invalid_record');
        assert.deepEqual(await readdir(outside), ['sentinel']);
        assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('does not publish an outcome through a replaced locator symlink', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-locator-outcome-'));
      const request = storedQuestion('outcome_locator_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const sentinel = join(outside, 'sentinel');
      try {
        const established = await store.establishRequest(request);
        assert.equal(established.status, 'stable');
        await rm(locator, { recursive: true });
        await writeFile(sentinel, 'unchanged');
        await symlink(outside, locator, 'dir');

        const result = await store.commitOutcome(request.requestId, questionOutcome('done', 200));
        assert.equal(result.status, 'unresolved');
        if (result.status === 'unresolved') assert.equal(result.failure.code, 'invalid_record');
        assert.deepEqual(await readdir(outside), ['sentinel']);
        assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('does not read canonical documents through a locator symlink', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-locator-read-'));
      const request = storedQuestion('read_locator_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const externalRequest = join(outside, 'request.json');
      try {
        await writeFile(externalRequest, `${JSON.stringify(request)}\n`);
        await symlink(outside, locator, 'dir');

        await assert.rejects(store.readInteraction(request.requestId), {
          code: 'invalid_record',
        });
        assert.deepEqual(await readdir(outside), ['request.json']);
        assert.equal(await readFile(externalRequest, 'utf8'), `${JSON.stringify(request)}\n`);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('does not follow a canonical request symlink during publication', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-request-document-'));
      const request = storedQuestion('request_document_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const externalRequest = join(outside, 'request.json');
      const externalContents = `${JSON.stringify(request)}\n`;
      try {
        await mkdir(locator);
        await writeFile(externalRequest, externalContents);
        await symlink(externalRequest, join(locator, 'request.json'));

        const result = await store.establishRequest(request);
        assert.equal(result.status, 'unresolved');
        if (result.status === 'unresolved') assert.equal(result.failure.code, 'invalid_record');
        assert.equal(await readFile(externalRequest, 'utf8'), externalContents);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('does not follow a canonical outcome symlink during publication', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-outcome-document-'));
      const request = storedQuestion('outcome_document_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const externalOutcome = join(outside, 'outcome.json');
      const outcome = questionOutcome('done', 200);
      const externalContents = `${JSON.stringify({ ...identity(request), outcome })}\n`;
      try {
        const established = await store.establishRequest(request);
        assert.equal(established.status, 'stable');
        await writeFile(externalOutcome, externalContents);
        await symlink(externalOutcome, join(locator, 'outcome.json'));

        const result = await store.commitOutcome(request.requestId, outcome);
        assert.equal(result.status, 'unresolved');
        if (result.status === 'unresolved') assert.equal(result.failure.code, 'invalid_record');
        assert.equal(await readFile(externalOutcome, 'utf8'), externalContents);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('recovery rejects a locator symlink without reading or cleaning the external directory', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStore(async ({ root, owner }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-interaction-locator-recovery-'));
      const request = storedQuestion('recovery_locator_symlink', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const externalRequest = join(outside, 'request.json');
      const externalTemp = join(outside, 'outcome.json.00000000-0000-4000-8000-000000000003.tmp');
      try {
        await writeFile(externalRequest, `${JSON.stringify(request)}\n`);
        await writeFile(externalTemp, 'must remain');
        await symlink(outside, locator, 'dir');
        await owner.close();

        const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
        const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
        assert.ok(recoveredOwner);
        if (!recoveredOwner) return;
        try {
          await assert.rejects(openInteractiveInteractionStoreForWrite(recoveredOwner.lease), {
            code: 'invalid_record',
          });
          assert.deepEqual((await readdir(outside)).sort(), [
            'outcome.json.00000000-0000-4000-8000-000000000003.tmp',
            'request.json',
          ]);
          assert.equal(await readFile(externalRequest, 'utf8'), `${JSON.stringify(request)}\n`);
          assert.equal(await readFile(externalTemp, 'utf8'), 'must remain');
        } finally {
          await recoveredOwner.close();
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('recovery rejects a non-directory with a canonical locator name', async () => {
    await withStore(async ({ root, owner }) => {
      const request = storedQuestion('recovery_locator_file', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      await writeFile(locator, 'not a directory');
      await owner.close();

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(recoveredOwner);
      if (!recoveredOwner) return;
      try {
        await assert.rejects(openInteractiveInteractionStoreForWrite(recoveredOwner.lease), {
          code: 'invalid_record',
        });
        assert.equal(await readFile(locator, 'utf8'), 'not a directory');
      } finally {
        await recoveredOwner.close();
      }
    });
  });

  test('rejects a malformed marker during outcome cleanup and recovery', async () => {
    await withStore(async ({ root, owner, store }) => {
      const request = storedQuestion('request_malformed_cleanup', 100);
      await store.establishRequest(request);
      const marker = join(
        root,
        'interactions',
        'pending',
        interactionLocator(request.sessionId),
        interactionLocator(request.requestId),
      );
      await writeFile(marker, 'not-empty');

      const committed = await store.commitOutcome(request.requestId, questionOutcome('done', 200));
      assert.equal(committed.status, 'unresolved');
      if (committed.status === 'unresolved') {
        assert.equal(committed.failure.code, 'invalid_record');
      }
      assert.equal(await readFile(marker, 'utf8'), 'not-empty');
      await owner.close();

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(recoveredOwner);
      if (!recoveredOwner) return;
      try {
        await assert.rejects(openInteractiveInteractionStoreForWrite(recoveredOwner.lease), {
          code: 'invalid_record',
        });
        assert.equal(await readFile(marker, 'utf8'), 'not-empty');
      } finally {
        await recoveredOwner.close();
      }
    });
  });

  test('fails a FIFO marker EEXIST retry without blocking', {
    skip: process.platform === 'win32',
    timeout: 3_000,
  }, async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_fifo_marker', 100);
      await store.establishRequest(request);
      const marker = join(
        root,
        'interactions',
        'pending',
        interactionLocator(request.sessionId),
        interactionLocator(request.requestId),
      );
      await unlink(marker);
      await execFileAsync('mkfifo', [marker]);

      const startedAt = Date.now();
      const retry = await store.establishRequest(request);
      assert.ok(Date.now() - startedAt < 1_000);
      assert.equal(retry.status, 'unresolved');
      if (retry.status === 'unresolved') {
        assert.equal(retry.failure.code, 'invalid_record');
      }
    });
  });

  test('recovery fails closed on a non-regular expected pending marker', async () => {
    await withStore(async ({ root, owner, store }) => {
      const pending = storedQuestion('request_non_regular_marker', 100);
      await store.establishRequest(pending);
      const marker = join(
        root,
        'interactions',
        'pending',
        interactionLocator(pending.sessionId),
        interactionLocator(pending.requestId),
      );
      await unlink(marker);
      await mkdir(marker);
      const retry = await store.establishRequest(pending);
      assert.equal(retry.status, 'unresolved');
      if (retry.status === 'unresolved') {
        assert.equal(retry.failure.code, 'invalid_record');
      }
      await owner.close();

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(recoveredOwner);
      if (!recoveredOwner) return;
      try {
        await assert.rejects(openInteractiveInteractionStoreForWrite(recoveredOwner.lease), {
          code: 'invalid_record',
        });
      } finally {
        await recoveredOwner.close();
      }
    });
  });

  test('reads back and stabilizes an outcome linked before an ambiguous failure', async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_torn', 100);
      await store.establishRequest(request);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const temporary = join(locator, 'outcome.json.00000000-0000-4000-8000-000000000000.tmp');
      const outcome = questionOutcome('durable', 200);
      await writeFile(temporary, `${JSON.stringify({ ...identity(request), outcome })}\n`);
      await link(temporary, join(locator, 'outcome.json'));

      const result = await store.commitOutcome(request.requestId, outcome);
      assert.equal(result.status, 'stable');
      if (result.status === 'stable') assert.equal(result.matches, true);
      await assert.rejects(readFile(temporary), { code: 'ENOENT' });
    });
  });

  test('serializes a same-locator read behind active publication and stabilization', async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_serialized_read', 100);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      const temporary = join(locator, 'request.json.00000000-0000-4000-8000-000000000002.tmp');
      await mkdir(locator, { recursive: true });
      await writeFile(temporary, 'interrupted publication');

      await assert.rejects(store.readInteraction(request.requestId), { code: 'invalid_record' });

      const publication = store.establishRequest(request);
      const concurrentRead = store.readInteraction(request.requestId);
      const [established, observed] = await Promise.all([publication, concurrentRead]);

      assert.equal(established.status, 'stable');
      if (established.status === 'stable') assert.equal(established.matches, true);
      assert.deepEqual(observed, { request });
      await assert.rejects(readFile(temporary), { code: 'ENOENT' });
    });
  });

  test('retains a same-locator reservation until its predecessor drains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-interaction-locator-lane-'));
    const firstDirectory = join(root, 'first');
    const otherDirectory = join(root, 'other');
    const temporary = join(firstDirectory, 'request.json.tmp');
    const canonical = join(firstDirectory, 'request.json');
    await mkdir(firstDirectory);
    await mkdir(otherDirectory);
    await writeFile(temporary, 'interrupted publication');

    const lane = new InteractionLocatorLane();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const thirdAuthorized = deferred<void>();
    let thirdEntered = false;
    const authorityFailure = new Error('authority failed');
    let first: Promise<void> | undefined;
    let third: Promise<string> | undefined;
    try {
      first = lane.run('same-locator', runInteractionStoreOperation, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        await unlink(temporary);
        await writeFile(canonical, 'stable');
      });
      await firstEntered.promise;

      const rejectAuthority = async <T>(_operation: () => Promise<T>): Promise<T> => {
        throw authorityFailure;
      };
      const failedAuthority = lane.run('same-locator', rejectAuthority, async () => {
        throw new Error('authority failure must not execute its operation');
      });
      await assert.rejects(failedAuthority, authorityFailure);

      third = lane.run(
        'same-locator',
        async (operation) => {
          thirdAuthorized.resolve();
          return operation();
        },
        async () => {
          thirdEntered = true;
          await assert.rejects(readFile(temporary), { code: 'ENOENT' });
          return readFile(canonical, 'utf8');
        },
      );
      await thirdAuthorized.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(thirdEntered, false);

      const other = await lane.run('other-locator', runInteractionStoreOperation, async () => {
        const path = join(otherDirectory, 'request.json');
        await writeFile(path, 'independent');
        return readFile(path, 'utf8');
      });
      assert.equal(other, 'independent');

      releaseFirst.resolve();
      await first;
      assert.equal(await third, 'stable');
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, third].filter((task) => task !== undefined));
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects dense and sparse documents beyond the stored byte limit', async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_oversized', 100);
      await store.establishRequest(request);
      const requestPath = join(
        root,
        'interactions',
        interactionLocator(request.requestId),
        'request.json',
      );

      await writeFile(requestPath, Buffer.alloc(STORED_INTERACTION_REQUEST_MAX_BYTES + 1));
      await assert.rejects(store.readInteraction(request.requestId), { code: 'invalid_record' });

      const sparse = await open(requestPath, 'w');
      try {
        await sparse.truncate(STORED_INTERACTION_REQUEST_MAX_BYTES + 1);
      } finally {
        await sparse.close();
      }
      await assert.rejects(store.readInteraction(request.requestId), { code: 'invalid_record' });
    });
  });

  test('rejects a stored outcome with fields outside the closed schema', async () => {
    await withStore(async ({ root, store }) => {
      const request = storedQuestion('request_invalid_outcome', 100);
      await store.establishRequest(request);
      const locator = join(root, 'interactions', interactionLocator(request.requestId));
      await writeFile(
        join(locator, 'outcome.json'),
        `${JSON.stringify({
          ...identity(request),
          outcome: questionOutcome('answer', 200),
          unexpected: true,
        })}\n`,
      );

      await assert.rejects(store.readInteraction(request.requestId), { code: 'invalid_record' });
    });
  });

  test('only persists canonical safe question projections', async () => {
    await withStore(async ({ store }) => {
      const unsafe: StoredInteractionRequest = {
        ...storedQuestion('request_unsafe_question', 100),
        request: {
          kind: 'question',
          toolUseId: 'tool_1',
          questions: [
            {
              question: 'password=store-secret\u202e',
              options: [{ label: 'First' }, { label: 'Second' }],
            },
          ],
        },
      };
      await assert.rejects(store.establishRequest(unsafe), { code: 'invalid_input' });
      assert.equal(await store.readInteraction(unsafe.requestId), undefined);

      const canonical: StoredInteractionRequest = {
        ...storedQuestion('request_safe_question', 101),
        request: projectInteractionQuestionRequest({
          toolUseId: 'tool_1',
          questions: [
            {
              question: 'password=store-secret\u202e',
              options: [{ label: 'First' }, { label: 'Second' }],
            },
          ],
        }),
      };
      const established = await store.establishRequest(canonical);
      assert.equal(established.status, 'stable');
      if (established.status === 'stable') assert.equal(established.matches, true);
      assert.deepEqual(await store.readInteraction(canonical.requestId), { request: canonical });
    });
  });
});

function storedQuestion(requestId: string, createdAt: number): StoredInteractionRequest {
  return {
    sessionId: 'session_1',
    turnId: 'turn_1',
    runId: 'run_1',
    requestId,
    createdAt,
    request: {
      kind: 'question',
      toolUseId: 'tool_1',
      questions: [
        {
          question: 'Choose',
          options: [
            { label: 'First', description: 'First' },
            { label: 'Second', description: 'Second' },
          ],
        },
      ],
    } as InteractionRequest,
  };
}

function questionOutcome(answer: string, committedAt: number): InteractionCanonicalOutcome {
  return {
    kind: 'question_answer',
    answers: [answer],
    committedAt,
  } as InteractionCanonicalOutcome;
}

function identity(request: StoredInteractionRequest) {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
  };
}

interface StoreContext {
  root: string;
  owner: InteractiveRootOwner;
  store: InteractiveInteractionStoreWriterFacade;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-store-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const [store, sameStore] = await Promise.all([
    openInteractiveInteractionStoreForWrite(owner.lease),
    openInteractiveInteractionStoreForWrite(owner.lease),
  ]);
  assert.strictEqual(store, sameStore);
  try {
    await run({ root, owner, store });
  } finally {
    if (!owner.closed) await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
