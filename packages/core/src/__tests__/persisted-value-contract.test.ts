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
import { markPersisted, type PersistedValue } from '../persisted-value.js';

interface ExampleRecord {
  readonly id: string;
}

interface WiderRecord {
  readonly id: string;
}

interface NarrowerRecord extends WiderRecord {
  readonly detail: string;
}

test('persisted values cross into domain types only through an explicit decoder', () => {
  const persisted = markPersisted<ExampleRecord>({ id: 'record-1' });
  const decode = (value: PersistedValue<ExampleRecord>): ExampleRecord =>
    value as unknown as ExampleRecord;

  const assignWithoutDecode = () => {
    // @ts-expect-error A persisted value is not a decoded domain record.
    const current: ExampleRecord = persisted;
    return current;
  };
  const passUnknownWithoutMarking = (value: unknown) => {
    // @ts-expect-error Unknown input must be marked at a persistence read seam first.
    return decode(value);
  };
  const passCurrentWithoutMarking = (value: ExampleRecord) => {
    // @ts-expect-error Current domain values are not persisted decoder inputs.
    return decode(value);
  };

  assert.deepEqual(decode(persisted), { id: 'record-1' });
  assert.equal(typeof assignWithoutDecode, 'function');
  assert.equal(typeof passUnknownWithoutMarking, 'function');
  assert.equal(typeof passCurrentWithoutMarking, 'function');
});

test('persisted values are invariant in their domain type', () => {
  const narrower = markPersisted<NarrowerRecord>({ id: 'record-1', detail: 'detail' });
  const rejectWidening = () => {
    // @ts-expect-error PersistedValue<T> must not widen across related record types.
    const wider: PersistedValue<WiderRecord> = narrower;
    return wider;
  };

  assert.equal(typeof rejectWidening, 'function');
});
