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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceCommit = '48b0408003edcf9594c38e2cb1bfc79beb4283b5';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function under(root, path) {
  const result = resolve(root, path);
  assert.ok(result.startsWith(`${resolve(root)}${sep}`), `Path escapes artifact: ${path}`);
  return result;
}

function replaceEqualLength(bytes, needle, replacement) {
  assert.equal(needle.length, replacement.length);
  let count = 0;
  for (
    let offset = bytes.indexOf(needle);
    offset !== -1;
    offset = bytes.indexOf(needle, offset + needle.length)
  ) {
    replacement.copy(bytes, offset);
    count++;
  }
  return count;
}

function normalizeCheckout(bytes, sample) {
  const result = Buffer.from(bytes);
  let replacements = 0;
  for (const encoding of ['utf8', 'utf16le']) {
    for (const token of [`sample-${sample}`, `SAMPLE-${sample.toUpperCase()}`]) {
      replacements += replaceEqualLength(
        result,
        Buffer.from(token, encoding),
        Buffer.from(token.slice(0, -1) + 'X', encoding),
      );
    }
  }
  return { bytes: result, replacements };
}

function differingRanges(a, b) {
  const ranges = [];
  let count = 0;
  let current;
  for (let offset = 0; offset < Math.max(a.length, b.length); offset++) {
    if (a[offset] === b[offset]) {
      current = undefined;
      continue;
    }
    count++;
    if (current) current.length++;
    else {
      current = { offset, length: 1 };
      if (ranges.length < 16) ranges.push(current);
    }
  }
  return {
    count,
    firstRanges: ranges.map((range) => ({
      ...range,
      a: a.subarray(range.offset, range.offset + Math.min(range.length, 24)).toString('hex'),
      b: b.subarray(range.offset, range.offset + Math.min(range.length, 24)).toString('hex'),
    })),
  };
}

export function readPe(bytes) {
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
  const optional = pe + 24;
  const sectionTable = optional + bytes.readUInt16LE(pe + 20);
  const sections = [];
  for (let index = 0; index < bytes.readUInt16LE(pe + 6); index++) {
    const start = sectionTable + index * 40;
    const section = {
      name: bytes.toString('ascii', start, start + 8).replace(/\0.*$/u, ''),
      rva: bytes.readUInt32LE(start + 12),
      size: bytes.readUInt32LE(start + 16),
      offset: bytes.readUInt32LE(start + 20),
    };
    assert.ok(section.offset + section.size <= bytes.length);
    sections.push(section);
  }
  const atRva = (rva) => {
    const section = sections.find((entry) => rva >= entry.rva && rva < entry.rva + entry.size);
    assert.ok(section, `Unmapped PE RVA ${rva}`);
    return section.offset + rva - section.rva;
  };
  const directory = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const debugRva = bytes.readUInt32LE(directory + 6 * 8);
  const debugSize = bytes.readUInt32LE(directory + 6 * 8 + 4);
  const metadataRanges = [
    [pe + 8, 4],
    [optional + 64, 4],
  ];
  const debug = [];
  for (let index = 0; debugRva && index + 28 <= debugSize; index += 28) {
    const entry = atRva(debugRva) + index;
    const type = bytes.readUInt32LE(entry + 12);
    const size = bytes.readUInt32LE(entry + 16);
    const offset = bytes.readUInt32LE(entry + 24);
    assert.ok(offset + size <= bytes.length);
    metadataRanges.push([entry + 4, 4]);
    const info = { type, timestamp: bytes.readUInt32LE(entry + 4), size, offset };
    if (type === 2 && size >= 24 && bytes.toString('ascii', offset, offset + 4) === 'RSDS') {
      info.guid = bytes.subarray(offset + 4, offset + 20).toString('hex');
      info.age = bytes.readUInt32LE(offset + 20);
      info.pdb = bytes.toString('utf8', offset + 24, offset + size).replace(/\0.*$/u, '');
      metadataRanges.push([offset, size]);
    }
    debug.push(info);
  }
  return {
    timestamp: bytes.readUInt32LE(pe + 8),
    checksum: bytes.readUInt32LE(optional + 64),
    sections,
    debug,
    metadataRanges,
  };
}

export function comparePe(a, b, asarHeaderHashes = []) {
  const parsed = [a, b].map(readPe);
  const normalized = [a, b].map((bytes, index) => normalizeCheckout(bytes, ['a', 'b'][index]));
  const pathOnlyEqual = normalized[0].bytes.equals(normalized[1].bytes);
  for (const [index, entry] of parsed.entries()) {
    for (const [offset, size] of entry.metadataRanges)
      normalized[index].bytes.fill(0, offset, offset + size);
  }
  const metadataAndPathsEqual = normalized[0].bytes.equals(normalized[1].bytes);
  const integrityReplacements = normalized.map((entry, index) =>
    asarHeaderHashes[index]
      ? replaceEqualLength(entry.bytes, Buffer.from(asarHeaderHashes[index]), Buffer.alloc(64, 48))
      : 0,
  );
  return {
    size: [a.length, b.length],
    timestamps: parsed.map((entry) => entry.timestamp),
    debug: parsed.map((entry) => entry.debug),
    pathReplacements: normalized.map((entry) => entry.replacements),
    pathOnlyEqual,
    metadataAndPathsEqual,
    integrityReplacements,
    metadataPathsAndAsarIntegrityEqual: normalized[0].bytes.equals(normalized[1].bytes),
    remainingDifferences: differingRanges(normalized[0].bytes, normalized[1].bytes),
    sections: parsed[0].sections.map((section) => {
      const other = parsed[1].sections.find((entry) => entry.name === section.name);
      const content = a.subarray(section.offset, section.offset + section.size);
      return {
        name: section.name,
        size: [section.size, other?.size],
        rawEqual: !!other && content.equals(b.subarray(other.offset, other.offset + other.size)),
        diagnosticEqual:
          !!other &&
          normalized[0].bytes
            .subarray(section.offset, section.offset + section.size)
            .equals(normalized[1].bytes.subarray(other.offset, other.offset + other.size)),
      };
    }),
  };
}

export function inspectAsar(archive) {
  const bytes = readFileSync(archive);
  const dataStart = 8 + bytes.readUInt32LE(4);
  const jsonEnd = 16 + bytes.readUInt32LE(12);
  assert.ok(jsonEnd <= dataStart && dataStart <= bytes.length);
  const headerString = bytes.toString('utf8', 16, jsonEnd);
  const header = JSON.parse(headerString);
  const files = new Map();
  function walk(directory, prefix = '') {
    for (const [name, entry] of Object.entries(directory.files)) {
      const path = prefix + name;
      if (entry.files) walk(entry, `${path}/`);
      else if (entry.link) files.set(path, { link: entry.link });
      else {
        const start = dataStart + Number(entry.offset ?? 0);
        assert.ok(entry.unpacked || start + entry.size <= bytes.length);
        const data = entry.unpacked
          ? readFileSync(under(`${archive}.unpacked`, path))
          : bytes.subarray(start, start + entry.size);
        assert.equal(data.length, entry.size);
        files.set(path, { sha256: hash(data), unpacked: !!entry.unpacked, header: entry });
      }
    }
  }
  walk(header);
  return { files, headerHash: hash(headerString), dataHash: hash(bytes.subarray(dataStart)) };
}

function textEvidence(a, b) {
  const normalized = [a, b].map((bytes, index) => normalizeCheckout(bytes, ['a', 'b'][index]));
  const texts = [a, b].map((bytes) =>
    bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').split(/\r?\n/u),
  );
  const lines = [];
  for (
    let index = 0;
    index < Math.max(...texts.map((text) => text.length)) && lines.length < 4;
    index++
  ) {
    if (texts[0][index] !== texts[1][index])
      lines.push({
        line: index + 1,
        a: texts[0][index]?.slice(0, 320),
        b: texts[1][index]?.slice(0, 320),
      });
  }
  return {
    pathOnlyEqual: normalized[0].bytes.equals(normalized[1].bytes),
    pathReplacements: normalized.map((entry) => entry.replacements),
    lines,
  };
}

export function diagnose(root) {
  const samples = ['a', 'b'].map((sample) => {
    const evidence = join(root, `windows-repro-evidence-${sample}`);
    const environment = JSON.parse(readFileSync(join(evidence, 'environment.json')));
    assert.equal(environment.sourceCommit, sourceCommit);
    const files = new Map(
      JSON.parse(readFileSync(join(evidence, 'files.json'))).map((file) => [file.path, file]),
    );
    const payload = join(root, `windows-repro-payload-${sample}`);
    for (const [path, file] of files) {
      const bytes = readFileSync(under(payload, path));
      assert.equal(bytes.length, file.size, `Artifact size mismatch: ${sample}/${path}`);
      assert.equal(hash(bytes), file.sha256, `Artifact hash mismatch: ${sample}/${path}`);
    }
    return { environment, files, payload };
  });
  const paths = [...new Set(samples.flatMap((sample) => [...sample.files.keys()]))].sort();
  const differences = paths.filter(
    (path) => samples[0].files.get(path)?.sha256 !== samples[1].files.get(path)?.sha256,
  );
  const asars = samples.map((sample) =>
    inspectAsar(join(sample.payload, 'win-unpacked/resources/app.asar')),
  );
  const asarPaths = [...new Set(asars.flatMap((asar) => [...asar.files.keys()]))].sort();
  const asarChanges = asarPaths.flatMap((path) => {
    const [a, b] = asars.map((asar) => asar.files.get(path));
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    return [
      {
        path,
        present: [!!a, !!b],
        unpacked: [a?.unpacked, b?.unpacked],
        contentEqual: !!a && !!b && a.sha256 === b.sha256 && a.link === b.link,
      },
    ];
  });
  const binary = [];
  const text = [];
  for (const path of differences) {
    if (!samples.every((sample) => sample.files.has(path))) continue;
    if (
      !path.startsWith('win-unpacked/') ||
      !/\.(exe|node|vcxproj|filters|tlog|recipe|lastbuildstate)$/u.test(path)
    )
      continue;
    const bytes = samples.map((sample) => readFileSync(under(sample.payload, path)));
    if (/\.(node|exe)$/u.test(path))
      binary.push({
        path,
        ...comparePe(
          ...bytes,
          asars.map((asar) => asar.headerHash),
        ),
      });
    else text.push({ path, ...textEvidence(...bytes) });
  }
  return {
    sourceCommit,
    verifiedOriginalManifestHashes: true,
    environments: samples.map((sample) => sample.environment),
    differingPaths: differences.length,
    onlyA: differences.filter((path) => !samples[1].files.has(path)),
    onlyB: differences.filter((path) => !samples[0].files.has(path)),
    asar: {
      fileCounts: asars.map((asar) => asar.files.size),
      headerHashes: asars.map((asar) => asar.headerHash),
      rawDataEqual: asars[0].dataHash === asars[1].dataHash,
      changes: asarChanges,
    },
    binary,
    text,
    note: 'All normalization is in-memory diagnostic isolation, not a release acceptance rule. Original artifacts are never modified or executed.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(diagnose(resolve(process.argv[2])), null, 2));
}
