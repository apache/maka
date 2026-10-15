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
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { reclaimColdRuntimeStorageSpace } from '../../packages/storage/dist/cold-runtime-storage.js';
import { acquireOperationalStateDatabase } from '../../packages/storage/dist/operational-state-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '../../packages/storage/dist/root-authority.js';
import { removeControlDirectory } from '../../packages/storage/dist/__tests__/fixtures/control-directory-hygiene.js';

const { values } = parseArgs({
  options: { source: { type: 'string' }, output: { type: 'string' } },
});
assert.ok(values.source && values.output, 'Required: --source SQLITE --output NEW_DIRECTORY');
const source = resolve(values.source),
  output = resolve(values.output);
await mkdir(output);
const automatic = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 4)));
const report = {
  source,
  environment: {
    node: process.versions.node,
    cpu: cpus()[0].model,
    availableParallelism: availableParallelism(),
    memory: totalmem(),
  },
  automatic,
  trials: [],
};
const fileDigest = async () => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest('hex');
};
function corpusDigest(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash('sha256');
    let records = 0;
    for (const row of db
      .prepare('SELECT event_id,payload_json FROM runtime_events ORDER BY event_id')
      .iterate()) {
      hash.update(row.event_id);
      hash.update('\0');
      hash.update(row.payload_json);
      hash.update('\0');
      records++;
    }
    return { records, sha256: hash.digest('hex') };
  } finally {
    db.close();
  }
}
report.sourceSha256 = await fileDigest();
const original = corpusDigest(source);
for (const auxiliaryThreads of [...new Set([0, automatic, 8])]) {
  const root = await mkdtemp(join(output, `threads-${auxiliaryThreads}-`));
  let owner, capability;
  try {
    const path = join(root, 'runtime.sqlite');
    await copyFile(source, path, constants.COPYFILE_FICLONE);
    capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const schemaStart = performance.now();
    const initialization = acquireOperationalStateDatabase(root);
    initialization.close();
    const schemaMs = performance.now() - schemaStart;
    let maximumHeartbeatGapMs = 0,
      last = performance.now(),
      peakRss = process.memoryUsage().rss;
    const timer = setInterval(() => {
      const now = performance.now();
      maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, now - last);
      last = now;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    const start = performance.now(),
      cpu = process.cpuUsage();
    let work;
    try {
      work = await reclaimColdRuntimeStorageSpace(owner.lease, {
        enableIncrementalVacuum: true,
        auxiliaryThreads,
        onPhase: (phase) =>
          console.log(
            JSON.stringify({ auxiliaryThreads, phase, elapsedMs: performance.now() - start }),
          ),
      });
    } finally {
      clearInterval(timer);
    }
    const trial = {
      requestedAuxiliaryThreads: auxiliaryThreads,
      schemaMs,
      ...work,
      elapsedMs: performance.now() - start,
      cpu: process.cpuUsage(cpu),
      maximumHeartbeatGapMs,
      peakRss,
    };
    assert.equal(work.busy, false);
    assert.equal(work.autoVacuumModeAfter, 2);
    assert.deepEqual(corpusDigest(path), original);
    report.trials.push(trial);
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(trial));
  } finally {
    await owner?.close();
    if (capability) await removeControlDirectory(capability.rootId);
    await rm(root, { recursive: true, force: true });
  }
}
report.sourceUnchanged = (await fileDigest()) === report.sourceSha256;
assert.ok(report.sourceUnchanged);
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: join(output, 'report.json') }));
