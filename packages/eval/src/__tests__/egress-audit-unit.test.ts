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
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  describeEgressAudit,
  EGRESS_AUDIT_ARTIFACT_PATH,
  readEgressAuditEvidence,
} from '../egress-audit.js';

type Summary = {
  readonly truncated: boolean;
  readonly policyErrorCount: number;
  readonly malformedLineCount: number;
};

const emptySummary: Summary = {
  truncated: false,
  policyErrorCount: 0,
  malformedLineCount: 0,
};

const auditCases: ReadonlyArray<{
  readonly label: string;
  readonly bytes: Buffer;
  readonly summary: Summary;
}> = [
  { label: 'empty audit', bytes: Buffer.alloc(0), summary: emptySummary },
  {
    label: 'truncation marker',
    bytes: records({ ruleId: 'tbench_domain' }, { ruleId: 'audit_truncated' }),
    summary: { ...emptySummary, truncated: true },
  },
  {
    label: 'repeated policy failures',
    bytes: records({ ruleId: 'policy_error' }, { ruleId: 'policy_error' }),
    summary: { ...emptySummary, policyErrorCount: 2 },
  },
  {
    label: 'malformed and scalar JSON',
    bytes: Buffer.from('{broken\n123\n"scalar"\n'),
    summary: { ...emptySummary, malformedLineCount: 3 },
  },
  {
    label: 'invalid UTF-8',
    bytes: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
    summary: { ...emptySummary, malformedLineCount: 1 },
  },
];

for (const scenario of auditCases) {
  test(`describes ${scenario.label} without changing trial attribution`, () => {
    assert.deepEqual(describeEgressAudit(scenario.bytes, true), {
      failureReason: null,
      artifacts: [artifact(scenario.bytes, scenario.summary)],
    });
  });
}

test('distinguishes a missing required journal from an optional journal', () => {
  assert.deepEqual(describeEgressAudit(undefined, true), {
    failureReason: 'egress audit log missing',
    artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  });
  assert.deepEqual(describeEgressAudit(undefined, false), {
    failureReason: null,
    artifacts: [],
  });
});

test('reads the trial journal through the canonical artifact path', async (t) => {
  const trial = await temporaryTrial(t);
  const path = join(trial, EGRESS_AUDIT_ARTIFACT_PATH);
  const bytes = records({ ruleId: 'policy_error' });
  await mkdir(join(trial, 'artifacts'), { recursive: true });
  await writeFile(path, bytes);

  assert.deepEqual(await readEgressAuditEvidence(trial, true), {
    failureReason: null,
    artifacts: [artifact(bytes, { ...emptySummary, policyErrorCount: 1 })],
  });
});

test('classifies absent and unreadable trial journals separately', async (t) => {
  const trial = await temporaryTrial(t);
  assert.equal(
    (await readEgressAuditEvidence(trial, true)).failureReason,
    'egress audit log missing',
  );

  const path = join(trial, EGRESS_AUDIT_ARTIFACT_PATH);
  await mkdir(path, { recursive: true });
  const unreadable = await readEgressAuditEvidence(trial, true);
  assert.match(unreadable.failureReason ?? '', /failed to read egress audit log/u);
  assert.deepEqual(unreadable.artifacts, [
    { kind: 'egress-audit-unreadable', path: EGRESS_AUDIT_ARTIFACT_PATH },
  ]);
});

test('does not touch the filesystem when audit collection is disabled', async () => {
  assert.deepEqual(await readEgressAuditEvidence('/path/that/does/not/exist', false), {
    failureReason: null,
    artifacts: [],
  });
});

function records(...items: readonly object[]): Buffer {
  return Buffer.from(items.map((item) => JSON.stringify(item)).join('\n') + '\n');
}

function artifact(bytes: Buffer, summary: Summary) {
  return {
    kind: 'egress-audit',
    path: EGRESS_AUDIT_ARTIFACT_PATH,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    ...summary,
  };
}

async function temporaryTrial(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-egress-audit-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
