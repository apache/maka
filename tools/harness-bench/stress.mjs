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

export const stressSuites = ['deep-grind', 'burst-flood', 'cliff-ramp', 'chaos-storm', 'firehose'];

export function generateStressScenario(suite, {
  turns = { 'deep-grind': 60, 'burst-flood': 6, 'cliff-ramp': 12, 'chaos-storm': 10, firehose: 25 }[suite],
  parallel = 16, outputBytes = suite === 'burst-flood' ? 262_144 : 16_384,
} = {}) {
  const spec = {
    version: 1, scenario: suite, seed: 42, fixture: suite + '-v1', track: 'native',
    fixtures: {}, steps: [], faults: [],
  };
  const marker = suite.toUpperCase().replaceAll('-', '_') + '_OK';
  const step = action => spec.steps.push({ id: 'turn-' + (spec.steps.length + 1), ...action });
  const file = (path, content) => {
    spec.fixtures[path] = { kind: 'file', path, content };
    return { readFile: { path, expectMarker: content.trimEnd() } };
  };
  const shell = (commandId, command) => {
    spec.fixtures[commandId] = { kind: 'command', command };
    return { shell: { commandId } };
  };
  const large = () => {
    spec.fixtures.output = { kind: 'largeOutput', pattern: 'benchmark 東京🦀 résumé 0123456789abcdef\n' };
    return { largeOutput: { fixture: 'output', bytes: outputBytes } };
  };
  const write = (path, content) => ({ writeFile: { path, content } });
  const edit = (path, old, replacement) => ({ editFile: { path, old, new: replacement } });

  if (suite === 'burst-flood') {
    for (let turn = 1; turn <= turns; turn++) {
      const actions = [large()];
      for (let i = 1; i < parallel; i++) {
        const id = turn + '-' + i;
        if (i % 4 === 1) actions.push(file('burst-input-' + id + '.txt', 'burst-source=' + id + '\n'));
        else if (i % 4 === 2) actions.push(write('burst-output-' + id + '.txt', 'burst-result=' + id + '\n'));
        else actions.push(shell('probe-' + id, "sleep 0.1 && printf 'burst-probe-" + id + "'"));
      }
      step({ parallelBatch: actions });
    }
  } else if (suite === 'firehose') {
    const payload = '東京🦀 café \\"quoted\\" \\n '.repeat(32);
    for (let turn = 1; turn <= turns; turn++) {
      step(write('firehose-' + turn + '.txt', turn + ' ' + payload + '\n'));
    }
  } else {
    let path;
    let current;
    for (let turn = 1; turn <= turns; turn++) {
      if (suite === 'chaos-storm' && turn === 4) {
        step({ badToolCall: { mode: 'wrongType', expectHandling: 'toolError' } });
      } else if (suite === 'chaos-storm' && turn === 5) {
        step({ unknownTool: { name: 'bench_unknown_chaos_tool', expectHandling: 'toolError' } });
      } else if (suite === 'deep-grind' && turn % 5 === 0) {
        step(large());
      } else if (turn === 1 || turn % (suite === 'deep-grind' ? 5 : 4) === 1) {
        path = 'state-' + turn + '.txt';
        current = 'state=seed-' + turn;
        step(file(path, current + '\n'));
      } else if (turn % (suite === 'deep-grind' ? 5 : 4) === 2) {
        current = 'state=written-' + turn;
        step(write(path, current + '\n'));
      } else if (turn % (suite === 'deep-grind' ? 5 : 4) === 3) {
        const next = 'state=edited-' + turn;
        const action = edit(path, current, next);
        current = next;
        // The disconnect publishes one complete call from this batch.
        step(suite === 'chaos-storm' && turn === 3 ? { parallelBatch: [
          action, file('chaos-disjoint.txt', 'chaos-disjoint\n'),
        ] } : action);
      } else {
        step(shell('verify-' + turn, "grep -Fx -- '" + current + "' '" + path + "'"));
      }
    }
  }
  if (suite === 'chaos-storm') {
    spec.faults = [
      { step: 'turn-1', attempt: 1, emit: 'http429' },
      { step: 'turn-2', attempt: 1, emit: 'http503' },
      { step: 'turn-3', attempt: 1, at: 'afterFirstCompleteCall', emit: 'disconnect' },
    ];
  }
  const text = suite === 'firehose' ? '東京🦀 café '.repeat(128) + marker : marker;
  spec.steps.push({ id: 'done', finalAnswer: { text, expectMarkers: [marker] } });
  return spec;
}

export async function climbCliff({ adapters, steps, runStage, signal }) {
  const rows = adapters.map(({ id }) => ({ harness: id, maxPassedLanes: null, breakingPoint: null, stages: [] }));
  for (const lanes of steps) {
    for (const row of rows) {
      if (signal.aborted) return rows;
      if (row.breakingPoint) continue;
      const stage = await runStage(row.harness, lanes);
      row.stages.push(stage);
      if (stage.passed) row.maxPassedLanes = lanes;
      else row.breakingPoint = stage;
    }
  }
  return rows.sort((a, b) => (b.maxPassedLanes ?? 0) - (a.maxPassedLanes ?? 0)
    || (b.breakingPoint?.lanes ?? Infinity) - (a.breakingPoint?.lanes ?? Infinity)
    || a.harness.localeCompare(b.harness));
}
