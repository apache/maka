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
  redactReversibleStreamingSuffix,
  redactSecrets,
  redactStableStreamingSuffix,
} from '../display-redaction.js';

const USERINFO_CASES: Array<[string, string]> = [
  [
    'https://myuser:glpat-AbCdEf12345XyZ@gitlab.com/team/repo.git',
    'https://<redacted>@gitlab.com/team/repo.git',
  ],
  [
    'https://alice:hunter2@internal.example.com/repo.git',
    'https://<redacted>@internal.example.com/repo.git',
  ],
  [
    'https://alice:ATBBxyz123abc456@bitbucket.org/team/repo.git',
    'https://<redacted>@bitbucket.org/team/repo.git',
  ],
  [
    'fatal: unable to access https://deploy:s3cretP@ss@git.corp.example/x.git/: 403',
    'fatal: unable to access https://<redacted>@git.corp.example/x.git/: 403',
  ],
  ['https://user@host.example/team/repo.git', 'https://<redacted>@host.example/team/repo.git'],
  [
    'origin https://alice:hunter2@internal.example.com/repo.git (fetch)',
    'origin https://<redacted>@internal.example.com/repo.git (fetch)',
  ],
  [
    'see https://alice:hunter2@internal.example.com/repo.git.',
    'see https://<redacted>@internal.example.com/repo.git.',
  ],
  [
    'clone (https://alice:hunter2@internal.example.com/repo.git)',
    'clone (https://<redacted>@internal.example.com/repo.git)',
  ],
];

describe('display redactSecrets', () => {
  test('masks URL userinfo credentials without swallowing host or path', () => {
    for (const [input, expected] of USERINFO_CASES) {
      assert.equal(redactSecrets(input), expected);
    }
    assert.equal(
      redactSecrets('https://api.example.com/v1?token=abc123'),
      'https://api.example.com/v1?token=<redacted>',
    );
    assert.equal(
      redactSecrets('https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/o/r.git'),
      'https://<redacted>@github.com/o/r.git',
    );
    assert.equal(
      redactSecrets('https://alice:hunter2@api.example.com/v1?token=abc123'),
      'https://<redacted>@api.example.com/v1?token=<redacted>',
    );
    // Negatives: bare https://host must not swallow a later @ across spaces/newlines.
    assert.equal(
      redactSecrets('see https://example.com and mail bob@corp.com'),
      'see https://example.com and mail bob@corp.com',
    );
    assert.equal(
      redactSecrets('Fetching https://registry.example.com\nContact: support@example.com for help'),
      'Fetching https://registry.example.com\nContact: support@example.com for help',
    );
  });
});

describe('display streaming suffix redactors', () => {
  test('keeps a stable userinfo suffix compacted until the authority ends', () => {
    const suffix = redactStableStreamingSuffix(
      'fatal: unable to access https://deploy:s3cretP@ss@',
    );
    assert.ok(suffix);
    assert.equal(suffix.text, 'fatal: unable to access https://<redacted>@');
    assert.equal(suffix.settledPrefixText, 'fatal: unable to access ');
    assert.equal(suffix.compactedSuffix, 'https://deploy:s3cretP@ss@');
    assert.equal(suffix.terminator.test('/'), true);
    assert.equal(suffix.terminator.test('?'), true);
    assert.equal(redactSecrets(suffix.settledPrefixText + suffix.compactedSuffix), suffix.text);
  });

  test('does not treat a completed userinfo URL as a streaming suffix', () => {
    for (const [input] of USERINFO_CASES) {
      const suffix = redactStableStreamingSuffix(input);
      assert.equal(suffix, undefined, input);
      assert.equal(redactReversibleStreamingSuffix(input), undefined, input);
    }
  });

  test('still shortens a reversible provider token that reaches end-of-input', () => {
    const token = `ghp_${'A'.repeat(200)}`;
    const reversible = redactReversibleStreamingSuffix(token);
    assert.ok(reversible);
    assert.equal(redactSecrets(reversible.compactedInput), redactSecrets(token));
    assert.equal(reversible.compactedToken.length < token.length, true);
  });
});
