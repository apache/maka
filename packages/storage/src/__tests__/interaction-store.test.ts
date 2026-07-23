import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core';
import {
  interactionLocator,
  openInteractiveInteractionStoreForWrite,
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';

describe('Interaction Store', () => {
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
      await store.commitOutcome(second.requestId, questionOutcome('done', 300));
      assert.deepEqual(await store.listPending(), [first]);
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
