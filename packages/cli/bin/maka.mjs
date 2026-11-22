#!/usr/bin/env node
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

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

try {
  const platform = process.platform;
  if (platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error('This Maka release requires glibc on Linux.');
  }
  const target = `${platform}-${process.arch}${platform === 'linux' ? '-gnu' : ''}`;
  const name = `@maka-agent/cli-${target}`;
  if (manifest.optionalDependencies?.[name] !== manifest.version) {
    throw new Error(`This Maka release does not include ${target}.`);
  }
  let packagePath;
  try {
    packagePath = require.resolve(`${name}/package.json`);
  } catch {
    throw new Error(
      `Missing ${name}@${manifest.version}. Reinstall with: npm install --global --include=optional @maka-agent/cli@${manifest.version}`,
    );
  }
  const native = JSON.parse(readFileSync(packagePath, 'utf8'));
  const executable = platform === 'win32' ? 'maka.exe' : 'maka';
  if (
    native.name !== name ||
    native.version !== manifest.version ||
    native.bin?.maka !== `bin/${executable}`
  ) {
    throw new Error('The installed native Maka package does not match this launcher.');
  }
  const child = spawn(join(dirname(packagePath), 'bin', executable), process.argv.slice(2), {
    stdio: 'inherit',
  });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(platform === 'win32' ? ['SIGBREAK'] : [])];
  const handlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        // Windows already broadcasts Ctrl+C/Break to the native child. kill(SIGINT)
        // would forcibly terminate it before its terminal cleanup can finish.
        if (platform !== 'win32' || (signal !== 'SIGINT' && signal !== 'SIGBREAK'))
          child.kill(signal);
      },
    ]),
  );
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once('error', (error) => {
    cleanup();
    console.error(`maka: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(`maka: ${error.message}`);
  process.exitCode = 1;
}
