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
import test from 'node:test';
import { createCapabilityRevisionPublisher } from '../runtime-host-capability-revision-publisher.js';

test('publishes an offline revision to the replacement candidate generation', async () => {
  let revision = 1;
  const publications: string[] = [];
  const publisher = createCapabilityRevisionPublisher(() => revision);
  const first = publisher.bind(async () => {
    publications.push(`first:${revision}`);
  });
  await first.aligned;
  first.dispose();

  revision = 2;
  await publisher.refreshIfChanged();
  assert.deepEqual(publications, ['first:1']);

  const replacement = publisher.bind(async () => {
    publications.push(`replacement:${revision}`);
  });
  await replacement.aligned;
  assert.deepEqual(publications, ['first:1', 'replacement:2']);
});

test('does not let a retired candidate confirm an in-flight publication', async () => {
  let revision = 1;
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstPublication = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const publications: string[] = [];
  const publisher = createCapabilityRevisionPublisher(() => revision);
  const first = publisher.bind(async () => {
    publications.push(`first:${revision}`);
    markFirstStarted?.();
    await firstPublication;
  });

  await firstStarted;
  first.dispose();
  revision = 2;
  const replacement = publisher.bind(async () => {
    publications.push(`replacement:${revision}`);
  });
  releaseFirst?.();
  await first.aligned;
  await replacement.aligned;

  assert.deepEqual(publications, ['first:1', 'replacement:2']);
  await publisher.refreshIfChanged();
  assert.deepEqual(publications, ['first:1', 'replacement:2']);
});
