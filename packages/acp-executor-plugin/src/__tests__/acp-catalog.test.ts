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
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import { AdmissionLimiter } from '@maka/runtime/admission-limiter';
import { AcpCatalog, type AcpCatalogStore } from '../acp-catalog.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function entry(
  id: string,
  readiness: ExecutorCatalogEntry['readiness'] = 'ready',
): ExecutorCatalogEntry {
  return {
    id,
    displayName: id,
    readiness,
    models: [],
    supportsAttachments: false,
    supportsModelChange: false,
  };
}

const signal = () => new AbortController().signal;

test('the shared runtime budget covers cleanup and queues different executor instances', async () => {
  const admission = new AdmissionLimiter(2);
  const controls = ['a', 'b', 'c'].map((id) => {
    const started = deferred<void>();
    const result = deferred<ExecutorCatalogEntry>();
    const cleanup = deferred<void>();
    const cleaning = deferred<void>();
    const catalog = new AcpCatalog(
      admission,
      async () => {
        started.resolve();
        try {
          return await result.promise;
        } finally {
          cleaning.resolve();
          await cleanup.promise;
        }
      },
      () => entry(id, 'unavailable'),
    );
    return { id, started, result, cleaning, cleanup, catalog };
  });
  const pending = controls.map(({ catalog }) => catalog.get(signal()));
  try {
    await Promise.all(controls.slice(0, 2).map(({ started }) => started.promise));
    await setImmediate();
    assert.equal(admission.activeCount, 2);
    assert.equal(admission.waitingCount, 1);
    controls[0]!.result.resolve(entry('a'));
    await controls[0]!.cleaning.promise;
    assert.equal(admission.activeCount, 2, 'a terminating process still consumes capacity');
    assert.equal(admission.waitingCount, 1);
    controls[0]!.cleanup.resolve();
    await controls[2]!.started.promise;
    assert.equal(admission.activeCount, 2);
    assert.equal(admission.waitingCount, 0);
  } finally {
    for (const control of controls) {
      control.result.resolve(entry(control.id));
      control.cleanup.resolve();
    }
    assert.deepEqual(
      (await Promise.all(pending)).map((result) => result.readiness),
      ['ready', 'ready', 'ready'],
    );
    await Promise.all(controls.map(({ catalog }) => catalog.dispose()));
  }
  assert.equal(admission.activeCount, 0);
});

for (const shutdown of [false, true]) {
  test(`repeated refresh drains the old process before ${shutdown ? 'shutdown' : 'replacement'}`, async () => {
    const admission = new AdmissionLimiter(2);
    const started = deferred<void>();
    const cleaning = deferred<void>();
    const cleanup = deferred<void>();
    let probes = 0;
    const catalog = new AcpCatalog(
      admission,
      async (startup) => {
        probes++;
        if (probes > 1) return entry('fresh');
        started.resolve();
        try {
          await new Promise<void>((_resolve, reject) => {
            startup.addEventListener('abort', () => reject(startup.reason), { once: true });
          });
          return entry('stale');
        } finally {
          cleaning.resolve();
          await cleanup.promise;
        }
      },
      () => entry('unavailable', 'unavailable'),
    );
    const old = catalog.get(signal());
    try {
      await started.promise;
      const refresh = catalog.get(signal(), true);
      await cleaning.promise;
      const newer = catalog.get(signal(), true);
      await setImmediate();
      assert.equal(probes, 1, 'replacement must wait for the old process to close');
      assert.equal(admission.activeCount, 1);
      let disposed = false;
      const closing = shutdown
        ? catalog.dispose().then(() => {
            disposed = true;
          })
        : undefined;
      await setImmediate();
      assert.equal(disposed, false, 'shutdown must wait for superseded probe cleanup');
      cleanup.resolve();
      const results = await Promise.all([old, refresh, newer]);
      await closing;
      if (shutdown) {
        assert.equal(disposed, true);
        assert.equal(probes, 1, 'shutdown cannot start a queued replacement');
        assert.equal(admission.activeCount, 0);
        assert.ok(results.every((result) => result.readiness === 'unavailable'));
        return;
      }
      assert.equal(probes, 2, 'an invalidated queued refresh must never start a process');
      assert.equal(
        results.every((result) => result.id === 'fresh'),
        true,
      );
      assert.equal(await catalog.get(signal()), results[2]);
    } finally {
      cleanup.resolve();
      await catalog.dispose();
    }
  });
}

test('disposing a queued executor removes its admission without starting a probe', async () => {
  const admission = new AdmissionLimiter(1);
  const permit = await admission.acquire(signal());
  let probes = 0;
  const catalog = new AcpCatalog(
    admission,
    async () => {
      probes++;
      return entry('queued');
    },
    () => entry('queued', 'unavailable'),
  );
  try {
    const pending = catalog.get(signal());
    await setImmediate();
    assert.equal(admission.waitingCount, 1);
    await catalog.dispose();
    assert.equal((await pending).readiness, 'unavailable');
    assert.equal(admission.waitingCount, 0);
    assert.equal(probes, 0);
  } finally {
    permit.release();
    await catalog.dispose();
  }
});

test('late results from an invalidated probe never re-enter the cache', async () => {
  const started = deferred<void>();
  const result = deferred<ExecutorCatalogEntry>();
  let probes = 0;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => {
      probes++;
      if (probes > 1) return entry('new-account');
      started.resolve();
      return await result.promise;
    },
    () => entry('agent', 'unavailable'),
  );
  try {
    const pending = [catalog.get(signal()), catalog.get(signal())];
    await started.promise;
    catalog.invalidate();
    result.resolve(entry('old-account'));
    const results = await Promise.all(pending);
    assert.equal(results[0]!.id, 'new-account');
    assert.equal(results[0], results[1], 'old waiters share one replacement without a new query');
    assert.equal((await catalog.get(signal())).id, 'new-account');
    assert.equal(probes, 2);
  } finally {
    result.resolve(entry('old-account'));
    await catalog.dispose();
  }
});

test('genuine unavailable and authentication failures never automatically retry', async () => {
  for (const readiness of ['unavailable', 'authentication_required'] as const) {
    let probes = 0;
    const catalog = new AcpCatalog(
      new AdmissionLimiter(1),
      async () => {
        probes++;
        return entry('failed', readiness);
      },
      () => entry('failed', 'unavailable'),
    );
    try {
      assert.equal((await catalog.get(signal())).readiness, readiness);
      assert.equal(probes, 1);
    } finally {
      await catalog.dispose();
    }
  }
});

test('caller cancellation and disposal do not restart an invalidated probe', async () => {
  for (const cancel of [true, false]) {
    const started = deferred<void>();
    const result = deferred<ExecutorCatalogEntry>();
    let probes = 0;
    const catalog = new AcpCatalog(
      new AdmissionLimiter(1),
      async () => {
        probes++;
        started.resolve();
        return await result.promise;
      },
      () => entry('agent', 'unavailable'),
    );
    const controller = new AbortController();
    const pending = catalog.get(controller.signal);
    const checked = cancel
      ? assert.rejects(pending, /stop waiting/)
      : pending.then((value) => assert.equal(value.readiness, 'unavailable'));
    await started.promise;
    catalog.invalidate();
    if (cancel) controller.abort(new Error('stop waiting'));
    const disposal = catalog.dispose();
    result.resolve(entry('stale'));
    await checked;
    await disposal;
    assert.equal(probes, 1);
  }
});

test('repeated invalidations without refresh drain and join the latest revision', async () => {
  const started = [deferred<void>(), deferred<void>()];
  const results = [deferred<ExecutorCatalogEntry>(), deferred<ExecutorCatalogEntry>()];
  let probes = 0;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => {
      const index = probes++;
      if (index === 2) return entry('latest');
      started[index]!.resolve();
      return await results[index]!.promise;
    },
    () => entry('agent', 'unavailable'),
  );
  const waiting = [catalog.get(signal()), catalog.get(signal())];
  try {
    await started[0]!.promise;
    catalog.invalidate();
    results[0]!.resolve(entry('stale-1'));
    await started[1]!.promise;
    catalog.invalidate();
    results[1]!.resolve(entry('stale-2'));
    assert.deepEqual(
      (await Promise.all(waiting)).map((value) => value.id),
      ['latest', 'latest'],
    );
    assert.equal(probes, 3);
  } finally {
    for (const result of results) result.resolve(entry('cleanup'));
    await catalog.dispose();
  }
});

test('ready catalog survives idle time until explicit refresh or invalidation', async () => {
  let calls = 0;
  let now = 100000;
  const original = Date.now;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => {
      calls++;
      return entry('ready');
    },
    () => entry('unavailable', 'unavailable'),
  );
  try {
    Date.now = () => now;
    await catalog.get(signal());
    await catalog.get(signal());
    assert.equal(calls, 1);
    now += 24 * 60 * 60 * 1000;
    await catalog.get(signal());
    assert.equal(calls, 1, 'opening another draft after a day does not start a probe');
    await catalog.get(signal(), true);
    assert.equal(calls, 2);
    catalog.invalidate();
    await catalog.get(signal());
    assert.equal(calls, 3);
  } finally {
    Date.now = original;
    await catalog.dispose();
  }
});

function catalogModels(id: string): ExecutorCatalogEntry {
  return {
    ...entry('agent'),
    models: [{ id, name: id }],
    currentModel: id,
    modes: [{ id: 'neutral-mode', name: 'Neutral mode' }],
    currentMode: 'neutral-mode',
    supportsModelChange: true,
    supportsModeChange: true,
  };
}

test('shutdown flushes neutral candidates and restart uses them without a probe', async () => {
  let saved: ExecutorCatalogEntry | undefined;
  let writes = 0;
  let probes = 0;
  const store: AcpCatalogStore = {
    load: async () => saved,
    save: async (entry) => {
      saved = entry;
      writes++;
    },
  };
  const make = () =>
    new AcpCatalog(
      new AdmissionLimiter(1),
      async () => {
        probes++;
        return catalogModels('probe');
      },
      () => entry('unavailable', 'unavailable'),
      undefined,
      store,
    );
  const first = make();
  await first.get(signal());
  await first.get(signal(), true);
  await first.dispose();
  const discoveryWrites = writes;
  const restarted = make();
  try {
    assert.deepEqual(await restarted.get(signal()), catalogModels('probe'));
    assert.equal(writes, discoveryWrites, 'cached reads do not rewrite the disk snapshot');
    assert.equal(probes, 2, 'restart reads the persisted snapshot');
    await restarted.get(signal(), true);
    assert.equal(probes, 3, 'manual refresh bypasses both cache layers');
  } finally {
    await restarted.dispose();
  }
  assert.deepEqual(saved, catalogModels('probe'));
});

for (const action of ['invalidate', 'dispose'] as const) {
  test(`late disk reads cannot override ${action}`, async () => {
    const started = deferred<void>();
    const read = deferred<ExecutorCatalogEntry>();
    let saved: ExecutorCatalogEntry | undefined = catalogModels('stale-disk');
    let probes = 0;
    const catalog = new AcpCatalog(
      new AdmissionLimiter(1),
      async () => {
        probes++;
        return catalogModels('fresh-probe');
      },
      () => entry('unavailable', 'unavailable'),
      undefined,
      {
        load: async () => {
          started.resolve();
          return read.promise;
        },
        save: async (entry) => {
          saved = entry;
        },
      },
    );
    const waiting = catalog.get(signal());
    try {
      await started.promise;
      if (action === 'invalidate') catalog.invalidate();
      const closing = action === 'dispose' ? catalog.dispose() : undefined;
      read.resolve(catalogModels('stale-disk'));
      const result = await waiting;
      await closing;
      if (action === 'invalidate') {
        assert.deepEqual(result, catalogModels('fresh-probe'));
        assert.equal(probes, 1);
      } else {
        assert.equal(result.readiness, 'unavailable');
        assert.equal(probes, 0);
      }
      await catalog.dispose();
      assert.deepEqual(
        saved,
        catalogModels(action === 'invalidate' ? 'fresh-probe' : 'stale-disk'),
      );
    } finally {
      read.resolve(catalogModels('cleanup'));
      await catalog.dispose();
    }
  });
}

test('invalidation deletes the disk cache after an already-running write settles', async () => {
  const started = deferred<void>();
  const writing = deferred<void>();
  let saved: ExecutorCatalogEntry | undefined;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => catalogModels('probe'),
    () => entry('unavailable', 'unavailable'),
    undefined,
    {
      load: async () => saved,
      save: async (entry) => {
        if (entry) {
          started.resolve();
          await writing.promise;
        }
        saved = entry;
      },
    },
  );
  await catalog.get(signal());
  await started.promise;
  catalog.invalidate();
  const disposal = catalog.dispose();
  writing.resolve();
  await disposal;
  assert.equal(saved, undefined, 'a late write cannot resurrect an invalidated account catalog');
});

test('cache read and write failures do not prevent discovery or refresh', async () => {
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => catalogModels('probe'),
    () => entry('unavailable', 'unavailable'),
    undefined,
    {
      load: async () => {
        throw new Error('unreadable');
      },
      save: async () => {
        throw new Error('read-only');
      },
    },
  );
  try {
    assert.equal((await catalog.get(signal())).models[0]?.id, 'probe');
    assert.equal((await catalog.get(signal(), true)).models[0]?.id, 'probe');
  } finally {
    await catalog.dispose();
  }
});

test('failed refresh retains memory and disk choices while concurrent reads stay available', async () => {
  const started = deferred<void>();
  const result = deferred<ExecutorCatalogEntry>();
  let saved: ExecutorCatalogEntry | undefined = catalogModels('saved');
  let probes = 0;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => {
      probes++;
      started.resolve();
      return probes === 1 ? result.promise : catalogModels('refreshed');
    },
    () => entry('agent', 'unavailable'),
    undefined,
    {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
  );
  try {
    const refresh = catalog.get(signal(), true);
    await started.promise;
    assert.equal((await catalog.get(signal())).models[0]?.id, 'saved');
    result.resolve(entry('agent', 'unavailable'));
    const failed = await refresh;
    assert.equal(failed.readiness, 'ready');
    assert.equal(failed.models[0]?.id, 'saved');
    assert.equal(failed.refreshFailed, true);
    assert.equal((await catalog.get(signal())).refreshFailed, true);
    assert.equal(probes, 1);
    assert.equal(
      saved?.refreshFailed,
      undefined,
      'failure state is not persisted over a successful snapshot',
    );
    assert.equal((await catalog.get(signal(), true)).refreshFailed, undefined);
  } finally {
    result.resolve(entry('agent', 'unavailable'));
    await catalog.dispose();
  }
  assert.equal(saved?.models[0]?.id, 'refreshed');
});

test('cold failures cool down automatic reads but manual retry and invalidation bypass the delay', async () => {
  const original = Date.now;
  let now = 0;
  let probes = 0;
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => {
      probes++;
      return entry('agent', 'unavailable');
    },
    () => entry('agent', 'unavailable'),
  );
  try {
    Date.now = () => now;
    await catalog.get(signal());
    now = 59_999;
    await catalog.get(signal());
    assert.equal(probes, 1);
    now = 60_000;
    await Promise.all([catalog.get(signal()), catalog.get(signal())]);
    assert.equal(probes, 2, 'concurrent retries share one probe after the cooldown');
    await catalog.get(signal(), true);
    assert.equal(probes, 3);
    catalog.invalidate();
    await catalog.get(signal());
    assert.equal(probes, 4);
  } finally {
    Date.now = original;
    await catalog.dispose();
  }
});

test('authentication failure discards persisted choices', async () => {
  let saved: ExecutorCatalogEntry | undefined = catalogModels('old-account');
  const catalog = new AcpCatalog(
    new AdmissionLimiter(1),
    async () => entry('agent', 'authentication_required'),
    () => entry('agent', 'unavailable'),
    undefined,
    {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
  );
  assert.equal((await catalog.get(signal(), true)).readiness, 'authentication_required');
  assert.equal((await catalog.get(signal())).readiness, 'authentication_required');
  await catalog.dispose();
  assert.equal(saved, undefined);
});
