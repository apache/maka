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

// Paid, real-model regression; run explicitly after compiling Desktop main.
import { readFile, writeFile } from 'node:fs/promises';
import { evaluateVoice } from '../../apps/desktop/dist/main/workhub-voice-jev.js';
const cases = JSON.parse(await readFile(new URL('./jev-cases.json', import.meta.url), 'utf8'));
const results = [];
for (let repeat = 0; repeat < 3; repeat++)
  for (const c of cases) {
    const start = Date.now();
    try {
      const result = await evaluateVoice(c.input, AbortSignal.timeout(15000));
      const pass =
        result.gap === c.expected.gap &&
        Object.entries(c.expected.items).every(([id, value]) => result.items[id] === value);
      const row = { ...c, repeat, ms: Date.now() - start, result, pass };
      results.push(row);
      console.log(JSON.stringify({ name: c.name, repeat, ms: row.ms, result, pass }));
    } catch (error) {
      results.push({ ...c, repeat, ms: Date.now() - start, error: String(error), pass: false });
      break;
    }
  }
await writeFile(
  process.argv[2] || '/tmp/maka-jev-scenarios-results.json',
  JSON.stringify(results, null, 2),
);
console.log(
  JSON.stringify({ passed: results.filter((r) => r.pass).length, total: results.length }),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
