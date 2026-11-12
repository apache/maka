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

// Startup profile for the execution Runtime Host composition.
//
// Seeds a usage-shaped fixture (Sessions × Turns × artifacts), then reopens
// the composition several times, timing each restart's anchors separately:
//
//   open        construct the execution composition (storage roots, stores)
//   recover     the five-phase domain-module recovery
//   firstQuery  the first `session.catalog.query` after recovery
//   close       orderly composition shutdown
//
// Usage (from packages/runtime-host, after a workspace build):
//   node scripts/startup-profile.mjs
//   SESSIONS=300 TURNS=3 ARTIFACTS=4 ROUNDS=5 node scripts/startup-profile.mjs

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { SessionManager } from '@maka/runtime/session-manager';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createExecutionRuntimeHostComposition } from '../dist/server/execution-composition.js';

const SESSIONS = Number(process.env.SESSIONS ?? 30);
const TURNS = Number(process.env.TURNS ?? 3);
const ARTIFACTS = Number(process.env.ARTIFACTS ?? 2);
const ARTIFACT_BYTES = Number(process.env.ARTIFACT_BYTES ?? 2048);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const CONNECTION_ID = randomUUID();
const operationContext = {
  hostEpoch: 'startup-profile',
  connectionId: 'startup-profile-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const root = await mkdtemp(join(tmpdir(), 'maka-startup-profile-'));
const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner) throw new Error(`Could not acquire profile storage root: ${root}`);

console.log(
  `fixture target: ${SESSIONS} sessions × ${TURNS} turns × ` +
    `${ARTIFACTS} artifacts(${ARTIFACT_BYTES}B), ${ROUNDS} restart rounds`,
);

// ── Seed pass ────────────────────────────────────────────────────────────────
const seedOpenStart = performance.now();
let seedComposition;
try {
  const seedOriginalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
  let seedManager;
  SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
    seedManager = this;
    return seedOriginalRecover.call(this, stores);
  };

  seedComposition = await createExecutionRuntimeHostComposition(
    {
      owner,
      hostEpoch: operationContext.hostEpoch,
      acquireResidency: () => ({ release() {} }),
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    },
    {},
    { primaryBackendFactory: (context) => new FakeBackend(context) },
  );
  await seedComposition.recover();
  SessionManager.prototype.recoverInterruptedSessionsStrict = seedOriginalRecover;
  if (!seedManager) throw new Error('Seed composition did not construct a SessionManager');
  await configureDefaultModel(seedComposition.handlers);

  const artifactBytes = Buffer.from(
    randomUUID()
      .repeat(Math.ceil(ARTIFACT_BYTES / 36))
      .slice(0, ARTIFACT_BYTES),
    'utf8',
  );
  const artifactSha = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;

  for (let sessionIndex = 0; sessionIndex < SESSIONS; sessionIndex += 1) {
    const sessionStart = performance.now();
    let turnsMs = 0;
    let artifactsMs = 0;
    const created = await seedComposition.handlers['session.create'](
      {
        sessionId: randomUUID(),
        workspace: { kind: 'host_path', path: root },
        name: `startup-profile-${sessionIndex}`,
        modelTarget: { kind: 'default' },
      },
      operationContext,
    );
    if (!created.ok) throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);
    const sessionId = created.result.id;

    for (let turnIndex = 0; turnIndex < TURNS; turnIndex += 1) {
      const turnStart = performance.now();
      const turnId = `turn-${sessionIndex}-${turnIndex}`;
      const started = await seedComposition.handlers['turn.start'](
        {
          sessionId,
          turnId,
          // FakeBackend paces non-steering responses as 9-char chunks with a
          // 45ms typing sleep per chunk, so a long seed turn spends seconds in
          // that simulation instead of the anchors this profile measures. A
          // ~25-char turn still streams a few deltas on the same durable path.
          content: { text: `startup profile turn ${sessionIndex}/${turnIndex}` },
        },
        operationContext,
      );
      if (!started.ok) throw new Error(`turn.start failed: ${JSON.stringify(started.error)}`);
      await waitForCompletedTurn(seedManager, sessionId, turnId);
      turnsMs += performance.now() - turnStart;
    }

    for (let artifactIndex = 0; artifactIndex < ARTIFACTS; artifactIndex += 1) {
      const artifactStart = performance.now();
      const uploadId = randomUUID();
      const ingest = async (input) => {
        const outcome = await seedComposition.handlers['artifact.ingest'](input, operationContext);
        if (!outcome.ok) {
          throw new Error(`artifact.ingest ${input.kind} failed: ${JSON.stringify(outcome.error)}`);
        }
        if (process.env.PROFILE_DEBUG) console.log(input.kind, JSON.stringify(outcome.result));
        return outcome.result;
      };
      await ingest({
        kind: 'begin',
        sessionId,
        uploadId,
        name: `profile-${sessionIndex}-${artifactIndex}.bin`,
        mimeType: 'application/octet-stream',
        totalBytes: ARTIFACT_BYTES,
        contentSha256: artifactSha,
      });
      // The wire limits each chunk's base64 payload; walk offsets from the
      // accepted nextOffset instead of assuming one chunk fits.
      let offset = 0;
      const chunkBytes = 1536;
      while (offset < ARTIFACT_BYTES) {
        const slice = artifactBytes.subarray(offset, offset + chunkBytes);
        const accepted = await ingest({
          kind: 'chunk',
          sessionId,
          uploadId,
          offset,
          chunkBase64: slice.toString('base64'),
        });
        offset = accepted.nextOffset;
      }
      await ingest({ kind: 'commit', sessionId, uploadId });
      artifactsMs += performance.now() - artifactStart;
    }
    if (process.env.PROFILE_DEBUG) {
      console.log(
        `session ${sessionIndex}: total=${((performance.now() - sessionStart) / 1000).toFixed(2)}s ` +
          `turns=${(turnsMs / 1000).toFixed(2)}s artifacts=${(artifactsMs / 1000).toFixed(2)}s ` +
          `other=${((performance.now() - sessionStart - turnsMs - artifactsMs) / 1000).toFixed(2)}s`,
      );
    }
  }

  const seeded = await seedManager.listSessions();
  console.log(
    `seed done in ${((performance.now() - seedOpenStart) / 1000).toFixed(1)}s: ` +
      `${seeded.length} sessions on disk`,
  );
} finally {
  await seedComposition?.close?.();
}

async function configureDefaultModel(handlers) {
  const call = async (operation, input) => {
    const outcome = await handlers[operation](input, operationContext);
    if (!outcome.ok) throw new Error(`${operation} failed: ${JSON.stringify(outcome.error)}`);
    return outcome.result;
  };
  const catalog = await call('connection.catalog.query', { kind: 'start' });
  const created = await call('connection.catalog.create', {
    expectedCatalogRevision: catalog.revision,
    connection: {
      slug: 'startup-profile',
      name: 'Startup profile',
      providerType: 'custom',
      defaultApiProtocol: 'openai-chat',
      baseUrl: 'https://startup-profile.invalid/v1',
      enabled: true,
      enabledModelIds: ['profile-test-model'],
    },
  });
  if (created.kind !== 'committed') throw new Error('Profile connection must commit');
  await call('credential.vault.set', {
    locator: {
      scope: 'connection',
      connectionId: created.connection.connectionId,
      kind: 'api_key',
    },
    expected: null,
    secret: 'startup-profile-key',
  });
  await call('connection.catalog.set-default-target', {
    expectedCatalogRevision: created.catalogRevision,
    target: { connectionId: created.connection.connectionId, modelId: 'profile-test-model' },
  });
}

// ── Restart rounds ───────────────────────────────────────────────────────────
const rounds = [];
for (let round = 0; round < ROUNDS; round += 1) {
  rounds.push(await restartRound(round));
}
console.table(
  rounds.map((round) => ({
    round: round.round,
    openMs: round.openMs.toFixed(0),
    recoverMs: round.recoverMs.toFixed(0),
    firstQueryMs: round.firstQueryMs.toFixed(1),
    closeMs: round.closeMs.toFixed(0),
    totalMs: round.totalMs.toFixed(0),
  })),
);
const med = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
  `median: open=${med(rounds.map((r) => r.openMs)).toFixed(0)}ms ` +
    `recover=${med(rounds.map((r) => r.recoverMs)).toFixed(0)}ms ` +
    `firstQuery=${med(rounds.map((r) => r.firstQueryMs)).toFixed(1)}ms ` +
    `close=${med(rounds.map((r) => r.closeMs)).toFixed(0)}ms ` +
    `total=${med(rounds.map((r) => r.totalMs)).toFixed(0)}ms`,
);
const rootInfo = await stat(root);
console.log(`storage root: ${root} (${(rootInfo.size / 1024).toFixed(1)} KiB top-level)`);
await rm(root, { recursive: true, force: true });

async function restartRound(round) {
  const openStart = performance.now();
  const composition = await createExecutionRuntimeHostComposition(
    {
      owner,
      hostEpoch: `${operationContext.hostEpoch}-${round}`,
      acquireResidency: () => ({ release() {} }),
      retainUntilProcessExit: () => undefined,
      requestDrain: () => undefined,
    },
    {},
    { primaryBackendFactory: (context) => new FakeBackend(context) },
  );
  const openMs = performance.now() - openStart;

  const recoverStart = performance.now();
  await composition.recover();
  const recoverMs = performance.now() - recoverStart;

  const queryStart = performance.now();
  const listed = await composition.handlers['session.catalog.query'](
    { kind: 'list_start' },
    operationContext,
  );
  const firstQueryMs = performance.now() - queryStart;
  if (!listed.ok) throw new Error(`catalog query failed: ${JSON.stringify(listed.error)}`);

  const closeStart = performance.now();
  await composition.close?.();
  const closeMs = performance.now() - closeStart;

  return {
    round,
    openMs,
    recoverMs,
    firstQueryMs,
    closeMs,
    totalMs: performance.now() - openStart,
  };
}

async function waitForCompletedTurn(manager, sessionId, turnId) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const messages = await manager.getMessages(sessionId);
    const state = messages.findLast(
      (message) => message.type === 'turn_state' && message.turnId === turnId,
    );
    if (state?.status === 'completed') return;
    if (state?.status === 'failed' || state?.status === 'aborted') {
      throw new Error(`Profile turn ${turnId} ended as ${state.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for profile turn ${turnId}`);
}
