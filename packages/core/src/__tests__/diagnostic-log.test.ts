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
import { collapseHomePath, DiagnosticLogBuffer } from '../diagnostic-log.js';

test('keeps a bounded redacted tail of diagnostic logs', () => {
  const buffer = new DiagnosticLogBuffer({
    maxBytes: 1024,
    maxEntries: 2,
    maxEntryCodePoints: 200,
    maxEntryUtf8Bytes: 80,
  });
  buffer.append('info', 'api_key=sk-secretvalue123 first', new Date('2026-08-09T00:00:00Z'));
  buffer.append('warn', '🚀'.repeat(100), new Date('2026-08-09T00:00:01Z'));
  buffer.append('error', 'newest', new Date('2026-08-09T00:00:02Z'));

  const logs = buffer.snapshot();
  assert.equal(logs.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(logs)) <= 1024);
  assert.ok(logs.every((entry) => Buffer.byteLength(entry) <= 80));
  assert.doesNotMatch(logs.join('\n'), /sk-secretvalue123/);
  assert.match(logs.at(-1) ?? '', /ERROR newest$/);
});

test('collapses the home path belonging to the process that captured the logs', () => {
  assert.equal(
    collapseHomePath('/home/remote-user/.maka/logs', '/home/remote-user', 'linux'),
    '~/.maka/logs',
  );
  assert.equal(
    collapseHomePath('C:\\Users\\Remote\\.maka', 'c:\\users\\remote', 'win32'),
    '~\\.maka',
  );
  assert.equal(
    collapseHomePath(
      'file:///C:/Users/Remote%20User%231/.maka/logs',
      'C:\\Users\\Remote User#1',
      'win32',
    ),
    'file:///~/.maka/logs',
  );
});
