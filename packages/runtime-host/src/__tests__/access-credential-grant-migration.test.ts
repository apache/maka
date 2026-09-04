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
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACCESS_FILE_NAME,
  effectiveOperationGrants,
  issuedAccessGrants,
  readAccessCredentialFile,
  unresolvedPersistedGrants,
  writeAccessCredentialFile,
} from '../server/access-credential-store.js';

// These fixtures are hand-written JSON rather than output from the current
// writer on purpose. The subject is a file some earlier release left behind, so
// round-tripping today's encoder would only prove it agrees with itself.
async function writeAccessFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-migration-'));
  const path = join(directory, ACCESS_FILE_NAME);
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  return path;
}

function storedCredential(operationGrants: readonly string[]): Record<string, unknown> {
  return {
    credentialId: 'c8f6a0f4-0d5a-4a2e-9a1a-3f3a5c8d1b20',
    credentialHash: 'a'.repeat(64),
    principalId: 'released-client',
    principalKind: 'remote_owner',
    status: 'active',
    operationGrants,
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('a renamed operation carries its stored authority to the successor', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [storedCredential(['host.status', 'task.ledger.query'])],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  const credential = file.credentials[0];
  assert.ok(credential);
  assert.deepEqual(credential.grants, ['host.status', 'session.todo.query']);
  assert.deepEqual(effectiveOperationGrants(credential), ['host.status', 'session.todo.query']);
  assert.deepEqual(unresolvedPersistedGrants(file), []);
});

test('an unregistered grant opens the file and stays in the record', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [storedCredential(['host.status', 'session.futures.query'])],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  const credential = file.credentials[0];
  assert.ok(credential);
  // The record keeps it — erasing it here is what a later unrelated write would
  // make permanent.
  assert.deepEqual(credential.grants, ['host.status', 'session.futures.query']);
  // The authority does not, because this build cannot serve it.
  assert.deepEqual(effectiveOperationGrants(credential), ['host.status']);
  // And it is reported, because no migration entry accounts for it.
  assert.deepEqual(unresolvedPersistedGrants(file), ['session.futures.query']);
});

test('an unaccountable grant survives a rewrite of the file', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [storedCredential(['host.status', 'session.futures.query'])],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  await writeAccessCredentialFile(path, file);
  const rewritten = JSON.parse(await readFile(path, 'utf8'));

  // The published key keeps its name, and the grant this build could not
  // account for is still under it.
  assert.deepEqual(rewritten.credentials[0].operationGrants, [
    'host.status',
    'session.futures.query',
  ]);
  assert.equal(rewritten.credentials[0].grants, undefined);
});

test('a released operation is dropped from the record and reported as accounted for', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [storedCredential(['host.status', 'execution.inspect.resolve'])],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  assert.deepEqual(file.credentials[0]?.grants, ['host.status']);
  assert.deepEqual(unresolvedPersistedGrants(file), []);
});

test('a Session Guest holds the current guest policy, not what its record says', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [
      {
        ...storedCredential(['host.status', 'session.futures.query']),
        principalId: 'session_guest:8f2c1d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f',
        principalKind: 'session_guest',
      },
    ],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  const credential = file.credentials[0];
  assert.ok(credential);
  // Widened to compare against a key the current protocol does not define —
  // which the derived type will not admit, itself part of what is under test.
  const effective: readonly string[] = effectiveOperationGrants(credential);
  assert.ok(effective.includes('session.shared.query'));
  assert.ok(!effective.includes('session.futures.query'));
});

test('a local-owner-only operation is withheld from a remote credential but kept on file', async () => {
  const path = await writeAccessFile({
    schemaVersion: 3,
    credentials: [storedCredential(['host.status', 'access.credential.issue'])],
    sessionGrants: [],
    turnAccessRequests: [],
  });

  const file = await readAccessCredentialFile(path);
  const credential = file.credentials[0];
  assert.ok(credential);
  assert.deepEqual(credential.grants, ['host.status', 'access.credential.issue']);
  assert.deepEqual(effectiveOperationGrants(credential), ['host.status']);
  // Policy contraction is not a missing migration, so it is not unresolved.
  assert.deepEqual(unresolvedPersistedGrants(file), []);
});

test('a schema 1 file opens without the members later versions added', async () => {
  const path = await writeAccessFile({
    schemaVersion: 1,
    credentials: [storedCredential(['host.status'])],
  });

  const file = await readAccessCredentialFile(path);
  assert.equal(file.credentials.length, 1);
  assert.deepEqual(file.sessionGrants, []);
  assert.deepEqual(file.turnAccessRequests, []);
});

test('issuance still refuses an operation the protocol does not define', () => {
  assert.throws(
    () => issuedAccessGrants(['not.an.operation' as never]),
    /Unknown Runtime Host operation grant/,
  );
});
