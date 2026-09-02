/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { comparePe } from './diagnose-windows-repro.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(process.argv[2]);
const sourceCommit = '493dd30827326455f817409d4c0b0f63ff7042ea';
const samples = ['a', 'b'].map((sample) => {
  const evidence = join(root, `windows-repro-evidence-${sample}`);
  const environment = JSON.parse(readFileSync(join(evidence, 'environment.json')));
  assert.equal(environment.sourceCommit, sourceCommit);
  return {
    environment,
    files: new Map(
      JSON.parse(readFileSync(join(evidence, 'files.json'))).map((file) => [file.path, file]),
    ),
    payload: join(root, `windows-repro-payload-${sample}`),
  };
});

function artifact(sample, name) {
  const bytes = readFileSync(join(sample.payload, name));
  assert.equal(hash(bytes), sample.files.get(name).sha256, `Hash mismatch: ${name}`);
  return bytes;
}

function zipEvidence(bytes) {
  const normalized = Buffer.from(bytes);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'Missing ZIP end record');
  assert.equal(end + 22 + bytes.readUInt16LE(end + 20), bytes.length);
  const count = bytes.readUInt16LE(end + 10);
  assert.notEqual(count, 65535, 'ZIP64 is not supported by this diagnostic');
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    entries.push({
      name: bytes.toString('utf8', offset + 46, offset + 46 + nameLength),
      dosTime: bytes.subarray(offset + 12, offset + 16).toString('hex'),
      localDosTime: bytes.subarray(local + 10, local + 14).toString('hex'),
      crc: bytes.readUInt32LE(offset + 16),
      size: bytes.readUInt32LE(offset + 24),
      compressedSize,
      compressedHash: hash(bytes.subarray(data, data + compressedSize)),
      extra: bytes
        .subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
        .toString('hex'),
    });
    normalized.fill(0, offset + 12, offset + 16);
    normalized.fill(0, local + 10, local + 14);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end, 'Unexpected bytes between central directory and end record');
  return { normalizedHash: hash(normalized), entries };
}

function tree(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(root, name) : [name];
  });
}

const zipName = 'Maka-0.2.0-win-x64.zip';
const exeName = 'Maka-0.2.0-win-x64.exe';
const zips = samples.map((sample) => zipEvidence(artifact(sample, zipName)));
const zipChanges = zips[0].entries.flatMap((entry, index) => {
  const other = zips[1].entries[index];
  return JSON.stringify(entry) === JSON.stringify(other) ? [] : [{ a: entry, b: other }];
});
const installer = comparePe(...samples.map((sample) => artifact(sample, exeName)));
const extracted = samples.map((sample) => {
  const destination = mkdtempSync(join(tmpdir(), 'maka-nsis-diagnosis-'));
  execFileSync('7z', ['x', '-y', `-o${destination}`, join(sample.payload, exeName)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return {
    root: destination,
    files: new Map(
      tree(destination).map((name) => [name, hash(readFileSync(join(destination, name)))]),
    ),
  };
});
const extractedDifferences = [
  ...new Set(extracted.flatMap((sample) => [...sample.files.keys()])),
].filter((name) => extracted[0].files.get(name) !== extracted[1].files.get(name));
const extractedPe = extractedDifferences
  .filter((name) => name.endsWith('.exe') && extracted.every((sample) => sample.files.has(name)))
  .map((name) => ({
    name,
    comparison: comparePe(...extracted.map((sample) => readFileSync(join(sample.root, name)))),
  }));
console.log(
  JSON.stringify(
    {
      sourceCommit,
      environments: samples.map((sample) => sample.environment),
      verifiedArchiveHashes: true,
      zip: {
        entryCounts: zips.map((zip) => zip.entries.length),
        equalAfterOnlyDosTimeIsolation: zips[0].normalizedHash === zips[1].normalizedHash,
        changedEntries: zipChanges.length,
        firstChanges: zipChanges.slice(0, 12),
      },
      installer,
      extractedFileCounts: extracted.map((sample) => sample.files.size),
      extractedDifferences,
      extractedPe,
      note: 'Only in-memory diagnostic isolation; original artifacts are not modified or executed. Archive extraction alone does not establish installer equivalence.',
    },
    null,
    2,
  ),
);
