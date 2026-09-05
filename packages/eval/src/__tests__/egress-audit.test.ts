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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileAttemptStore } from '../attempt-store.js';
import type { ExperimentSpec, JsonObject } from '../experiment.js';
import {
  collectEgressAuditArtifact,
  createHarborExecutor,
  EGRESS_AUDIT_ARTIFACT_PATH,
  EGRESS_AUDIT_DESTINATION,
} from '../harness-executor.js';
import { selectCellResult } from '../result.js';
import { runExperiment } from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
const EVAL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function inventory(
  audit: Buffer,
  truncated: boolean,
  policyErrorCount: number,
  malformedLineCount = 0,
) {
  return {
    missing: false,
    failureReason: null,
    artifacts: [
      {
        kind: 'egress-audit',
        path: EGRESS_AUDIT_ARTIFACT_PATH,
        bytes: audit.byteLength,
        sha256: `sha256:${createHash('sha256').update(audit).digest('hex')}`,
        truncated,
        policyErrorCount,
        malformedLineCount,
      },
    ],
  };
}

test('present egress audit is inventoried with a sha256 prefix', () => {
  const audit = Buffer.from('{"ruleId":"tbench_domain"}\n');
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 0));
});

test('an empty audit file is a clean trial, not a missing log', () => {
  const audit = Buffer.alloc(0);
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 0));
});

test('a missing expected audit is explicit evidence, not a clean pass', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, true), {
    missing: true,
    failureReason: 'egress audit log missing',
    artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  });
});

test('a truncated audit is recorded on the artifact, not judged as infra_failed', () => {
  const audit = Buffer.from(
    '{"ruleId":"tbench_domain"}\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\n',
  );
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, true, 0));
});

test('policy_error records are counted without changing attribution', () => {
  const audit = Buffer.from('{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\n');
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 1));
});

test('a policy_error followed by a later hit still counts the policy error', () => {
  const audit = Buffer.from(
    '{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\n{"ruleId":"tbench_domain","host":"tbench.ai","normalizedPath":"/tasks"}\n',
  );
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 1));
});

test('truncation and an earlier policy_error are both recorded', () => {
  const audit = Buffer.from(
    '{"ruleId":"policy_error"}\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\n',
  );
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, true, 1));
});

test('two policy_error records increment the count rather than pinning it at one', () => {
  const audit = Buffer.from(
    '{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\n{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\n',
  );
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 2));
});

test('unparseable and non-object lines are counted without changing attribution', () => {
  const audit = Buffer.from('{"ruleId":"tbench_domain"}\n{not json\ngarbage\n123\n"x"\n');
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 0, 4));
});

test('invalid UTF-8 is counted as a malformed line, not judged', () => {
  const audit = Buffer.from([0x7b, 0xff, 0x7d, 0x0a]);
  assert.deepEqual(collectEgressAuditArtifact(audit, true), inventory(audit, false, 0, 1));
});

test('trials without an egress proxy do not invent a missing-audit artifact', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, false), {
    missing: false,
    failureReason: null,
    artifacts: [],
  });
});

test('a missing expected audit through runAttempt is infra_failed and excluded', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected, trialConfig } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress audit log missing');
  assert.equal(selected, undefined);
  assert.deepEqual(trialConfig, [
    {
      source: '/opt/maka-egress-state/hits.jsonl',
      destination: EGRESS_AUDIT_DESTINATION,
      service: 'maka-eval-mitmproxy',
    },
  ]);
});

test('a truncated audit through runAttempt stays scored', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'truncated',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(attempts[0]?.result.score, 1);
  assert.equal(selected?.result.status, 'completed');
  assert.deepEqual(egressAuditArtifact(attempts[0]!.result.artifacts), {
    truncated: true,
    policyErrorCount: 0,
    malformedLineCount: 0,
  });
});

test('a policy_error audit through runAttempt stays scored', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'policy',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(selected?.result.status, 'completed');
  assert.deepEqual(egressAuditArtifact(attempts[0]!.result.artifacts), {
    truncated: false,
    policyErrorCount: 1,
    malformedLineCount: 0,
  });
});

test('a policy_error then a later hit through runAttempt stays scored', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'policy-then-hit',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(selected?.result.status, 'completed');
  assert.deepEqual(egressAuditArtifact(attempts[0]!.result.artifacts), {
    truncated: false,
    policyErrorCount: 1,
    malformedLineCount: 0,
  });
});

test('subject timeout still scores when the audit log is truncated', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'truncated',
    egressProxy: true,
    exceptionType: 'AgentTimeoutError',
    reward: 0,
  });
  assert.equal(attempts[0]?.result.status, 'subject_failed');
  assert.equal(attempts[0]?.result.score, 0);
  assert.equal(selected?.result.status, 'subject_failed');
  assert.deepEqual(egressAuditArtifact(attempts[0]!.result.artifacts), {
    truncated: true,
    policyErrorCount: 0,
    malformedLineCount: 0,
  });
});

test('a missing audit wins over a subject timeout', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: true,
    exceptionType: 'AgentTimeoutError',
    reward: 0,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress audit log missing');
  assert.equal(selected, undefined);
});

test('a missing audit wins over a missing reward', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: true,
    reward: null,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress audit log missing');
  assert.equal(selected, undefined);
});

test('an empty landed audit through runAttempt stays completed', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'empty',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(attempts[0]?.result.score, 1);
  assert.equal(selected?.result.status, 'completed');
});

test('an unreadable expected audit is infra_failed with the artifact path', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'unreadable',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.match(
    attempts[0]?.result.failureReason ?? '',
    new RegExp(`failed to read egress audit log .*/${EGRESS_AUDIT_ARTIFACT_PATH} \\(EISDIR\\)`),
  );
  assert.equal(selected, undefined);
  assert.deepEqual(
    attempts[0]?.result.artifacts.filter((artifact) =>
      String(artifact.kind).startsWith('egress-audit'),
    ),
    [{ kind: 'egress-audit-unreadable', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  );
});

test('trials without an egress proxy still complete when the audit file is absent', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected, trialConfig } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: false,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(selected?.result.status, 'completed');
  assert.equal(trialConfig, null);
});

function egressAuditArtifact(artifacts: readonly JsonObject[]) {
  const artifact = artifacts.find((item) => item.kind === 'egress-audit');
  assert.ok(artifact, 'expected an egress-audit artifact');
  return {
    truncated: artifact.truncated,
    policyErrorCount: artifact.policyErrorCount,
    malformedLineCount: artifact.malformedLineCount,
  };
}

async function runHarborTrial(options: {
  readonly auditMode:
    | 'missing'
    | 'empty'
    | 'truncated'
    | 'policy'
    | 'policy-then-hit'
    | 'unreadable';
  readonly egressProxy: boolean;
  readonly exceptionType?: string;
  readonly reward?: number | null;
}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-egress-audit-'));
  const executable = join(root, 'fake-python.mjs');
  const trialConfigPath = join(root, 'trial-config.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
let buffered = '';
const message = () => new Promise((resolve) => {
  const read = (chunk) => {
    buffered += chunk;
    const boundary = buffered.indexOf('\\n');
    if (boundary < 0) return;
    socket.off('data', read);
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    resolve(JSON.parse(line));
  };
  socket.on('data', read);
});
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'ready', instruction: 'solve', cwd: '/workspace' }) + '\\n');
await message();
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'executed', termination: 'exited', exitCode: 0, stdout: '', diagnostic: { category: 'none' } }) + '\\n');
await message();
const trialPath = new URL('./' + config.trial_name + '/', new URL('file://' + config.trials_dir + '/'));
await mkdir(trialPath, { recursive: true });
const rewardEnv = process.env.MAKA_TEST_REWARD;
const exceptionType = process.env.MAKA_TEST_EXCEPTION;
const result = {
  verifier_result: {
    rewards: rewardEnv === 'none' ? {} : { reward: Number(rewardEnv ?? '1') },
  },
  ...(exceptionType ? { exception_info: { exception_type: exceptionType } } : {}),
};
await writeFile(new URL('result.json', trialPath), JSON.stringify(result));
await writeFile(process.env.MAKA_TEST_TRIAL_CONFIG, JSON.stringify(config.artifacts ?? null));
const mode = process.env.MAKA_TEST_AUDIT_MODE;
if (mode !== 'missing') {
  const destination = config.artifacts?.[0]?.destination ?? 'egress-hits.jsonl';
  await mkdir(new URL('./artifacts/', trialPath), { recursive: true });
  const auditUrl = new URL('./artifacts/' + destination, trialPath);
  if (mode === 'unreadable') await mkdir(auditUrl);
  else if (mode === 'empty') await writeFile(auditUrl, '');
  else if (mode === 'truncated') {
    await writeFile(auditUrl, '{"ruleId":"tbench_domain"}\\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\\n');
  } else if (mode === 'policy') {
    await writeFile(auditUrl, '{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\\n');
  } else if (mode === 'policy-then-hit') {
    await writeFile(auditUrl, '{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\\n{"ruleId":"tbench_domain","host":"tbench.ai","normalizedPath":"/tasks"}\\n');
  }
}
socket.end();
`,
  );
  await chmod(executable, 0o755);
  const restore = setEnvironment({
    MAKA_TEST_PYTHON: executable,
    MAKA_TEST_TRIALS: root,
    MAKA_TEST_BUNDLE: EVAL_ROOT,
    MAKA_TEST_AUDIT_MODE: options.auditMode,
    MAKA_TEST_TRIAL_CONFIG: trialConfigPath,
    MAKA_TEST_REWARD: options.reward === null ? 'none' : String(options.reward ?? 1),
    ...(options.exceptionType ? { MAKA_TEST_EXCEPTION: options.exceptionType } : {}),
  });
  try {
    const store = new FileAttemptStore(join(root, 'attempts'));
    const results = await runExperiment({
      spec: experiment(),
      store,
      executor: createHarborExecutor(
        executorConfig(options.egressProxy),
        join(root, 'experiment.json'),
      ),
      subjects: [
        {
          kind: 'external',
          execute: async ({ context }) => {
            await context.execute({ command: '/bin/true', args: [], credentialEnvironment: {} });
            return {
              usage: null,
              costUsd: null,
              durationMs: 1,
              status: 'completed',
              failureReason: null,
              artifacts: [],
            };
          },
        },
      ],
    });
    const attempts = await store.list('task::1::external');
    return {
      attempts,
      selected: selectCellResult(attempts) ?? results.get('task::1::external'),
      trialConfig: JSON.parse(await readFile(trialConfigPath, 'utf8')) as unknown,
    };
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

function experiment(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1' as const,
    id: 'experiment',
    benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
    executor: { kind: 'harbor', config: executorConfig(false) },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'external', kind: 'external' as const, credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function executorConfig(egressProxy: boolean): JsonObject {
  return {
    frameworkVersion: '0.20.0',
    pythonPathEnv: 'MAKA_TEST_PYTHON',
    trialsRootEnv: 'MAKA_TEST_TRIALS',
    environment: {},
    preparationEnvironment: [
      'MAKA_TEST_AUDIT_MODE',
      'MAKA_TEST_TRIAL_CONFIG',
      'MAKA_TEST_REWARD',
      'MAKA_TEST_EXCEPTION',
    ],
    mounts: [],
    ...(egressProxy
      ? {
          egressProxy: {
            composeSourceEnv: 'MAKA_TEST_BUNDLE',
            composeRelativePath: 'harbor/docker-compose-egress-proxy.yaml',
            networkPolicyRelativePath: 'harbor/egress-proxy/network-policy',
            proxyUrl: 'http://maka-eval-mitmproxy:8080',
            allowedHost: 'maka-eval-mitmproxy',
            containerCaPath: '/opt/maka-egress/mitmproxy-ca-cert.pem',
          },
        }
      : {}),
  };
}

function setEnvironment(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
