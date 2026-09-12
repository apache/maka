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
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const [image, version] = process.argv.slice(2);
assert.ok(image && version, 'Usage: node scripts/smoke-cli-container.mjs <image> <version>');
const volume = `maka-container-smoke-${randomUUID()}`;
const container = `maka-container-smoke-${randomUUID()}`;
const mount = ['--mount', `type=volume,src=${volume},dst=/home/node/.config/Maka`];
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}
function node(code) {
  return docker(['run', '--rm', ...mount, '--entrypoint', 'node', image, '-e', code]);
}

assert.equal(docker(['run', '--rm', image, '--version']).trim(), version);
assert.match(docker(['run', '--rm', image, '--help']), /maka run/);
assert.match(docker(['run', '--rm', image, 'run', '--help']), /Usage:/);
const config = JSON.parse(docker(['image', 'inspect', image]))[0].Config;
assert.deepEqual(config.Entrypoint, ['/usr/bin/tini', '--', 'maka']);
assert.ok(!config.Cmd || config.Cmd.length === 0, 'Default invocation must open the TUI');
assert.equal(config.WorkingDir, '/workspace');
assert.equal(config.User, 'node');

docker(['volume', 'create', volume]);
try {
  assert.equal(
    node(`
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    assert.notEqual(process.getuid(), 0);
    assert.ok(process.report.getReport().header.glibcVersionRuntime);
    for (const cmd of ['git', 'rg', 'python3', 'ssh']) {
      execFileSync('sh', ['-c', 'command -v ' + cmd]);
    }
    require('node:fs').writeFileSync('/home/node/.config/Maka/container-smoke', 'persisted');
    console.log('runtime-ok');
  `).trim(),
    'runtime-ok',
  );
  assert.equal(
    node(`
    console.log(require('node:fs').readFileSync('/home/node/.config/Maka/container-smoke', 'utf8'));
  `).trim(),
    'persisted',
  );
  // Exercise the shipped native PTY and actual first-run TUI without model credentials.
  const output = docker([
    'run',
    '--rm',
    '--name',
    container,
    ...mount,
    '--entrypoint',
    'node',
    image,
    '-e',
    `
    const pty = require('/usr/local/lib/node_modules/maka-agent/node_modules/node-pty');
    const child = pty.spawn('maka', [], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: '/workspace', env: process.env,
    });
    let ready = false;
    let output = '';
    const timer = setTimeout(() => { console.error(output); child.kill(); process.exit(1); }, 30000);
    child.onData((data) => {
      output += data;
      if (!ready && output.includes('Type a message to start') && output.includes('/setup')) {
        ready = true;
        console.log('TUI_READY');
        child.kill();
      }
    });
    child.onExit(() => { clearTimeout(timer); process.exit(ready ? 0 : 1); });
  `,
  ]);
  assert.match(output, /TUI_READY/);
} finally {
  // A timed-out Docker client can leave its container running.
  try {
    docker(['rm', '--force', container]);
  } catch {
    /* Already removed by --rm. */
  }
  docker(['volume', 'rm', volume]);
}
console.log(`Container smoke passed: ${image} (${version})`);
