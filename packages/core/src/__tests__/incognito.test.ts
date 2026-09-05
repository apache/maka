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
import { describe, it } from 'node:test';
import { validateWorkspacePrivacyContext } from '../incognito.js';

describe('workspace privacy context', () => {
  it('accepts booleans and strips renderer-supplied authority fields', () => {
    assert.deepEqual(
      validateWorkspacePrivacyContext({
        incognitoActive: true,
        durableWriteAllowed: true,
      }),
      { ok: true, value: { incognitoActive: true } },
    );
  });

  it('fails closed for non-objects and missing or non-boolean state', () => {
    for (const input of [null, 'incognito', []]) {
      assert.equal(validateWorkspacePrivacyContext(input).ok, false);
    }
    for (const input of [{}, { incognitoActive: 'true' }]) {
      assert.deepEqual(validateWorkspacePrivacyContext(input), {
        ok: false,
        reason: 'incognito_active_invalid',
        message: 'WorkspacePrivacyContext.incognitoActive must be a boolean',
      });
    }
  });
});
