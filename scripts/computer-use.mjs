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

import { fileURLToPath } from 'node:url';

const [commandName] = process.argv.slice(2);
if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
  process.stdout.write('Usage: node scripts/computer-use.mjs prepare\n');
  process.exit(0);
}
if (commandName !== 'prepare' || process.argv.length > 3) {
  process.stderr.write(`Unknown Computer Use command: ${commandName}\n`);
  process.exit(1);
}
process.argv = [
  process.argv[0],
  fileURLToPath(new URL('./computer-use/prepare.mjs', import.meta.url)),
];
await import('./computer-use/prepare.mjs');
