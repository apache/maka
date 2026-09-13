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
import {
  formatCommandLine,
  parseCommandLine,
} from '../../renderer/mcp-command-line.js';

describe('MCP command line parsing', () => {
  it('splits on whitespace without shell interpretation', () => {
    assert.deepEqual(
      parseCommandLine('npx -y @modelcontextprotocol/server-filesystem /path/to/folder'),
      { ok: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'] },
    );
    assert.deepEqual(parseCommandLine('  uvx   mcp-science  timer '), {
      ok: true,
      command: 'uvx',
      args: ['mcp-science', 'timer'],
    });
    assert.deepEqual(parseCommandLine(''), { ok: true, command: '', args: [] });
    // $VAR and globs stay literal — this is tokenization, not a shell.
    assert.deepEqual(parseCommandLine('echo $HOME *.ts'), {
      ok: true,
      command: 'echo',
      args: ['$HOME', '*.ts'],
    });
  });

  it('groups quoted spans, including mid-token quotes', () => {
    assert.deepEqual(parseCommandLine('node "/my server/index.js"'), {
      ok: true,
      command: 'node',
      args: ['/my server/index.js'],
    });
    assert.deepEqual(parseCommandLine("npx --dir='/tmp/a b'"), {
      ok: true,
      command: 'npx',
      args: ['--dir=/tmp/a b'],
    });
    assert.deepEqual(parseCommandLine('run "say \\"hi\\"" done'), {
      ok: true,
      command: 'run',
      args: ['say "hi"', 'done'],
    });
  });

  it('reports unbalanced quotes instead of guessing', () => {
    assert.deepEqual(parseCommandLine('npx "unterminated'), {
      ok: false,
      error: 'unbalanced-quote',
    });
    assert.deepEqual(parseCommandLine("npx 'unterminated"), {
      ok: false,
      error: 'unbalanced-quote',
    });
  });

  it('round-trips config command and args through format and parse', () => {
    const cases: Array<[string, string[]]> = [
      ['npx', ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder']],
      ['node', ['/my server/index.js', '--label', 'a "quoted" value']],
      ['python', ['-c', 'print("x y")', 'C:\\my dir\\server.py']],
      ['uvx', []],
    ];
    for (const [command, args] of cases) {
      const parsed = parseCommandLine(formatCommandLine(command, args));
      assert.deepEqual(parsed, { ok: true, command, args });
    }
  });
});
