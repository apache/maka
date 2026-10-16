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
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileAttemptStore } from '../attempt-store.js';
import { EGRESS_AUDIT_DESTINATION } from '../egress-audit.js';
import type { ExperimentSpec, JsonObject } from '../experiment.js';
import { createHarborExecutor } from '../harness-executor.js';
import { type EvalResultStatus, selectCellResult } from '../result.js';
import { runExperiment } from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
const EVAL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

type AuditMode = 'missing' | 'empty' | 'truncated' | 'policy' | 'unreadable';

type Scenario = {
  readonly label: string;
  readonly mode: AuditMode;
  readonly proxy: boolean;
  readonly expectedStatus: EvalResultStatus;
  readonly failure?: RegExp;
  readonly auditField?: readonly ['truncated' | 'policyErrorCount', boolean | number];
  readonly exception?: string;
  readonly reward?: number | null;
};

const scenarios: readonly Scenario[] = [
  {
    label: 'missing required audit excludes the attempt',
    mode: 'missing',
    proxy: true,
    expectedStatus: 'infra_failed',
    failure: /egress audit log missing/u,
  },
  {
    label: 'truncated audit stays scored and visible',
    mode: 'truncated',
    proxy: true,
    expectedStatus: 'completed',
    auditField: ['truncated', true],
  },
  {
    label: 'policy failure stays scored and visible',
    mode: 'policy',
    proxy: true,
    expectedStatus: 'completed',
    auditField: ['policyErrorCount', 1],
  },
  {
    label: 'subject timeout retains subject attribution when evidence exists',
    mode: 'truncated',
    proxy: true,
    exception: 'AgentTimeoutError',
    reward: 0,
    expectedStatus: 'subject_failed',
  },
  {
    label: 'missing audit outranks a subject timeout',
    mode: 'missing',
    proxy: true,
    exception: 'AgentTimeoutError',
    reward: 0,
    expectedStatus: 'infra_failed',
    failure: /egress audit log missing/u,
  },
  {
    label: 'missing audit outranks a missing reward',
    mode: 'missing',
    proxy: true,
    reward: null,
    expectedStatus: 'infra_failed',
    failure: /egress audit log missing/u,
  },
  {
    label: 'empty audit proves a clean trial',
    mode: 'empty',
    proxy: true,
    expectedStatus: 'completed',
  },
  {
    label: 'unreadable audit is infrastructure failure',
    mode: 'unreadable',
    proxy: true,
    expectedStatus: 'infra_failed',
    failure: /failed to read egress audit log/u,
  },
  {
    label: 'proxy-free trial has no audit obligation',
    mode: 'missing',
    proxy: false,
    expectedStatus: 'completed',
  },
];

for (const scenario of scenarios) {
  test(scenario.label, { timeout: 10_000 }, async (t) => {
    const outcome = await executeScenario(t, scenario);
    const attempt = outcome.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.result.status, scenario.expectedStatus);
    if (scenario.failure) assert.match(attempt.result.failureReason ?? '', scenario.failure);
    assert.equal(
      outcome.selected?.result.status,
      scenario.expectedStatus === 'infra_failed' ? undefined : scenario.expectedStatus,
    );

    const audit = attempt.result.artifacts.find((item) => item.kind === 'egress-audit');
    if (scenario.proxy && scenario.mode !== 'missing' && scenario.mode !== 'unreadable') {
      assert.ok(audit);
      if (scenario.auditField) assert.equal(audit[scenario.auditField[0]], scenario.auditField[1]);
    } else {
      assert.equal(audit, undefined);
    }

    assert.deepEqual(
      outcome.trialArtifacts,
      scenario.proxy
        ? [
            {
              source: '/opt/maka-egress-state/hits.jsonl',
              destination: EGRESS_AUDIT_DESTINATION,
              service: 'maka-eval-mitmproxy',
            },
          ]
        : null,
    );
  });
}

async function executeScenario(t: test.TestContext, scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'maka-egress-harness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'trial-probe.mjs');
  const capturedArtifacts = join(root, 'captured-artifacts.json');
  await writeFile(executable, trialProbe());
  await chmod(executable, 0o755);

  const restore = installEnvironment({
    MAKA_TEST_PYTHON: executable,
    MAKA_TEST_TRIALS: root,
    MAKA_TEST_BUNDLE: EVAL_ROOT,
    MAKA_TEST_AUDIT_MODE: scenario.mode,
    MAKA_TEST_CAPTURED_ARTIFACTS: capturedArtifacts,
    MAKA_TEST_REWARD: scenario.reward === null ? 'none' : String(scenario.reward ?? 1),
    MAKA_TEST_EXCEPTION: scenario.exception ?? '',
  });
  t.after(restore);

  const store = new FileAttemptStore(join(root, 'attempts'));
  const results = await runExperiment({
    spec: experiment(),
    store,
    executor: createHarborExecutor(executorConfig(scenario.proxy), join(root, 'experiment.json')),
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
    trialArtifacts: JSON.parse(await readFile(capturedArtifacts, 'utf8')) as unknown,
  };
}

function experiment(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'experiment',
    benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
    executor: { kind: 'harbor', config: executorConfig(false) },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'external', kind: 'external', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function executorConfig(proxy: boolean): JsonObject {
  return {
    frameworkVersion: '0.20.0',
    pythonPathEnv: 'MAKA_TEST_PYTHON',
    trialsRootEnv: 'MAKA_TEST_TRIALS',
    environment: {},
    preparationEnvironment: [
      'MAKA_TEST_AUDIT_MODE',
      'MAKA_TEST_CAPTURED_ARTIFACTS',
      'MAKA_TEST_REWARD',
      'MAKA_TEST_EXCEPTION',
    ],
    mounts: [],
    ...(proxy
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

function installEnvironment(values: Readonly<Record<string, string>>): () => void {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function trialProbe(): string {
  return `#!/usr/bin/env node
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = createConnection(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
const messages = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
await once(socket, 'connect');
const send = (message) => socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, ...message }) + '\\n');
send({ kind: 'ready', instruction: 'solve', cwd: '/workspace' });
await messages.next();
send({ kind: 'executed', termination: 'exited', exitCode: 0, stdout: '', diagnostic: { category: 'none' } });
await messages.next();

const trial = new URL(config.trial_name + '/', new URL('file://' + config.trials_dir + '/'));
await mkdir(trial, { recursive: true });
const reward = process.env.MAKA_TEST_REWARD;
const exception = process.env.MAKA_TEST_EXCEPTION;
await writeFile(new URL('result.json', trial), JSON.stringify({
  verifier_result: { rewards: reward === 'none' ? {} : { reward: Number(reward) } },
  ...(exception ? { exception_info: { exception_type: exception } } : {}),
}));
await writeFile(process.env.MAKA_TEST_CAPTURED_ARTIFACTS, JSON.stringify(config.artifacts ?? null));

const mode = process.env.MAKA_TEST_AUDIT_MODE;
if (mode !== 'missing') {
  const destination = config.artifacts?.[0]?.destination ?? 'egress-hits.jsonl';
  const artifacts = new URL('artifacts/', trial);
  const audit = new URL(destination, artifacts);
  await mkdir(artifacts, { recursive: true });
  if (mode === 'unreadable') await mkdir(audit);
  else if (mode === 'empty') await writeFile(audit, '');
  else if (mode === 'truncated') await writeFile(audit, '{"ruleId":"tbench_domain"}\\n{"ruleId":"audit_truncated"}\\n');
  else if (mode === 'policy') await writeFile(audit, '{"ruleId":"policy_error"}\\n');
}
socket.end();
`;
}
