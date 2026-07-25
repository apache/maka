#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerAuthRequiresSecret } from '@maka/core/llm-connections';
import {
  buildAiSdkCellBackendRegistration,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellContinuationPolicy,
  buildHarborCellTaskLedgerExperimentPolicy,
  createHarborHttpToolExecutor,
  harborCellMaxStepsFromEnv,
  harborCellSoftTimeoutMsFromEnv,
  normalizeHarborCellContextEnv,
  reasoningEffortFromEnv,
  resolveHostProviderAuthority,
  runHarborCell,
  writeHarborCellUsageCheckpoint,
} from '#harbor-cell';
import { booleanEnv } from '#headless-run-env';

const TRIAL_PRICING_ENV = [
  'MAKA_TRIAL_INPUT_USD_PER_1M',
  'MAKA_TRIAL_OUTPUT_USD_PER_1M',
  'MAKA_TRIAL_CACHE_READ_USD_PER_1M',
  'MAKA_TRIAL_CACHE_WRITE_USD_PER_1M',
  'MAKA_TRIAL_PRICING_SOURCE',
];
const HOST_BACKEND_ENV_KEYS = [
  ...TRIAL_PRICING_ENV,
  'MAKA_OUTPUT_DIR',
  'MAKA_STORAGE_ROOT',
  'MAKA_REASONING_EFFORT',
  'MAKA_STREAM_CONNECT_TIMEOUT_MS',
  'MAKA_STREAM_IDLE_TIMEOUT_MS',
];
export async function main(options = {}) {
  const env = process.env;
  const provider =
    env.MAKA_PROVIDER ||
    providerFromModel(env.MAKA_MODEL || env.HARBOR_MODEL || 'deepseek/deepseek-v4-flash');
  const model =
    env.MAKA_MODEL || stripProvider(env.HARBOR_MODEL || 'deepseek/deepseek-v4-flash', provider);
  const outputDir = env.MAKA_OUTPUT_DIR || join(process.cwd(), 'agent');
  const storageRoot = env.MAKA_STORAGE_ROOT || join(outputDir, 'maka-storage');
  const contextEnv = normalizeHarborCellContextEnv(env);
  const contextBudgetPolicy = buildHarborCellContextBudgetPolicySnapshot(contextEnv);
  const continuationPolicy = buildHarborCellContinuationPolicy(env);
  const economyTaskMode = economyTaskModeFromEnv(env.MAKA_ECONOMY_TASK_MODE);
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(env);
  const maxSteps = harborCellMaxStepsFromEnv(env);
  const settleAfterMs = harborCellSoftTimeoutMsFromEnv(env);
  const reasoningEffort = reasoningEffortFromEnv(env.MAKA_REASONING_EFFORT);
  const agentTools = booleanEnv(env.MAKA_AGENT_TOOLS, 'MAKA_AGENT_TOOLS') ?? false;
  const now = Date.now;
  const newId = randomId;

  const result = await runHarborCell({
    config: {
      id: env.MAKA_CONFIG_ID || 'harbor-host-cell',
      backend: 'ai-sdk',
      llmConnectionSlug: env.MAKA_LLM_CONNECTION_SLUG || provider,
      model,
      agentTools,
      ...(reasoningEffort ? { thinkingLevel: reasoningEffort } : {}),
      ...(env.MAKA_SYSTEM_PROMPT !== undefined ? { systemPrompt: env.MAKA_SYSTEM_PROMPT } : {}),
      ...(economyTaskMode !== undefined ? { economyTaskMode } : {}),
    },
    instruction: await instructionFromEnv(env),
    cwd: env.MAKA_WORKDIR || process.cwd(),
    outputDir,
    storageRoot,
    pricingProfile: env.MAKA_TRIAL_PRICING_SOURCE || 'unconfigured',
    ...(contextBudgetPolicy ? { contextBudgetPolicy } : {}),
    ...(continuationPolicy ? { continuationPolicy } : {}),
    ...(taskLedgerExperimentPolicy ? { taskToolSummaryEnabled: true } : {}),
    ...(settleAfterMs !== undefined ? { settleAfterMs } : {}),
    registerBackends:
      options.registerBackends ??
      buildAiSdkCellBackendRegistration({
        provider,
        model,
        env: await backendEnv(
          { ...env, MAKA_OUTPUT_DIR: outputDir, MAKA_STORAGE_ROOT: storageRoot },
          provider,
        ),
        now,
        newId,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        recordUsageCheckpoint: (usage) => writeHarborCellUsageCheckpoint(outputDir, usage),
      }),
    realBackendIsolation: {
      kind: 'external',
      label: 'Harbor task container via host adapter',
      toolExecutor: createHarborHttpToolExecutor(env),
    },
    now,
    newId,
  });

  console.log(
    JSON.stringify({
      status: result.output.status,
      errorClass: result.output.errorClass,
      outputPath: result.outputPath,
      runtimeEventsPath: result.runtimeEventsPath,
      settledByDeadline: result.settledByDeadline,
    }),
  );
  return result;
}

function economyTaskModeFromEnv(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export async function backendEnv(env, provider) {
  const contextEnv = normalizeHarborCellContextEnv(env);
  const result = {
    MAKA_LLM_CONNECTION_SLUG: env.MAKA_LLM_CONNECTION_SLUG || provider,
  };
  const authority = resolveHostProviderAuthority(env);
  if (providerAuthRequiresSecret(provider) && authority.auth.kind !== 'credential') {
    throw new Error('MAKA_HOST_API_KEY_FILE is required for host-side Harbor cells');
  }
  if (authority.auth.kind === 'credential') result.MAKA_HOST_API_KEY = authority.auth.apiKey;
  if (authority.auth.kind === 'none') result.MAKA_HOST_NO_AUTH = 'true';
  if (authority.baseUrl) result.MAKA_HOST_BASE_URL = authority.baseUrl;
  if (authority.apiProtocol) result.MAKA_HOST_MODEL_API_PROTOCOL = authority.apiProtocol;
  for (const key of HOST_BACKEND_ENV_KEYS) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  Object.assign(result, contextEnv);
  return result;
}

async function instructionFromEnv(env) {
  if (env.MAKA_INSTRUCTION !== undefined) return env.MAKA_INSTRUCTION;
  if (env.MAKA_INSTRUCTION_FILE) return await readFile(env.MAKA_INSTRUCTION_FILE, 'utf8');
  throw new Error('MAKA_INSTRUCTION or MAKA_INSTRUCTION_FILE is required');
}

function providerFromModel(rawModel) {
  const separator = rawModel.indexOf('/');
  return separator >= 0 ? rawModel.slice(0, separator) : 'deepseek';
}

function stripProvider(rawModel, provider) {
  const prefix = `${provider}/`;
  return rawModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `host_cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}

export function hostCellExitCode(result) {
  return result.settledByDeadline ? 124 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((result) => {
      process.exitCode = hostCellExitCode(result);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`maka run-host-cell failed: ${message}`);
      process.exitCode = 1;
    });
}
