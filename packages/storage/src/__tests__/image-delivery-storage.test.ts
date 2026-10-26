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
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import { assertImageArchiveQuota, ImageArchiveQuotaError } from '../artifact-image-storage.js';
import { DEFAULT_IMAGE_ARCHIVE_LIMITS } from '@maka/core/image-delivery';
import { readImageDeliveryAttempt } from '../sqlite-image-delivery.js';

const identity = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  messageId: 'message-1',
  source: '/tmp/image.png',
};
const lookup = (
  store: ReturnType<typeof createSqliteArtifactStoreWriteAuthority>['store'],
  i = identity,
) => store.findImageDelivery(i.sessionId, i.turnId, i.messageId, i.source);

test('schema 3 upgrades directly to 5 without rewriting existing artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-schema-'));
  let authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    const record = await authority.store.create({
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      id: 'existing-file',
      name: 'note.txt',
      kind: 'file',
      source: 'tool_result',
      content: 'retained',
    });
    authority.close();
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      db.exec(`DROP TABLE image_delivery_jobs; DROP TABLE image_delivery_attempts; DROP INDEX artifact_image_delivery_lookup;
        UPDATE operational_schema_migrations SET version = 3 WHERE scope = 'artifact';`);
    } finally {
      db.close();
    }
    authority = createSqliteArtifactStoreWriteAuthority(root);
    assert.deepEqual(await authority.store.listTurnArtifacts(identity.sessionId, identity.turnId), [
      record,
    ]);
    const text = await authority.store.readTextInSession(identity.sessionId, record.id);
    assert.ok(text.ok);
    if (text.ok) assert.equal(text.text, 'retained');
    const reopened = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(
        reopened
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'artifact'")
          .get()?.version,
        5,
      );
      assert.equal(
        reopened.prepare('SELECT COUNT(*) AS n FROM image_delivery_attempts').get()?.n,
        0,
      );
    } finally {
      reopened.close();
    }
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('attempts survive reopen, stay out of conversation copies, and purge without an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-attempt-'));
  let authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    await authority.store.setImageDeliveryAttempt(identity, {
      status: 'failed',
      reason: 'not_found',
    });
    assert.equal(
      (await authority.store.listPage(identity.sessionId, { offset: 0, limit: 10 })).total,
      0,
    );
    assert.deepEqual(
      await authority.store.listTurnArtifacts(identity.sessionId, identity.turnId),
      [],
    );
    authority.close();
    authority = createSqliteArtifactStoreWriteAuthority(root);
    assert.deepEqual(await lookup(authority.store), { status: 'failed', reason: 'not_found' });
    await authority.store.copyConversationArtifacts({
      sourceSessionId: identity.sessionId,
      targetSessionId: 'session-2',
      turnIds: [identity.turnId],
    });
    const copied = { ...identity, sessionId: 'session-2' };
    assert.equal(await lookup(authority.store, copied), undefined);
    await authority.store.purgeSessionArtifacts(identity.sessionId);
    assert.equal(await lookup(authority.store), undefined);
    assert.equal(await lookup(authority.store, copied), undefined);
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('successful publication atomically supersedes attempts and cannot be downgraded by retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-publish-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    await authority.store.setImageDeliveryAttempt(identity, { status: 'pending' });
    const content = new Uint8Array([1, 2, 3]);
    const record = await authority.store.create({
      ...identity,
      id: 'image-result',
      name: 'image',
      source: 'tool_result_projection',
      kind: 'image',
      content,
      imageDelivery: {
        messageId: identity.messageId,
        source: identity.source,
        status: 'ready',
        contentSha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    await authority.store.setImageDeliveryAttempt(identity, {
      status: 'failed',
      reason: 'read_failed',
    });
    assert.deepEqual(await lookup(authority.store), { status: 'ready', artifactId: record.id });
    const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(readImageDeliveryAttempt(db, identity), undefined);
    } finally {
      db.close();
    }
    await assert.rejects(
      authority.store.create({
        ...identity,
        id: 'empty-placeholder',
        name: 'image',
        kind: 'file',
        source: 'tool_result_projection',
        content: '',
        imageDelivery: {
          messageId: identity.messageId,
          source: identity.source,
          status: 'pending',
        } as never,
      }),
      /Invalid image delivery metadata/,
    );
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('archive policy enforces defaults even when a caller omits its limits', () => {
  const existing = {
    id: 'existing',
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    name: 'image',
    kind: 'image' as const,
    source: 'tool_result_projection' as const,
    createdAt: 1,
    relativePath: 'session-1/existing-image',
    sizeBytes: DEFAULT_IMAGE_ARCHIVE_LIMITS.sessionBytes,
    imageDelivery: {
      messageId: identity.messageId,
      source: identity.source,
      status: 'ready' as const,
      contentSha256: 'a'.repeat(64),
    },
  };
  assert.throws(
    () =>
      assertImageArchiveQuota([existing], {
        sessionId: identity.sessionId,
        sizeBytes: 1,
        imageDelivery: { ...existing.imageDelivery, contentSha256: 'b'.repeat(64) },
      }),
    ImageArchiveQuotaError,
  );
  assert.doesNotThrow(() =>
    assertImageArchiveQuota([existing], {
      sessionId: identity.sessionId,
      sizeBytes: existing.sizeBytes,
      imageDelivery: existing.imageDelivery,
    }),
  );
});

test('received bytes survive reopening, stay immutable, and retire atomically on publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-spool-'));
  let authority = createSqliteArtifactStoreWriteAuthority(root);
  const bytes = new Uint8Array([1, 2, 3]);
  const job = {
    ...identity,
    id: 'durable-reception',
    loadRemote: false,
    attempts: 1,
    nextAttemptAt: 0,
  };
  try {
    await authority.store.putImageDeliveryJob({ job, bytes });
    authority.close();
    authority = createSqliteArtifactStoreWriteAuthority(root);
    const staged = await authority.store.readImageDeliveryJob(job.id);
    assert.deepEqual(staged?.job, job);
    assert.deepEqual(staged?.bytes, bytes);
    await assert.rejects(
      authority.store.putImageDeliveryJob({ job, bytes: new Uint8Array([9]) }),
      /immutable/,
    );
    await authority.store.create({
      ...identity,
      id: job.id,
      name: 'image',
      kind: 'image',
      source: 'tool_result_projection',
      content: bytes,
      imageDelivery: {
        messageId: identity.messageId,
        source: identity.source,
        status: 'ready',
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    assert.equal(await authority.store.readImageDeliveryJob(job.id), undefined);
    assert.equal((await lookup(authority.store))?.status, 'ready');
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting a Session also deletes pending and failed reception bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-purge-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    for (const failure of [undefined, 'quota_exceeded'] as const) {
      await authority.store.putImageDeliveryJob({
        job: {
          ...identity,
          id: failure ?? 'pending-image',
          loadRemote: false,
          attempts: 1,
          nextAttemptAt: 0,
          ...(failure ? { failure } : {}),
        },
        bytes: new Uint8Array([1]),
      });
    }
    await authority.store.purgeSessionArtifacts(identity.sessionId);
    assert.equal(await authority.store.readImageDeliveryJob('pending-image'), undefined);
    assert.equal(await authority.store.readImageDeliveryJob('quota_exceeded'), undefined);
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a process killed after spool commit leaves complete recoverable bytes', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'maka-image-killed-'));
  const job = { ...identity, id: 'crash-image', loadRemote: false, attempts: 1, nextAttemptAt: 0 };
  try {
    const script = `import { createSqliteArtifactStoreWriteAuthority } from ${JSON.stringify(new URL('../artifact-store.js', import.meta.url).href)};
      const owner = createSqliteArtifactStoreWriteAuthority(process.argv[1]);
      await owner.store.putImageDeliveryJob({ job: JSON.parse(process.argv[2]), bytes: new Uint8Array([4, 5, 6]) });
      process.kill(process.pid, 'SIGKILL');`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, root, JSON.stringify(job)],
      { timeout: 10000, encoding: 'utf8' },
    );
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const authority = createSqliteArtifactStoreWriteAuthority(root);
    try {
      const received = await authority.store.readImageDeliveryJob(job.id);
      assert.deepEqual(received?.job, job);
      assert.deepEqual(received?.bytes, new Uint8Array([4, 5, 6]));
    } finally {
      authority.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('permanent reception failures do not consume the workspace queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-failures-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    for (let i = 0; i < 520; i++) {
      await authority.store.putImageDeliveryJob({
        job: {
          ...identity,
          source: `/missing-${i}.png`,
          id: `failed-${i}`,
          loadRemote: false,
          attempts: 1,
          nextAttemptAt: 0,
          failure: 'not_found',
        },
      });
    }
    const job = { ...identity, id: 'healthy', loadRemote: false, attempts: 1, nextAttemptAt: 0 };
    await authority.store.putImageDeliveryJob({ job, bytes: new Uint8Array([1]) });
    assert.equal((await authority.store.listImageDeliveryJobs(Date.now())).length, 1);
    assert.equal((await authority.store.readImageDeliveryJob('healthy'))?.bytes?.length, 1);
    assert.equal(await authority.store.readImageDeliveryJob('failed-0'), undefined);
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('quota-failed spools yield capacity to healthy work without erasing failure metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-quota-spool-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    for (let i = 0; i < 4; i++)
      await authority.store.putImageDeliveryJob({
        job: {
          ...identity,
          source: `/quota-${i}.png`,
          id: `quota-${i}`,
          loadRemote: false,
          attempts: 1,
          nextAttemptAt: 0,
          failure: 'quota_exceeded',
        },
        bytes: new Uint8Array(8 * 1024 * 1024),
      });
    await authority.store.putImageDeliveryJob({
      job: { ...identity, id: 'healthy', loadRemote: false, attempts: 1, nextAttemptAt: 0 },
      bytes: new Uint8Array(8 * 1024 * 1024),
    });
    assert.equal(await authority.store.readImageDeliveryJob('quota-0'), undefined);
    assert.deepEqual(
      await authority.store.findImageDelivery(
        identity.sessionId,
        identity.turnId,
        identity.messageId,
        '/quota-0.png',
      ),
      { status: 'failed', reason: 'quota_exceeded' },
    );
    assert.equal(
      (await authority.store.readImageDeliveryJob('healthy'))?.bytes?.byteLength,
      8 * 1024 * 1024,
    );
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});
