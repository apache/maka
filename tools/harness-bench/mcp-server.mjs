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

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { parseBenchmarkCommand, replaceUnique, resolveWorkspaceFile, workspaceRoot } from './fixtures.mjs';

const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const execFileAsync = promisify(execFile);
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
const writeFlags = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
const tools = [
  ['bench_read_file', 'Read a UTF-8 file in the benchmark workspace.', ['path']],
  ['bench_write_file', 'Write a UTF-8 file in the benchmark workspace.', ['path', 'content']],
  ['bench_edit_file', 'Replace one exact match in a workspace file.', ['path', 'old_string', 'new_string']],
  ['bench_exec_shell', 'Run a fixed-line grep or literal printf in the benchmark workspace.', ['command']],
].map(([name, description, required]) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
    required,
    additionalProperties: false,
  },
}));

async function runShell(root, command) {
  const parsed = parseBenchmarkCommand(command);
  // Pass fixture values as arguments to fixed shell source.
  const args = parsed.kind === 'grep'
    ? ['exec grep -Fx -- "$1" "$2"', parsed.marker, await resolveWorkspaceFile(root, parsed.path)]
    : ['printf "%s" "$1"', parsed.text];
  const [source, ...operands] = args;
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', source, 'bench', ...operands], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    return { text: stdout + stderr, exitCode: 0 };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    return { text: error.stdout + error.stderr || error.message, exitCode: error.code };
  }
}

async function runTool(root, tool, args) {
  const schema = tools.find(({ name }) => name === tool)?.inputSchema;
  if (!schema) throw new Error(`Unknown benchmark tool ${tool}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== schema.required.length
      || schema.required.some((key) => !Object.hasOwn(args, key) || typeof args[key] !== 'string')) {
    throw new Error(`Expected string arguments: ${schema.required.join(', ')}`);
  }
  if (tool === 'bench_exec_shell') return runShell(root, args.command);
  const create = tool === 'bench_write_file';
  const file = await resolveWorkspaceFile(root, args.path, { create });
  if (create) {
    await writeFile(file, args.content, { flag: writeFlags | constants.O_CREAT });
    return { text: 'OK' };
  }
  const content = await readFile(file, { encoding: 'utf8', flag: readFlags });
  if (tool === 'bench_read_file') return { text: content };
  const edited = replaceUnique(content, args.old_string, args.new_string);
  await writeFile(file, edited, { flag: writeFlags });
  return { text: 'OK' };
}

async function callTool(root, audit, seq, tool, args) {
  const started = process.hrtime.bigint();
  let result;
  let ok;
  try {
    result = await runTool(root, tool, args);
    ok = result.exitCode === undefined || result.exitCode === 0;
  } catch (error) {
    result = { text: error.message };
    ok = false;
  }
  const ended = process.hrtime.bigint();
  // Measure UTF-8 tool arguments and text before JSON-RPC framing.
  const row = {
    seq,
    tool,
    ok,
    startedNs: started.toString(),
    endedNs: ended.toString(),
    durationNs: (ended - started).toString(),
    inputBytes: args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args)),
    outputBytes: Buffer.byteLength(result.text),
    ...(typeof args?.path === 'string' ? { path: args.path } : {}),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  };
  const line = JSON.stringify(row) + '\n';
  const { bytesWritten } = await audit.write(line);
  if (bytesWritten !== Buffer.byteLength(line)) throw new Error('Short write to MCP audit log');
  return { content: [{ type: 'text', text: result.text }], isError: !ok };
}

async function serve(root, audit, sequence) {
  const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  async function handleLine(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return errorResponse(null, -32700, 'Parse error');
    }
    const id = request?.id;
    const validId = typeof id === 'string' || Number.isFinite(id);
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (id !== undefined && !validId)) {
      return errorResponse(validId ? id : null, -32600, 'Invalid request');
    }
    if (id === undefined) return null;

    let result;
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        if (typeof requested !== 'string') {
          return errorResponse(id, -32602, 'Expected a protocolVersion');
        }
        result = {
          protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'harness-bench', version: '1.0.0' },
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools };
        break;
      case 'tools/call': {
        const name = request.params?.name;
        if (typeof name !== 'string') return errorResponse(id, -32602, 'Expected a tool name');
        result = await callTool(root, audit, ++sequence, name, request.params.arguments);
        break;
      }
      default:
        return errorResponse(id, -32601, 'Method not found');
    }
    return { jsonrpc: '2.0', id, result };
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  let failure;
  for await (const line of input) {
    if (failure) break;
    const operation = handleLine(line).then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch((error) => {
      failure ??= error;
      input.close();
      process.stdin.pause();
    });
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  }
  await Promise.all(pending);
  if (failure) throw failure;
}

async function main() {
  const { values } = parseArgs({
    options: { workspace: { type: 'string' }, 'audit-log': { type: 'string' }, 'resume-audit': { type: 'boolean' } },
  });
  const auditPath = values['audit-log'];
  if (!values.workspace || !isAbsolute(values.workspace) || !auditPath) {
    throw new Error('Usage: node mcp-server.mjs --workspace <absolute-directory> --audit-log <jsonl-path>');
  }
  const root = await workspaceRoot(values.workspace);
  const resume = values['resume-audit'];
  const audit = await open(
    auditPath,
    (resume ? constants.O_RDWR : constants.O_WRONLY) | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await audit.stat();
    if (!info.isFile() || info.nlink !== 1 || (!resume && info.size !== 0)) {
      throw new Error('MCP audit log must be a regular file with one link, empty unless resuming');
    }
    let sequence = 0;
    if (info.size) {
      const source = await audit.readFile('utf8');
      if (!source.endsWith('\n')) throw new Error('MCP audit log ends with a partial row');
      for (const line of source.slice(0, -1).split('\n')) {
        sequence = Math.max(sequence, JSON.parse(line).seq);
      }
    }
    await serve(root, audit, sequence);
  } finally {
    await audit.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
