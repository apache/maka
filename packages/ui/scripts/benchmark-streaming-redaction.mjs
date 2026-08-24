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
import { performance } from 'node:perf_hooks';
import { applyAssistantDelta } from '../dist/assistant-stream.js';
import { redactSecrets } from '../dist/redact.js';

const line = 'A realistic streamed paragraph contains prose, code, and api_key=ordinary-short-value.';
const scenarios = [
  { name: 'newline-rich', input: `${line}\n`.repeat(800) },
  { name: 'no-newline', input: `${line} `.repeat(800) },
];
const deltaSize = 8;

function wholeText(input) {
  let source = '';
  let displayed = '';
  for (let offset = 0; offset < input.length; offset += deltaSize) {
    source += input.slice(offset, offset + deltaSize);
    displayed = redactSecrets(source);
  }
  return displayed;
}

function incremental(input) {
  let displayed = '';
  let state;
  for (let offset = 0; offset < input.length; offset += deltaSize) {
    const result = applyAssistantDelta(
      displayed,
      input.slice(offset, offset + deltaSize),
      {
        locale: 'en',
        ...(state === undefined ? {} : { redactionState: state }),
      },
    );
    displayed = result.text;
    state = result.redactionState;
  }
  return displayed;
}

function measure(run) {
  const started = performance.now();
  const output = run();
  return { output, milliseconds: performance.now() - started };
}

function median(runs, run) {
  const samples = [];
  let output;
  for (let index = 0; index < runs; index += 1) {
    const measured = measure(run);
    output = measured.output;
    samples.push(measured.milliseconds);
  }
  samples.sort((a, b) => a - b);
  return { output, milliseconds: samples[Math.floor(samples.length / 2)] };
}

const results = scenarios.map(({ name, input }) => {
  wholeText(input);
  incremental(input);
  const baseline = median(3, () => wholeText(input));
  const candidate = median(3, () => incremental(input));
  assert.equal(candidate.output, baseline.output);
  return {
    name,
    inputChars: input.length,
    deltaSize,
    deltas: Math.ceil(input.length / deltaSize),
    candidatePath: 'applyAssistantDelta',
    wholeTextMs: Number(baseline.milliseconds.toFixed(2)),
    incrementalMs: Number(candidate.milliseconds.toFixed(2)),
    speedup: Number((baseline.milliseconds / candidate.milliseconds).toFixed(2)),
  };
});

console.log(JSON.stringify(results, null, 2));
