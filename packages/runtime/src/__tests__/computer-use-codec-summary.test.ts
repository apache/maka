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

// What a failed Computer Use call tells the model.
//
// The code alone is not a recovery instruction. `unsupported_action` covers a
// key name the host could not parse, an element that does not offer the action,
// and an action this executor has no method for — three different next moves.
// The executor writes the sentence that says which; it used to be dropped.
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize, summarizeEvidence } from '../computer-use-codec.js';

test('a refusal that declares itself app-text-free reaches the model with its sentence', () => {
  const text = summarize(
    { type: 'press_key' },
    {
      outcome: {
        ok: false,
        error: 'unsupported_action',
        message: 'say Backspace or ForwardDelete rather than delete',
        messageIsAppTextFree: true,
      },
    },
  );
  assert.match(text, /unsupported_action/);
  // Without this the model reads only the code, and the tool description tells
  // it that code means keyboard input is off in this build — so one mistyped
  // key name teaches it the keyboard does not work.
  assert.match(text, /Backspace or ForwardDelete/);
});

test('a refusal that does not declare itself stays a bare code', () => {
  // Absent means withheld. A backend that cannot promise its diagnostics are
  // free of window titles and screen text is treated as one that leaks them.
  const text = summarize(
    { type: 'click_element' },
    {
      outcome: {
        ok: false,
        error: 'target_missing',
        message: 'no window titled "Q3 salary review.numbers"',
      },
    },
  );
  assert.match(text, /target_missing/);
  assert.doesNotMatch(text, /salary/);
});

test('a dispatch that changed nothing does not start with the word ok', () => {
  // Measured on a real run: `cmd+p` came back `ok ... suspected_noop` seven
  // times and the model sent it seven times, then switched to `key` and sent it
  // twice more; another model did the same four times with `ctrl+f2`. It was
  // not guessing at the schema — it read `ok` and believed it.
  const text = summarize(
    { type: 'press_key' },
    {
      outcome: {
        ok: true,
        tier: 'coordinate-background',
        verified: false,
        evidence: { path: 'cg_event_pid', effect: 'suspected_noop' },
      },
    },
  );
  assert.match(text, /delivered but nothing changed/);
  assert.doesNotMatch(text, /computer\.press_key ok/);
});

test('a dispatch that did change something still reads as ok', () => {
  const text = summarize(
    { type: 'set_value' },
    {
      outcome: {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax_attribute', effect: 'confirmed' },
      },
    },
  );
  assert.match(text, /computer\.set_value ok/);
});

test('the model face carries no dispatch route, tier, or internal reason', () => {
  // Three tokens the model cannot act on: `cg_event_pid` is which macOS
  // mechanism carried the key, `coordinate-background` is an executor tier, and
  // `dispatch.key` is the executor's own RPC method. No argument selects any of
  // them. On a real run they were on every line — 23 in one scenario, 17 in
  // another — and not one call changed because of them.
  const text = summarize(
    { type: 'press_key' },
    {
      outcome: {
        ok: true,
        tier: 'coordinate-background',
        verified: false,
        evidence: { path: 'cg_event_pid', effect: 'unverifiable', reason: 'dispatch.key:none' },
      },
    },
  );
  assert.doesNotMatch(text, /path=/);
  assert.doesNotMatch(text, /reason=/);
  assert.doesNotMatch(text, /cg_event_pid|dispatch\.key/);
  assert.doesNotMatch(text, /coordinate-background/);
  // What is left is what the model decides a retry on.
  assert.match(text, /effect=unverifiable/);
  assert.match(text, /verified=false/);
});

test('a refusal keeps its effect and drops the route', () => {
  const text = summarize(
    { type: 'scroll_element' },
    {
      outcome: {
        ok: false,
        error: 'target_changed',
        message: 'the element left the window',
        evidence: { path: 'ax_action', effect: 'suspected_noop', reason: 'dispatch.element:none' },
      },
    },
  );
  assert.match(text, /target_changed/);
  assert.match(text, /effect=suspected_noop/);
  assert.doesNotMatch(text, /ax_action|dispatch\.element/);
});

test('the host face keeps every field an operator reads a trace back with', () => {
  const evidence = {
    path: 'cg_event_pid',
    effect: 'unverifiable' as const,
    reason: 'dispatch.key:none',
  };
  const line = summarize(
    { type: 'press_key' },
    { outcome: { ok: true, tier: 'coordinate-background', verified: false, evidence } },
    'host',
  );
  assert.match(line, /path=cg_event_pid/);
  assert.match(line, /reason=dispatch\.key:none/);
  assert.match(line, /via coordinate-background/);
  assert.match(summarizeEvidence(evidence, 'host'), /path=cg_event_pid/);
  assert.doesNotMatch(summarizeEvidence(evidence), /path=/);
});

test('the host face still refuses free text where a token was promised', () => {
  // `reason` is the executor's field and an executor that writes a window title
  // into it must not have it stored either.
  const line = summarizeEvidence(
    {
      path: 'cgevent',
      effect: 'unverifiable',
      reason: 'window Secret Draft, api_key=super-secret',
    },
    'host',
  );
  assert.match(line, /path=cgevent/);
  assert.doesNotMatch(line, /Secret Draft|super-secret/);
});
