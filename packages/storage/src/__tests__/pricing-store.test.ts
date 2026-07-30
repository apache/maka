import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';
import {
  createPricingStore,
  PricingCommitUnknownError,
  PricingRevisionConflictError,
  PricingStorePublicationError,
  PricingValidationError,
} from '../pricing-store.js';

describe('PricingStore', () => {
  test('single-flights concurrent load and allows retry after failure', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'pricing.json');
      await writeFile(path, '{');
      const store = createPricingStore(root);

      const first = store.load();
      const concurrent = store.load();
      assert.equal(concurrent, first);
      await assert.rejects(() => first, SyntaxError);

      await writeFile(
        path,
        JSON.stringify({ version: 1, revision: 0, overrides: [] }, null, 2) + '\n',
      );
      await store.load();
      assert.deepEqual(store.snapshot(), { revision: 0, overrides: [] });
      await store.close();
    });
  });

  test('close joins a load started in the same tick', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);

      let loadSettled = false;
      const load = store.load().finally(() => {
        loadSettled = true;
      });
      await store.close();
      assert.equal(loadSettled, true);
      await load;

      assert.match(await readFile(join(root, 'pricing.json'), 'utf8'), /"version": 1/);
      assert.throws(() => store.snapshot(), /draining or closed/);
    });
  });

  test('serializes revision CAS so only one mutation at a revision commits', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();

      const results = await Promise.allSettled([
        store.upsert(0, pricing('openai:gpt-5')),
        store.upsert(0, pricing('anthropic:claude')),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert(rejected?.status === 'rejected');
      assert(rejected.reason instanceof PricingRevisionConflictError);
      assert.equal(rejected.reason.actualRevision, 1);
      assert.equal(store.snapshot().revision, 1);
      await store.close();
    });
  });

  test('rejects invalid values without advancing revision', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();

      assert.throws(
        () => store.upsert(0, { ...pricing('openai:gpt-5'), inputUsdPer1M: -1 }),
        PricingValidationError,
      );
      assert.equal(store.snapshot().revision, 0);
      await store.close();
    });
  });

  test('persists a stable revision document and reloads it', async () => {
    await withRoot(async (root) => {
      const first = createPricingStore(root);
      await first.load();
      await first.upsert(0, pricing('openai:gpt-5'));
      await first.close();

      const second = createPricingStore(root);
      await second.load();
      assert.deepEqual(second.snapshot(), {
        revision: 1,
        overrides: [pricing('openai:gpt-5')],
      });
      assert.match(await readFile(join(root, 'pricing.json'), 'utf8'), /"revision": 1/);
      await second.close();
    });
  });

  test('normalizes mutation input and uses canonical equality for no-op detection', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();
      const first = await store.upsert(0, {
        ...pricing(' openai:gpt-5 '),
        ignored: true,
      } as ReturnType<typeof pricing>);
      assert.equal(first.changed, true);

      const second = await store.upsert(1, pricing('openai:gpt-5'));
      assert.equal(second.changed, false);
      assert.equal(second.snapshot.revision, 1);
      assert.deepEqual(second.snapshot.overrides, [pricing('openai:gpt-5')]);
      assert.doesNotMatch(await readFile(join(root, 'pricing.json'), 'utf8'), /ignored/);
      await store.close();
    });
  });

  test('persists exact-distinct Unicode keys in shared comparator order across reopen', async () => {
    await withRoot(async (root) => {
      const composed = '\u00e9';
      const decomposed = 'e\u0301';
      const first = createPricingStore(root);
      await first.load();
      await first.upsert(0, pricing(composed));
      await first.upsert(1, pricing(decomposed));
      const snapshot = first.snapshot();
      assert.deepEqual(
        snapshot.overrides.map((item) => item.modelKey),
        [decomposed, composed],
      );
      await first.close();

      const before = await readFile(join(root, 'pricing.json'), 'utf8');
      assert.deepEqual(
        (JSON.parse(before) as { overrides: Array<{ modelKey: string }> }).overrides.map(
          (item) => item.modelKey,
        ),
        [decomposed, composed],
      );
      const second = createPricingStore(root);
      await second.load();
      assert.deepEqual(second.snapshot(), snapshot);
      await second.close();
      assert.equal(await readFile(join(root, 'pricing.json'), 'utf8'), before);
    });
  });

  test('rejects noncanonical and unsorted version 1 documents without rewriting them', async () => {
    await withRoot(async (root) => {
      const documents = [
        {
          version: 1,
          revision: 0,
          overrides: [{ ...pricing('openai:gpt-5'), unknown: true }],
        },
        {
          version: 1,
          revision: 0,
          overrides: [pricing(' openai:gpt-5 ')],
        },
        {
          version: 1,
          revision: 0,
          overrides: [pricing('z:model'), pricing('a:model')],
        },
      ];
      for (const document of documents) {
        const bytes = JSON.stringify(document, null, 2) + '\n';
        await writeFile(join(root, 'pricing.json'), bytes);
        const store = createPricingStore(root);
        await assert.rejects(() => store.load(), PricingValidationError);
        assert.equal(await readFile(join(root, 'pricing.json'), 'utf8'), bytes);
      }
    });
  });

  test('latches directory preparation failure across mutation, flush, and close', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();
      await rm(root, { recursive: true });
      await writeFile(root, 'not a directory');

      const failure = await store.upsert(0, pricing('openai:gpt-5')).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert(failure instanceof PricingStorePublicationError);
      await assert.rejects(
        () => store.flush(),
        (error) => error === failure,
      );
      await assert.rejects(
        () => store.close(),
        (error) => error === failure,
      );
    });
  });

  test('poisons reads after rename succeeds but directory sync fails', {
    skip: process.platform === 'win32',
  }, async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();
      const fault = new Error('injected pricing directory sync failure');
      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let injected = false;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          const metadata = await this.stat();
          if (!injected && metadata.isDirectory()) {
            injected = true;
            throw fault;
          }
          return originalSync.call(this);
        },
      );
      let failure: unknown;
      try {
        failure = await store.upsert(0, pricing('openai:gpt-5')).then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        syncMock.mock.restore();
      }

      assert(failure instanceof PricingCommitUnknownError);
      assert.match(await readFile(join(root, 'pricing.json'), 'utf8'), /"revision": 1/);
      assert.throws(
        () => store.snapshot(),
        (error) => error === failure,
      );
      await assert.rejects(
        () => store.flush(),
        (error) => error === failure,
      );
      await assert.rejects(
        () => store.close(),
        (error) => error === failure,
      );
    });
  });
});

function pricing(modelKey: string) {
  return { modelKey, inputUsdPer1M: 1.25, outputUsdPer1M: 10 };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pricing-store-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
