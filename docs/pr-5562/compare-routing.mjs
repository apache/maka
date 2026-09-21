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

import { writeFile } from 'node:fs/promises';
import { createJevRoutingModel } from '../../packages/runtime-host/dist/server/jev-routing-model.js';
import { createHostWorkHubRoutingModel } from '../../packages/runtime-host/dist/server/execution-model-authority.js';
import { createDefaultRuntimePolicy } from '../../packages/core/dist/runtime-policy.js';
import { createProxiedFetchTransport } from '../../packages/runtime/dist/network/scoped-fetch-transport.js';
const modelId = process.env.DPSK_MODEL ?? 'deepseek-v4-pro';
const catalog = { defaultTarget: { modelId } };
const connection = {
  connectionId: 'benchmark',
  slug: 'deepseek',
  providerType: 'deepseek',
  enabled: true,
  enabledModelIds: [modelId],
  models: [{ id: modelId }],
  ...(process.env.DPSK_BASE_URL ? { baseUrl: process.env.DPSK_BASE_URL } : {}),
};
const credential = { credentialId: 'benchmark', revision: 1, secret: process.env.DEEPSEEK_API_KEY };
const key = process.env.JEV_API_KEY;
if (!credential.secret || !key)
  throw new Error('Set DEEPSEEK_API_KEY and JEV_API_KEY in the process environment.');
const outputPath = process.env.COMPARE_OUTPUT ?? '/tmp/jev-routing-comparison.json';
const outputBudget = Number(process.env.DPSK_OUTPUT_BUDGET ?? 0);
const policy = { ...createDefaultRuntimePolicy(), jev: { enabled: true } };
let calls = [];
const createTransport = (proxy) => {
  const t = createProxiedFetchTransport(proxy);
  return {
    ...t,
    fetch: async (url, init) => {
      const started = performance.now();
      const body = JSON.parse(init.body);
      if (outputBudget && body.model.startsWith('deepseek')) {
        for (const k of ['max_output_tokens', 'max_tokens', 'max_completion_tokens'])
          if (k in body) body[k] = outputBudget;
        init = { ...init, body: JSON.stringify(body) };
      }
      const res = await t.fetch(url, init);
      const copy = await res.clone().json();
      calls.push({
        status: res.status,
        ms: Math.round(performance.now() - started),
        model: body.model,
        thinking: body.thinking ?? null,
        reasoning_effort: body.reasoning_effort ?? null,
        requestOptions: Object.fromEntries(
          Object.entries(body).filter(
            ([k]) => !['input', 'messages', 'instructions', 'system'].includes(k),
          ),
        ),
        usage: copy.usage ?? null,
        answer: copy.answers?.decision ?? null,
      });
      return res;
    },
  };
};
const stores = {
  runtimePolicy: { getSnapshot: async () => ({ policy }) },
  operations: {
    resolveHostOutboundExecution: async () => ({
      kind: 'ready',
      networkProxy: policy.networkProxy,
      secretMaterial: {},
    }),
    exportCredentialMaterial: async () => ({ secret: key }),
    resolveExecutionConnection: async () => ({
      kind: 'ready',
      connection,
      networkProxy: policy.networkProxy,
      secretMaterial: { connection: credential },
    }),
  },
};
const models = {
  jev: createJevRoutingModel({ stores, createTransport }),
  dpsk: createHostWorkHubRoutingModel({
    runtimePolicy: stores,
    oauthCredentials: {},
    usage: {
      pricing: { snapshot: async () => ({ overrides: [] }) },
      telemetry: { recordLlmCall: async () => {} },
    },
    requestDrain: () => {},
    createFetchTransport: createTransport,
  }),
};
const candidates = [
  {
    candidateRef: 'whc_payments',
    sessionName: 'Payments retry',
    workspaceName: 'Maka',
    state: 'idle',
    recency: 'today',
  },
  {
    candidateRef: 'whc_docs',
    sessionName: 'Documentation spelling',
    workspaceName: 'Docs',
    state: 'idle',
    recency: 'this_week',
  },
  {
    candidateRef: 'whc_login',
    sessionName: 'Login form validation',
    workspaceName: 'Website',
    state: 'idle',
    recency: 'older',
  },
];
const cases = [
  ['discuss', '什么是指数退避？只解释一下原理。', 'answer_here'],
  ['create', '新建一个任务，实现 CSV 导出功能。', 'create_new'],
  [
    'continue_payments',
    '继续 Maka 工作区的 Payments retry 工作。',
    'delegate_existing',
    'whc_payments',
  ],
  [
    'continue_docs',
    '继续修正文档拼写错误，接着 Documentation spelling 那个任务做。',
    'delegate_existing',
    'whc_docs',
  ],
  [
    'execute_existing',
    '把登录表单的校验补完整，就在已有的 Login form validation 任务里做。',
    'delegate_existing',
    'whc_login',
  ],
  ['execute_no_match', '帮我分析火星探测器轨道数据。', 'clarify'],
  ['ambiguous', '继续那个任务。', 'clarify'],
  ['stop', '停止 WorkHub 刚才委派的工作。', 'stop'],
  ['resume', '恢复刚才被我停止的 WorkHub 委派。', 'resume'],
  ['correct', '纠正你刚才的委派：不要改样式，只修逻辑。', 'correct'],
  ['create_over_match', '不要继续 Payments retry；新建一个单独的支付重试任务。', 'create_new'],
  [
    'contextual_continue',
    '接着做吧。',
    'delegate_existing',
    'whc_payments',
    [
      { role: 'user', text: '我们接着处理 Maka 的 Payments retry 工作。' },
      { role: 'assistant', text: '可以，下一步是完善支付重试逻辑。' },
    ],
  ],
];
const output = {
  recordedAt: new Date().toISOString(),
  sourceCommit: '1c814c261',
  dpskOutputBudgetOverride: outputBudget || null,
  models: { jev: 'jev-1.13.0', dpsk: catalog.defaultTarget.modelId },
  method:
    'One pass per model; alternating order; same bounded synthetic inputs and existing split Intent/Recall adapters. No task execution. Jev timeout 8s; outer request timeout 45s. Existing DPSK provider defaults; no thinking override.',
  cases: [],
  results: [],
};
for (let i = 0; i < cases.length; i++) {
  const [id, userText, expected, target, transcript = []] = cases[i];
  output.cases.push({ id, userText, expected, target, transcript, candidates });
  for (const name of i % 2 ? ['dpsk', 'jev'] : ['jev', 'dpsk']) {
    calls = [];
    let result, error;
    const start = performance.now();
    try {
      result = await models[name].decide({
        header: {
          id: 'synthetic-comparison',
          llmConnectionId: connection.connectionId,
          llmConnectionSlug: connection.slug,
          model: catalog.defaultTarget.modelId,
        },
        turnId: 'test-' + id,
        userText,
        transcript,
        abortSignal: AbortSignal.timeout(45000),
        resolveCandidates: async () => ({ candidateSetId: 'synthetic-candidate-set', candidates }),
      });
    } catch (e) {
      error = (e.name + ': ' + e.message)
        .replaceAll(key, '[redacted]')
        .replaceAll(credential.secret, '[redacted]');
    }
    const actual = result?.disposition ?? result?.operation ?? 'fallback';
    const row = {
      id,
      model: name,
      expected,
      actual,
      expectedTarget: target,
      result: result ?? null,
      error,
      ms: Math.round(performance.now() - start),
      pass: actual === expected && (!target || result?.candidateRef === target),
      calls,
    };
    output.results.push(row);
    await writeFile(outputPath, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ id, model: name, actual, pass: row.pass, ms: row.ms, error }));
  }
}
