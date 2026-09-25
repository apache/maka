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
import { readRuntimeHostModelProviders } from '../../packages/runtime-host/src/client/catalog-reader.ts';
import { authenticateModelConnection } from './client-model-connection.mjs';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeSessionTurnContributions } from '../../packages/runtime-host/src/protocol/session-turns.ts';
import { modelFixture, verifyTurns } from './client-turn.mjs';
import { watchSession } from './client-subscription.mjs';
import { verifyMetadata, persistReadMarker } from './client-metadata.mjs';
import { verifyConfiguration, verifyArchivedConfiguration } from './client-configuration.mjs';
import { verifyWorkspace, verifyBlockedWorkspace, persistWorkspace } from './client-workspace.mjs';

export async function verifySessionWorkflow(connection, workspace, reopened, connectSibling) {
  const request = (operation, input) => connection.request(operation, input, 3000);
  const create = {
    sessionId: 'rust-interop-session',
    workspace: { kind: 'host_path', path: workspace },
    modelTarget: { kind: 'default' },
    name: 'Rust  会话',
    sandboxMode: 'workspace-write',
  };
  const pluginSessionId = 'unavailable-executor-session';
  await assert.rejects(
    request('session.create', {
      sessionId: pluginSessionId,
      workspace: create.workspace,
      executorId: 'fixture.Executor:v1',
    }),
    (error) => error.code === 'operation_unavailable',
  );
  assert.deepEqual(
    await request('session.catalog.query', { kind: 'get', sessionId: pluginSessionId }),
    { kind: 'session', session: null },
    'an unavailable executor must not create a native Session, including after reopen',
  );
  if (reopened) {
    const query = await request('session.catalog.query', {
      kind: 'get',
      sessionId: create.sessionId,
    });
    assert.equal(query.kind, 'session');
    assert.equal(query.session.isArchived, true);
    assert.equal(query.session.name, 'Rust 会话');
    await verifyArchivedConfiguration(connection, query.session);
    await verifyBlockedWorkspace(connection, query.session);
    await persistWorkspace(connection, create.sessionId, workspace, true);
    // Exact creation replay must not re-resolve a since-deleted model connection.
    assert.deepEqual(await request('session.create', create), query.session);
    const catalog = await request('connection.catalog.query', { kind: 'start' });
    assert.deepEqual(catalog.items, []);
    assert.equal(catalog.defaultTarget, null);
    const terminal = await request('turn.query', {
      sessionId: create.sessionId,
      turnId: 'first-turn',
    });
    assert.equal(terminal.status, 'completed');
    assert(terminal.terminalEventId);
    const cancelled = await request('turn.query', {
      sessionId: create.sessionId,
      turnId: 'cancelled-turn',
    });
    assert.equal(cancelled.status, 'cancelled');
    const latest = await request('turn.query', {
      sessionId: create.sessionId,
      turnId: 'after-cancel',
    });
    const observer = await watchSession(connection, create.sessionId);
    assert.deepEqual(observer.subscription.snapshot.rootTurn, latest);
    assert.equal(observer.subscription.snapshot.session.isArchived, true);
    assert.deepEqual(observer.subscription.activeAssistantStreams, []);
    await observer.close();
    await verifyNavigation(connection, create.sessionId, workspace, true);
    await persistReadMarker(connection, create.sessionId, workspace, true);
    console.log(JSON.stringify({ check: 'session-control-reopen', result: 'passed' }));
    return;
  }
  const configurationChanges = [];
  const sessionChanges = [];
  const unsubscribeConfiguration = connection.subscribeConfigurationChanges((revision) =>
    configurationChanges.push(revision),
  );
  const unsubscribeSession = connection.subscribeSessionCatalogChanges((frame) =>
    sessionChanges.push(frame),
  );
  const fixture = await modelFixture();
  try {
    const initial = await request('connection.catalog.query', { kind: 'start' });
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.items, []);
    const directory = await readRuntimeHostModelProviders(connection);
    const draft = {
      expectedCatalogRevision: 0,
      connection: {
        slug: 'local-fixture',
        name: 'Local fixture',
        provider: directory.entries.find((entry) => entry.identity.name === 'openai-compatible')
          .identity,
        configuration: { baseUrl: fixture.baseUrl },
        enabled: true,
        enabledModelIds: ['fixture-model'],
        modelOverrides: { 'fixture-model': { contextWindow: 200000, thinkingLevels: ['off'] } },
      },
    };
    const created = await request('connection.catalog.create', draft);
    assert.equal(created.kind, 'committed');
    assert.equal(created.catalogRevision, 1);
    assert.equal((await request('connection.catalog.create', draft)).kind, 'revision_conflict');
    let basis = created.connection;
    const locator = { scope: 'connection', connectionId: basis.connectionId, kind: 'provider' };
    await authenticateModelConnection(request, basis.connectionId, 'dummy-local-fixture');
    const credential = await request('credential.vault.query', { locator });
    assert.equal(credential.status.configured, true);
    const authenticated = await request('connection.catalog.query', { kind: 'start' });
    const authenticatedRow = authenticated.items.find(
      (item) => item.kind === 'connection' && item.connectionId === basis.connectionId,
    );
    basis = { connectionId: basis.connectionId, revision: authenticatedRow.revision };
    const target = { connectionId: basis.connectionId, modelId: 'fixture-model' };
    const selected = await request('connection.catalog.set-default-target', {
      expectedCatalogRevision: authenticated.revision,
      target,
    });
    assert.equal(selected.catalogRevision, authenticated.revision + 1);
    const configured = await request('connection.catalog.query', { kind: 'start' });
    assert.deepEqual(configured.defaultTarget, target);
    assert(
      configured.items.some(
        (item) =>
          item.kind === 'catalog_entry' &&
          item.entry.id === 'fixture-model' &&
          item.entry.isDefault,
      ),
    );
    const session = await request('session.create', create);
    assert.equal(session.name, 'Rust 会话');
    assert.equal(session.llmConnectionId, basis.connectionId);
    assert.deepEqual(session.workspace, {
      target: { kind: 'host_path', path: await realpath(workspace) },
      hostCwd: await realpath(workspace),
    });
    assert.deepEqual(await request('session.create', create), session);
    await assert.rejects(
      request('session.create', { ...create, name: 'Different identity' }),
      (error) => error.code === 'operation_conflict',
    );
    const page = await request('session.catalog.query', { kind: 'list_start' });
    assert.deepEqual(page.sessions, [session]);
    await verifyMetadata(connection, session, connectSibling);
    await verifyConfiguration(connection, session.id, connectSibling);
    await verifyTurns(connection, create.sessionId, fixture, connectSibling);
    await verifyNavigation(connection, create.sessionId, workspace, false);
    await verifyWorkspace(connection, create.sessionId, workspace);
    const archived = await request('session.lifecycle.set', {
      sessionId: create.sessionId,
      state: 'archived',
    });
    assert.equal(archived.isArchived, true);
    assert(archived.revision > session.revision);
    await verifyArchivedConfiguration(connection, archived);
    await verifyBlockedWorkspace(connection, archived);
    const removed = await request('connection.catalog.remove', { expected: basis });
    assert.equal(removed.kind, 'committed');
    assert.deepEqual(await request('session.create', create), archived);
    await persistReadMarker(connection, create.sessionId, workspace, false);
    await persistWorkspace(connection, create.sessionId, workspace, false);
    // Responses and change frames traverse the same original-client decoder.
    await connection.status(3000);
    assert(configurationChanges.length >= 4);
    assert(
      configurationChanges.every(
        (revision, index) => index === 0 || revision > configurationChanges[index - 1],
      ),
    );
    assert(sessionChanges.some((frame) => frame.sessionId === create.sessionId));
    console.log(JSON.stringify({ check: 'session-control-workflow', result: 'passed' }));
  } finally {
    unsubscribeConfiguration();
    unsubscribeSession();
    await fixture.close();
  }
}

async function verifyNavigation(connection, sessionId, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 3000);
  const landmarks = await request('session.turn_landmarks.query', {
    sessionId,
    maxLandmarks: 64,
    turnId: null,
  });
  assert(landmarks.throughSequence !== null);
  const merged = new Map();
  let position = 0;
  let pages = 0;
  for (;;) {
    const page = await request('session.turns.query', {
      sessionId,
      throughSequence: landmarks.throughSequence,
      position,
      maxContributions: 1,
    });
    assert.equal(page.throughSequence, landmarks.throughSequence);
    for (const contribution of page.contributions) {
      const previous = merged.get(contribution.turnId);
      merged.set(
        contribution.turnId,
        previous ? mergeSessionTurnContributions(previous, contribution) : contribution,
      );
    }
    assert(++pages < 100, 'navigation must finish');
    if (page.nextPosition === null) break;
    assert(page.nextPosition > position, 'inclusive cursor must advance');
    position = page.nextPosition;
  }
  assert.equal(merged.get('first-turn').latestState.message.status, 'completed');
  assert.equal(merged.get('cancelled-turn').latestState.message.status, 'aborted');
  assert.equal(merged.get('first-turn').userPromptPreview, 'First visible question 😀 @source.rs');
  assert(pages > 1);
  for (const landmark of landmarks.landmarks) {
    assert.equal(landmark.sequence, merged.get(landmark.turnId).firstSequence);
    assert.equal(landmark.label, merged.get(landmark.turnId).userPromptPreview);
  }
  const snapshot = JSON.stringify({ landmarks, contributions: [...merged.values()] });
  const path = join(workspace, 'navigation.json');
  if (reopened) assert.equal(snapshot, await readFile(path, 'utf8'));
  else await writeFile(path, snapshot);
  await assert.rejects(
    request('session.turns.query', {
      sessionId: 'missing-navigation-session',
      throughSequence: null,
      position: 0,
      maxContributions: 1,
    }),
    (error) => error.code === 'not_found',
  );
}
