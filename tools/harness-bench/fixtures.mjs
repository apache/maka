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

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW;

export async function loadScenario(scenarioPath) {
  const source = await readFile(scenarioPath, 'utf8');
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(`Invalid scenario JSON at ${scenarioPath}`, { cause });
  }
}

export async function workspaceRoot(workspaceDir) {
  if (!(await lstat(workspaceDir)).isDirectory()) {
    throw new Error(`Workspace root must be a directory: ${workspaceDir}`);
  }
  return realpath(workspaceDir);
}

export async function resolveWorkspaceFile(root, path, { create = false } = {}) {
  const parts = path.split('/');
  if (/[\0\r\n\\:]/.test(path) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid workspace-relative file path ${JSON.stringify(path)}`);
  }
  const name = parts.pop();
  let parent = root;
  for (const part of parts) {
    parent = join(parent, part);
    if (create) {
      try {
        await mkdir(parent);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (!(await lstat(parent)).isDirectory()) {
      throw new Error(`Workspace path traverses a non-directory or symlink: ${path}`);
    }
  }
  const file = join(parent, name);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Workspace path must be a regular file with one link: ${path}`);
    }
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error;
  }
  return file;
}

export function replaceUnique(content, old, replacement) {
  const index = content.indexOf(old);
  if (!old || old === replacement || index < 0 || content.includes(old, index + 1)) {
    throw new Error('Edit requires exactly one occurrence of a nonempty, changing match');
  }
  return content.slice(0, index) + replacement + content.slice(index + old.length);
}

export function parseBenchmarkCommand(command) {
  const grep = /^grep -Fx -- '([^'\0\r\n]*)' (?:'([^'\0\r\n]+)'|([\w./-]+))$/.exec(command);
  if (grep?.[0] === command) {
    return { kind: 'grep', marker: grep[1], path: grep[2] ?? grep[3] };
  }
  const printf = /^printf (?:'([^'%\\\0\r\n]*)'|([\w.]+))$/.exec(command);
  if (printf?.[0] === command) {
    return { kind: 'printf', text: printf[1] ?? printf[2] };
  }
  throw new Error("Expected grep -Fx -- 'line' 'path' or printf with one literal argument");
}

function fixtureFiles(spec) {
  return new Map(
    Object.values(spec.fixtures ?? {})
      .filter((fixture) => fixture.kind === 'file')
      .map(({ path, content }) => [path, content]),
  );
}

export async function materializeWorkspace(spec, workspaceDir) {
  await mkdir(workspaceDir, { recursive: true });
  const root = await workspaceRoot(workspaceDir);
  for (const [path, content] of fixtureFiles(spec)) {
    const file = await resolveWorkspaceFile(root, path, { create: true });
    await writeFile(file, content, { flag: 'wx' });
  }
  const manifest = new Map();
  async function collect(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        await collect(join(directory, entry.name), path + '/');
      } else {
        const file = await resolveWorkspaceFile(root, path);
        manifest.set(path, sha256(await readFile(file, { flag: readFlags })));
      }
    }
  }
  await collect(root, '');
  return manifest;
}

function expectedMcpCall(spec, contents, action) {
  const call = (tool, args, output, extra) => ({
    tool,
    path: args.path,
    inputBytes: Buffer.byteLength(JSON.stringify(args)),
    outputBytes: Buffer.byteLength(output),
    ...extra,
  });
  if (action.readFile) {
    const { path } = action.readFile;
    return call('bench_read_file', { path }, contents.get(path));
  }
  if (action.writeFile) {
    const { path, content } = action.writeFile;
    return call('bench_write_file', { path, content }, 'OK');
  }
  if (action.editFile) {
    const { path, old, new: replacement } = action.editFile;
    return call('bench_edit_file', { path, old_string: old, new_string: replacement }, 'OK');
  }
  if (action.shell) {
    const { command } = spec.fixtures[action.shell.commandId];
    const parsed = parseBenchmarkCommand(command);
    let output = parsed.text;
    if (parsed.kind === 'grep') {
      const content = contents.get(parsed.path);
      if (content === undefined) throw new Error(`No scenario content for grep target ${parsed.path}`);
      const lines = content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      output = lines.filter((line) => line === parsed.marker).map((line) => line + '\n').join('');
    }
    return call('bench_exec_shell', { command }, output, { exitCode: 0 });
  }
  if (action.finalAnswer) return null;
  throw new Error('Shared MCP proof requires benchmark file and shell actions');
}

function expectedWorkspace(spec, initialManifest, errors) {
  const contents = fixtureFiles(spec);
  for (const [path, content] of contents) {
    if (initialManifest.get(path) !== sha256(content)) {
      errors.push(`Initial fixture hash mismatch: ${path}`);
    }
  }
  const mcpGroups = [];
  for (const step of spec.steps) {
    const changes = new Map();
    const calls = [];
    for (const action of step.parallelBatch ?? [step]) {
      if (spec.track === 'sharedMcp') {
        const call = expectedMcpCall(spec, contents, action);
        if (call) calls.push(call);
      }
      if (action.writeFile) {
        const { path, content } = action.writeFile;
        changes.set(path, content);
      }
      if (action.editFile) {
        const { path, old, new: replacement } = action.editFile;
        changes.set(path, replaceUnique(contents.get(path), old, replacement));
      }
    }
    if (calls.length) mcpGroups.push({ step: step.id, calls });
    for (const [path, content] of changes) contents.set(path, content);
  }
  const hashes = new Map(initialManifest);
  for (const [path, content] of contents) hashes.set(path, sha256(content));
  return { hashes, mcpGroups };
}

function validAuditRow(row) {
  const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!row || !nonnegativeInteger(row.seq) || row.seq < 1
      || typeof row.tool !== 'string' || typeof row.ok !== 'boolean'
      || !nonnegativeInteger(row.inputBytes) || !nonnegativeInteger(row.outputBytes)
      || ![row.startedNs, row.endedNs, row.durationNs]
        .every((value) => typeof value === 'string' && /^\d+$/.test(value))) {
    return false;
  }
  return BigInt(row.endedNs) - BigInt(row.startedNs) === BigInt(row.durationNs);
}

async function verifyMcpAudit(path, groups, errors) {
  const expectedCalls = groups.reduce((count, { calls }) => count + calls.length, 0);
  const proof = { expectedCalls, calls: 0, inputBytes: 0, outputBytes: 0 };
  if (!path) {
    errors.push('Shared MCP track requires an audit log');
    return proof;
  }
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    errors.push(`Cannot read MCP audit log: ${error.message}`);
    return proof;
  }
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  proof.calls = lines.length;
  const rows = [];
  for (const [index, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      errors.push(`Invalid MCP audit JSON on line ${index + 1}: ${error.message}`);
      continue;
    }
    if (!validAuditRow(row)) {
      errors.push(`Invalid MCP audit fields on line ${index + 1}`);
      continue;
    }
    rows.push(row);
    proof.inputBytes += row.inputBytes;
    proof.outputBytes += row.outputBytes;
  }
  if (proof.calls !== expectedCalls) {
    errors.push(`Expected ${expectedCalls} MCP calls, got ${proof.calls}`);
  }
  rows.sort((a, b) => a.seq - b.seq);
  if (rows.some((row, index) => row.seq !== index + 1)) {
    errors.push('MCP audit sequence is discontinuous');
  }
  let offset = 0;
  for (const { step, calls } of groups) {
    const unmatched = rows.slice(offset, offset + calls.length);
    offset += calls.length;
    for (const expected of calls) {
      const index = unmatched.findIndex((row) => row.ok
        && row.tool === expected.tool && row.path === expected.path
        && row.exitCode === expected.exitCode
        && row.inputBytes === expected.inputBytes && row.outputBytes === expected.outputBytes);
      if (index < 0) {
        errors.push(`MCP audit mismatch at ${step}: expected ${JSON.stringify(expected)}`);
      } else {
        unmatched.splice(index, 1);
      }
    }
  }
  return proof;
}

export async function verifyWorkspace(spec, { workspaceDir, initialManifest, agentOutputText, mcpAuditPath }) {
  const errors = [];
  const { hashes, mcpGroups } = expectedWorkspace(spec, initialManifest, errors);
  let root;
  try {
    root = await workspaceRoot(workspaceDir);
  } catch (error) {
    errors.push(`Cannot verify workspace root: ${error.message}`);
  }
  const files = [];
  for (const [path, expectedSha256] of hashes) {
    let actualSha256 = null;
    if (root) {
      try {
        const file = await resolveWorkspaceFile(root, path);
        actualSha256 = sha256(await readFile(file, { flag: readFlags }));
        if (actualSha256 !== expectedSha256) errors.push(`Final file hash mismatch: ${path}`);
      } catch (error) {
        errors.push(`Cannot verify workspace file ${path}: ${error.message}`);
      }
    }
    files.push({ path, expectedSha256, actualSha256 });
  }
  const markers = spec.steps.at(-1).finalAnswer.expectMarkers ?? [];
  const missingMarkers = markers.filter((marker) => !agentOutputText.includes(marker));
  for (const marker of missingMarkers) errors.push(`Missing final answer marker: ${marker}`);
  const mcpAudit = spec.track === 'sharedMcp' ? await verifyMcpAudit(mcpAuditPath, mcpGroups, errors) : null;
  return { passed: errors.length === 0, errors, files, missingMarkers, mcpAudit };
}
