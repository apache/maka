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
import { describe, test } from 'node:test';
import {
  connectionNameDraftChanged,
  connectionNameDraftReseed,
  connectionNameToSave,
  shouldRefreshModelsAfterSave,
} from '../../renderer/settings/connection-name-draft.js';

describe('connectionNameDraftReseed', () => {
  test('a slug switch reseeds even mid-edit', () => {
    // The defect this exists to prevent: typing a name for connection A,
    // switching to B, and having one save rename B to A's draft.
    assert.equal(
      connectionNameDraftReseed(
        { slug: 'alpha', savedName: 'Alpha' },
        { slug: 'beta', name: 'Beta' },
        'a name being typed',
      ),
      true,
    );
  });

  test('an unrelated reload of the same connection keeps typed work', () => {
    assert.equal(
      connectionNameDraftReseed(
        { slug: 'alpha', savedName: 'Alpha' },
        { slug: 'alpha', name: 'Alpha' },
        'half a new name',
      ),
      false,
    );
  });

  test('a rename that landed elsewhere reseeds a clean draft', () => {
    assert.equal(
      connectionNameDraftReseed(
        { slug: 'alpha', savedName: 'Alpha' },
        { slug: 'alpha', name: 'Renamed by another client' },
        'Alpha',
      ),
      true,
    );
  });

  test('a rename that landed elsewhere does not discard typed work', () => {
    assert.equal(
      connectionNameDraftReseed(
        { slug: 'alpha', savedName: 'Alpha' },
        { slug: 'alpha', name: 'Renamed by another client' },
        'what the user was typing',
      ),
      false,
    );
  });
});

describe('connectionNameDraftChanged', () => {
  test('a different name is a change', () => {
    assert.equal(connectionNameDraftChanged('Renamed', 'Alpha'), true);
  });

  test('the same name is not', () => {
    assert.equal(connectionNameDraftChanged('Alpha', 'Alpha'), false);
  });

  test('whitespace alone is not a change', () => {
    // Otherwise the save button never rests: a trailing space typed by
    // accident reads as an edit, and saving it stores a name that renders
    // identically to the one already stored.
    assert.equal(connectionNameDraftChanged('Alpha  ', 'Alpha'), false);
    assert.equal(connectionNameDraftChanged('  Alpha', 'Alpha'), false);
  });

  test('an emptied field is not offered as a change', () => {
    // The catalog requires a name. Clearing the field is a half-finished
    // edit, and offering to save it would let a connection lose its name.
    assert.equal(connectionNameDraftChanged('', 'Alpha'), false);
    assert.equal(connectionNameDraftChanged('   ', 'Alpha'), false);
  });
});

describe('connectionNameToSave', () => {
  test('commits the trimmed name, not the raw draft', () => {
    assert.equal(connectionNameToSave('  Renamed  '), 'Renamed');
  });
});

describe('shouldRefreshModelsAfterSave', () => {
  test('a rename never fetches models', () => {
    // The catalog a user lands on is unchanged by a rename, so an empty cache
    // is no more urgent afterwards — and a fetch nobody asked for can raise an
    // error about a connection the user only renamed.
    assert.equal(
      shouldRefreshModelsAfterSave({ field: 'name', wroteNewKey: false, hasCachedModels: false }),
      false,
    );
    assert.equal(
      shouldRefreshModelsAfterSave({ field: 'name', wroteNewKey: false, hasCachedModels: true }),
      false,
    );
  });

  test('a new credential still fetches', () => {
    assert.equal(
      shouldRefreshModelsAfterSave({ field: 'key', wroteNewKey: true, hasCachedModels: true }),
      true,
    );
  });

  test('a new endpoint still fetches', () => {
    assert.equal(
      shouldRefreshModelsAfterSave({ field: 'endpoint', wroteNewKey: false, hasCachedModels: true }),
      true,
    );
  });

  test('an empty cache still fetches for the fields that can fill it', () => {
    assert.equal(
      shouldRefreshModelsAfterSave({ field: 'key', wroteNewKey: false, hasCachedModels: false }),
      true,
    );
  });
});
