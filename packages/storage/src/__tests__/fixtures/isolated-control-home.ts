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

// Test-process preload: isolate account control and ownership namespaces,
// including forked and spawned children. Never imported by production entry points.
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, mock } from 'node:test';

const inherited = process.env.MAKA_TEST_CONTROL_HOME;
const isolatedHome = inherited ?? (await mkdtemp(join(os.tmpdir(), 'maka-control-home-')));
const original = os.userInfo();
mock.method(os, 'userInfo', () => ({ ...original, homedir: isolatedHome }));
syncBuiltinESMExports();
process.env.MAKA_TEST_CONTROL_HOME = isolatedHome;
const preload = import.meta.url;
if (!process.execArgv.includes(preload)) process.execArgv.push('--import', preload);
const previousNodeOptions = process.env.NODE_OPTIONS;
const preloadOption = `--import=${JSON.stringify(import.meta.url)}`;
if (!process.env.NODE_OPTIONS?.includes(preloadOption)) {
  process.env.NODE_OPTIONS = [previousNodeOptions, preloadOption].filter(Boolean).join(' ');
}
if (!inherited) {
  after(async () => {
    await rm(isolatedHome, { recursive: true, force: true });
    delete process.env.MAKA_TEST_CONTROL_HOME;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });
}
