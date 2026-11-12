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
import test from 'node:test';
import { projectProcessGroups } from '../app/processGroups.ts';
import {
  projectTrajectory,
  trajectoryOverlaps,
  trajectoryTimeline,
  trajectoryZoom,
  visibleTrajectory,
} from '../app/trajectory.ts';

const order = (n) => ({ path: [n], itemIndex: 0 });
const row = (messageId, sequence, role, text, tool) => ({
  messageId,
  order: order(sequence),
  field: 'body',
  turnId: 'turn',
  role,
  text,
  tool,
});
const tool = (toolUseId, ancestorToolUseIds, sequence) => ({
  toolUseId,
  call: {
    name: toolUseId,
    ancestorToolUseIds,
    position: {
      kind: 'live',
      sequence,
      fact: '00000000-0000-4000-8000-000000000003',
      itemIndex: 0,
    },
  },
});
const request = (sequence, startedAt, finished) => ({
  turnKey: 'turn',
  request: {
    order: order(sequence),
    stepId: 'step',
    attemptId: `attempt-${sequence}`,
    modelId: 'model',
    purpose: 'main',
    startedAt,
    finished,
  },
});

test('the ledger keeps attempts without output and finds nested tools inside collapsed work', () => {
  const user = row('user', 1, 'user', 'Check this');
  const parent = row('parent', 5, 'tool_call', '', tool('script', [], 5));
  const child = row('child', 6, 'tool_call', '', tool('read', ['script'], 6));
  const output = row('output', 9, 'assistant', 'Found it');
  const projection = projectProcessGroups({
    rows: [user, parent, child, output],
    toolActivity: [],
    activeTurnId: 'turn',
  });
  const entries = projectTrajectory(projection, [
    request(2, 100, { at: 200, outcome: 'error' }),
    request(4, 220, { at: 300, outcome: 'success' }),
    request(8, 340, null),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    [
      'trajectory-turn',
      'trajectory-record',
      'trajectory-request',
      'trajectory-request',
      'trajectory-record',
      'trajectory-record',
      'trajectory-request',
      'trajectory-record',
    ],
  );
  const script = entries.find((entry) => entry.toolKey?.includes('script'));
  const read = entries.find((entry) => entry.toolKey?.includes('read'));
  const collapsed = new Set([script.toolKey]);
  assert.ok(!visibleTrajectory(entries, new Set(), collapsed).includes(read));
  const matches = visibleTrajectory(
    entries,
    new Set(['turn']),
    collapsed,
    (entry) => entry === read,
  );
  assert.ok(matches.includes(read));
  assert.ok(matches.includes(script));
  assert.equal(
    matches.find((entry) => entry.kind === 'trajectory-request').request.attemptId,
    'attempt-4',
  );

  const timeline = trajectoryTimeline(entries);
  assert.equal(timeline.requests[0].outcome, 'error');
  assert.equal(timeline.requests[0].end, 200);
  assert.equal(timeline.requests.at(-1).end, undefined);
  assert.deepEqual(timeline.domain, { start: 100, end: 340 });
});

test('a zoomed time window keeps records that span either edge', () => {
  const domain = { start: 100, end: 1_000 };
  const zoomed = trajectoryZoom(domain, 160, 200);
  assert.deepEqual(zoomed, { start: 100, end: 300 });
  assert.ok(trajectoryOverlaps(zoomed, 80, 110));
  assert.ok(trajectoryOverlaps(zoomed, 250, 320));
  assert.ok(!trajectoryOverlaps(zoomed, 320));
  assert.deepEqual(trajectoryZoom(domain, 160, 1_000), domain);
});
