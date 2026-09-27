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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileAttemptStore } from '../attempt-store.js';
import type { ExperimentSpec, JsonObject } from '../experiment.js';
import {
  createHarborExecutor,
  describeEgressAudit,
  EGRESS_AUDIT_ARTIFACT_PATH,
  EGRESS_AUDIT_DESTINATION,
} from '../harness-executor.js';
import { type EvalResultStatus, selectCellResult } from '../result.js';
import { runExperiment } from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
const EVAL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

type AuditSummary = {
  readonly truncated: boolean;
  readonly policyErrorCount: number;
  readonly malformedLineCount: number;
};

const cleanSummary: AuditSummary = {
  truncated: false,
  policyErrorCount: 0,
  malformedLineCount: 0,
};

const evidenceCases: ReadonlyArray<{
  readonly name: string;
  readonly audit: Buffer;
  readonly summary: AuditSummary;
}> = [
  {
    name: 'empty audit is valid zero-event evidence',
    audit: Buffer.alloc(0),
    summary: cleanSummary,
  },
  {
    name: 'truncation marker is retained as forensic metadata',
    audit: Buffer.from('{"ruleId":"tbench_domain"}\n{"ruleId":"audit_truncated"}\n'),
    summary: { ...cleanSummary, truncated: true },
  },
  {
    name: 'policy errors are counted even when a later hit exists',
    audit: Buffer.from('{"ruleId":"policy_error"}\n{"ruleId":"tbench_domain"}\n'),
    summary: { ...cleanSummary, policyErrorCount: 1 },
  },
  {
    name: 'each policy error contributes to the count',
    audit: Buffer.from('{"ruleId":"policy_error"}\n{"ruleId":"policy_error"}\n'),
    summary: { ...cleanSummary, policyErrorCount: 2 },
  },
  {
    name: 'malformed JSON and scalar JSON are counted without attribution',
    audit: Buffer.from('{broken\n123\n"scalar"\n'),
    summary: { ...cleanSummary, malformedLineCount: 3 },
  },
  {
    name: 'invalid UTF-8 cannot masquerade as a valid record',
    audit: Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
    summary: { ...cleanSummary, malformedLineCount: 1 },
  },
];

for (const scenario of evidenceCases) {
  test(scenario.name, () => {
    assert.deepEqual(describeEgressAudit(scenario.audit, true), {
      failureReason: null,
      artifacts: [expectedAuditArtifact(scenario.audit, scenario.summary)],
    });
  });
}

test('required audit absence is explicit infrastructure evidence', () => {
  assert.deepEqual(describeEgressAudit(undefined, true), {
    failureReason: 'egress audit log missing',
    artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  });
});

test('an executor without the proxy has no audit obligation', () => {
  assert.deepEqual(describeEgressAudit(undefined, false), {
    failureReason: null,
    artifacts: [],
  });
});

function expectedAuditArtifact(audit: Buffer, summary: AuditSummary): JsonObject {
  return {
    kind: 'egress-audit',
    path: EGRESS_AUDIT_ARTIFACT_PATH,
    bytes: audit.byteLength,
    sha256: 'sha256:' + createHash('sha256').update(audit).digest('hex'),
    ...summary,
  };
}

type AuditMode = 'missing' | 'empty' | 'truncated' | 'policy' | 'unreadable';

type HarnessScenario = {
  readonly name: string;
  readonly auditMode: AuditMode;
  readonly proxy: boolean;
  readonly expectedStatus: EvalResultStatus;
  readonly expectedFailure?: string;
  readonly expectedAudit?: Partial<AuditSummary>;
  readonly exceptionType?: string;
  readonly reward?: number | null;
};

const harnessCases: readonly HarnessScenario[] = [
  {
    name: 'missing required audit excludes the attempt',
    auditMode: 'missing',
    proxy: true,
    expectedStatus: 'infra_failed',
    expectedFailure: 'egress audit log missing',
  },
  {
    name: 'truncated audit remains scored and visible',
    auditMode: 'truncated',
    proxy: true,
    expectedStatus: 'completed',
    expectedAudit: { truncated: true },
  },
  {
    name: 'policy error remains scored and visible',
    auditMode: 'policy',
    proxy: true,
    expectedStatus: 'completed',
    expectedAudit: { policyErrorCount: 1 },
  },
  {
    name: 'subject timeout keeps its attribution when audit evidence lands',
    auditMode: 'truncated',
    proxy: true,
    exceptionType: 'AgentTimeoutError',
    reward: 0,
    expectedStatus: 'subject_failed',
    expectedAudit: { truncated: true },
  },
  {
    name: 'missing audit outranks subject timeout',
    auditMode: 'missing',
    proxy: true,
    exceptionType: 'AgentTimeoutError',
    reward: 0,
    expectedStatus: 'infra_failed',
    expectedFailure: 'egress audit log missing',
  },
  {
    name: 'missing audit outranks missing reward',
    auditMode: 'missing',
    proxy: true,
    reward: null,
    expectedStatus: 'infra_failed',
    expectedFailure: 'egress audit log missing',
  },
  {
    name: 'empty audit proves a clean completed trial',
    auditMode: 'empty',
    proxy: true,
    expectedStatus: 'completed',
    expectedAudit: cleanSummary,
  },
  {
    name: 'unreadable audit path is infrastructure failure',
    auditMode: 'unreadable',
    proxy: true,
    expectedStatus: 'infra_failed',
    expectedFailure: 'failed to read egress audit log',
  },
  {
    name: 'proxy-free trial does not require an audit file',
    auditMode: 'missing',
    proxy: false,
    expectedStatus: 'completed',
  },
];

for (const scenario of harnessCases) {
  test(scenario.name, { timeout: 10_000 }, async () => {
    const outcome = await runHarnessScenario(scenario);
    const attempt = outcome.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.result.status, scenario.expectedStatus);
    if (scenario.expectedFailure) {
      assert.match(attempt.result.failureReason ?? '', new RegExp(scenario.expectedFailure));
    }
    assert.equal(
      outcome.selected?.result.status,
      scenario.expectedStatus === 'infra_failed' ? undefined : scenario.expectedStatus,
    );

    const artifact = attempt.result.artifacts.find((item) => item.kind === 'egress-audit');
    if (scenario.expectedAudit) {
      assert.ok(artifact);
      assert.deepEqual(
        {
          truncated: artifact.truncated,
          policyErrorCount: artifact.policyErrorCount,
          malformedLineCount: artifact.malformedLineCount,
        },
        { ...cleanSummary, ...scenario.expectedAudit },
      );
    } else {
      assert.equal(artifact, undefined);
    }

    if (scenario.proxy) {
      assert.deepEqual(outcome.trialArtifacts, [
        {
          source: '/opt/maka-egress-state/hits.jsonl',
          destination: EGRESS_AUDIT_DESTINATION,
          service: 'maka-eval-mitmproxy',
        },
      ]);
    } else {
      assert.equal(outcome.trialArtifacts, null);
    }
  });
}

async function runHarnessScenario(options: HarnessScenario) {
  const root = await mkdtemp(join(tmpdir(), 'maka-egress-evidence-'));
  const executable = join(root, 'trial-probe.mjs');
  const capturedConfig = join(root, 'captured-artifacts.json');
  await writeFile(executable, trialProbeSource());
  await chmod(executable, 0o755);
  const restore = setEnvironment({
    MAKA_TEST_PYTHON: executable,
    MAKA_TEST_TRIALS: root,
    MAKA_TEST_BUNDLE: EVAL_ROOT,
    MAKA_TEST_AUDIT_MODE: options.auditMode,
    MAKA_TEST_CAPTURED_ARTIFACTS: capturedConfig,
    MAKA_TEST_REWARD: options.reward === null ? 'none' : String(options.reward ?? 1),
    MAKA_TEST_EXCEPTION: options.exceptionType ?? '',
  });

  try {
    const store = new FileAttemptStore(join(root, 'attempts'));
    const results = await runExperiment({
      spec: experiment(),
      store,
      executor: createHarborExecutor(executorConfig(options.proxy), join(root, 'experiment.json')),
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
      trialArtifacts: JSON.parse(await readFile(capturedConfig, 'utf8')) as unknown,
    };
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

function trialProbeSource(): string {
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
