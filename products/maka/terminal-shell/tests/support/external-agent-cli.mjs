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

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const [state, trace] = process.argv.slice(2);
const record = (method) =>
  appendFileSync(trace, JSON.stringify({ method, pid: process.pid }) + '\n');
record('launch');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const { id, method } = JSON.parse(line);
  record(method);
  if (id === undefined) return;
  const current = JSON.parse(readFileSync(state, 'utf8'));
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  if (method === 'initialize') reply({ userAgent: 'native-codex-fixture' });
  else if (method === 'account/read')
    reply({ account: current.signedIn ? { type: 'apiKey' } : null });
  else if (method === 'model/list') {
    if (current.modelsFail)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'fixture-external-discovery-failed' },
        }) + '\n',
      );
    else
      reply({
        data: [
          {
            id: 'external-model',
            displayName: 'External model',
            supportedReasoningEfforts: [{ reasoningEffort: 'vendor-deep' }],
            defaultReasoningEffort: 'vendor-deep',
          },
        ],
      });
  } else
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Metadata fixture does not execute prompts' },
      }) + '\n',
    );
});
lines.on('close', () => process.exit(0));
