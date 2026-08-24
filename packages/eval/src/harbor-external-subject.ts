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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { signMeteringCheckpoint, writeJsonAtomic } from './metering-checkpoint.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Agent, fetch as undiciFetch, ProxyAgent } from 'undici';
import {
  decodePreverifiedToolchain,
  isExternalProfile,
  type ExternalProfile as Profile,
} from './toolchain-verification.js';
import { isInferenceAdmissionEvent } from './provider-admission.js';
import {
  DEEPSEEK_V4_FLASH_COST,
  deriveMetering,
  type ProviderMeteringCounts,
  type ProviderUsage as Usage,
} from './provider-metering.js';
import { removeEvalWebTools } from './provider-web-tool-surface.js';
import { takeRelayResultToken, writeRelayResult } from './relay-result-frame.js';

const resultToken = takeRelayResultToken();

// The profile directory this wrapper writes. `dsh` has no environment variable
// for profile selection, so the spec repeats this name in `--profile`; the
// lifecycle test pins the two together.
const DEEPSEEK_HARNESS_PROFILE = 'maka-eval';

const PROVIDER_USAGE_CHECKPOINT_SCHEMA = 'maka.external_provider_usage.v2';

type SubjectStatus = 'completed' | 'failed' | 'infra_failed' | 'indeterminate';
const CLASSIFIABLE_RECORD_LIMIT_BYTES = 16 * 1024 * 1024;

interface ProfileSetup {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly root: string;
  readonly proxyBaseUrl: string;
  readonly executableArgs: readonly string[];
}

// One preparer per admissible profile, returning the path of any credential
// file it wrote. Keying the table by ExternalProfile is what makes adding a
// profile to TOOLCHAIN_IDENTITIES without preparing it a compile error, rather
// than a silent fallthrough into whichever branch happened to be written last.
const PROFILE_PREPARERS: Record<Profile, (setup: ProfileSetup) => Promise<string | undefined>> = {
  codex: async ({ env, home, root, proxyBaseUrl }) => {
    env.OPENAI_API_KEY = 'maka-eval-local';
    env.CODEX_HOME = home;
    const catalog = rooted(root, '/opt/maka-agent/packages/eval/harbor/deepseek-codex-models.json');
    await writeFile(
      join(home, 'config.toml'),
      [
        'model_provider = "maka-http"',
        `model_catalog_json = ${JSON.stringify(catalog)}`,
        'model_reasoning_effort = "max"',
        '',
        '[model_providers.maka-http]',
        'name = "Maka Eval HTTP"',
        `base_url = ${JSON.stringify(proxyBaseUrl)}`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'supports_websockets = false',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await writePolicy(
      rooted(root, '/etc/codex'),
      'requirements.toml',
      'allowed_web_search_modes = ["disabled"]\n',
    );
  },

  'claude-code': async ({ env, home, root, proxyBaseUrl }) => {
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_API_KEY = 'maka-eval-local';
    env.CLAUDE_CODE_HOME = home;
    await writePolicy(
      rooted(root, '/etc/claude-code'),
      'managed-settings.json',
      '{"permissions":{"deny":["WebSearch","WebFetch","FetchURL"]}}\n',
    );
  },

  reasonix: async ({ env, home, proxyBaseUrl, executableArgs }) => {
    const modelReference = executableArgs[executableArgs.indexOf('--model') + 1];
    const effort = executableArgs[executableArgs.indexOf('--effort') + 1];
    const [provider, model] = modelReference?.split('/') ?? [];
    if (provider !== 'maka-proxy' || !model || !effort) {
      throw new Error('Reasonix provider settings are incomplete');
    }
    await writeFile(
      join(home, 'config.toml'),
      `default_model = ${JSON.stringify(modelReference)}\n\n[[providers]]\nname = "maka-proxy"\nkind = "openai"\nbase_url = ${JSON.stringify(proxyBaseUrl)}\nmodels = [${JSON.stringify(model)}]\napi_key_env = "OPENAI_API_KEY"\neffort = ${JSON.stringify(effort)}\n\n[tools]\nenabled = ["bash", "read_file", "write_file", "edit_file", "glob", "grep"]\n\n[sandbox]\nbash = "off"\n`,
      { mode: 0o600 },
    );
    const path = join(home, '.env');
    await writeFile(path, 'OPENAI_API_KEY=maka-eval-local\n', { mode: 0o600 });
    env.OPENAI_API_KEY = 'maka-eval-local';
    env.REASONIX_HOME = home;
    return path;
  },

  opencode: async ({ env, home, proxyBaseUrl }) => {
    env.DEEPSEEK_API_KEY = 'maka-eval-local';
    env.DEEPSEEK_BASE_URL = proxyBaseUrl;
    env.OPENCODE_CONFIG = join(home, 'opencode.json');
    env.XDG_DATA_HOME = join(home, 'data');
    env.XDG_CONFIG_HOME = join(home, 'config');
    env.XDG_STATE_HOME = join(home, 'state');
    await writeFile(
      env.OPENCODE_CONFIG,
      `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          deepseek: {
            options: {
              apiKey: '{env:DEEPSEEK_API_KEY}',
              baseURL: '{env:DEEPSEEK_BASE_URL}',
            },
            models: {
              'deepseek-v4-flash': {
                name: 'DeepSeek V4 Flash',
                limit: {
                  context: 1_048_576,
                  output: 131_072,
                },
                options: {
                  thinking: { type: 'enabled' },
                  effort: 'max',
                },
                variants: {
                  max: {
                    thinking: { type: 'enabled' },
                    effort: 'max',
                  },
                },
              },
            },
          },
        },
        permission: {
          webfetch: 'deny',
          websearch: 'deny',
        },
      })}\n`,
      { mode: 0o600 },
    );
  },

  'kimi-code': async ({ env, home, proxyBaseUrl }) => {
    env.KIMI_CODE_HOME = home;
    env.KIMI_MODEL_NAME = 'deepseek-v4-flash';
    env.KIMI_MODEL_API_KEY = 'maka-eval-local';
    env.KIMI_MODEL_PROVIDER_TYPE = 'kimi';
    env.KIMI_MODEL_BASE_URL = proxyBaseUrl;
    env.KIMI_MODEL_MAX_CONTEXT_SIZE = '1048576';
    env.KIMI_MODEL_MAX_OUTPUT_SIZE = '131072';
    env.KIMI_MODEL_MAX_COMPLETION_TOKENS = '131072';
    env.KIMI_MODEL_ADAPTIVE_THINKING = 'true';
    env.KIMI_MODEL_THINKING_EFFORT = 'max';
    await writeFile(
      join(home, 'config.toml'),
      [
        'telemetry = false',
        'default_permission_mode = "auto"',
        '',
        '[background]',
        'keep_alive_on_exit = true',
        '',
        '[permission]',
        'rules = [',
        '  { decision = "deny", scope = "user", pattern = "WebSearch", reason = "Disabled for eval parity" },',
        '  { decision = "deny", scope = "user", pattern = "WebFetch", reason = "Disabled for eval parity" },',
        '  { decision = "deny", scope = "user", pattern = "FetchURL", reason = "Disabled for eval parity" },',
        ']',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  },

  pi: async ({ env, home, proxyBaseUrl }) => {
    env.OPENAI_API_KEY = 'maka-eval-local';
    env.PI_CODING_AGENT_DIR = home;
    env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
    env.PI_OFFLINE = '1';
    env.PI_TELEMETRY = '0';
    await writeFile(
      join(home, 'models.json'),
      `${JSON.stringify({
        providers: {
          'maka-proxy': {
            baseUrl: `${proxyBaseUrl.replace(/\/+$/u, '')}/v1`,
            api: 'openai-responses',
            apiKey: '$OPENAI_API_KEY',
            authHeader: true,
            models: [
              {
                id: 'deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                reasoning: true,
                thinkingLevelMap: {
                  off: null,
                  minimal: null,
                  low: null,
                  medium: null,
                  high: 'high',
                  xhigh: null,
                  max: 'max',
                },
                input: ['text'],
                contextWindow: 1_048_576,
                maxTokens: 131_072,
                cost: { ...DEEPSEEK_V4_FLASH_COST },
              },
            ],
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(home, 'settings.json'),
      `${JSON.stringify({
        enableInstallTelemetry: false,
        defaultProjectTrust: 'never',
      })}\n`,
      { mode: 0o600 },
    );
  },

  'deepseek-harness': async ({ env, home, root, proxyBaseUrl }) => {
    // The arm supplies its own profile rather than patching a stock one, so the
    // composition names every entry the model can observe. DSH_HOME must be
    // writable: the harness links its bundled packages into
    // profiles/node_modules on first use, which it does offline.
    env.DSH_HOME = join(home, 'dsh');
    const profile = join(env.DSH_HOME, 'profiles', DEEPSEEK_HARNESS_PROFILE);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const source = rooted(root, '/opt/maka-agent/packages/eval/harbor/deepseek-harness-profile');
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      await copyFile(join(source, file), join(profile, file));
    }
    env.DEEPSEEK_API_KEY = 'maka-eval-local';
    env.DEEPSEEK_BASE_URL = proxyBaseUrl;
    // The harness kills every descendant of its persistent PTY on shutdown,
    // which removes a task's own background service before the shared-environment
    // verifier can reach it. What the verifier scores is the environment the
    // task was left in, so no framework — this one, Maka, or the relay — may
    // edit it after the subject stops. The patched subprocess package honours
    // this flag by closing the shell without killing the process group.
    env.DSH_PRESERVE_BACKGROUND_PROCESSES = '1';
  },

  zcode: async ({ env, home, proxyBaseUrl }) => {
    const zcodeHome = join(home, '.zcode');
    const configRoot = join(zcodeHome, 'cli');
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    env.ZCODE_HOME = zcodeHome;
    env.ZCODE_DATA_BASE_DIR = zcodeHome;
    env.DEEPSEEK_API_KEY = 'maka-eval-local';
    await writeFile(
      join(configRoot, 'config.json'),
      `${JSON.stringify({
        provider: {
          deepseek: {
            kind: 'openai-compatible',
            name: 'DeepSeek',
            options: {
              baseURL: proxyBaseUrl,
              includeUsage: true,
            },
            models: {
              'deepseek-v4-flash': {
                name: 'DeepSeek V4 Flash',
                supportsReasoning: true,
                supportsToolCall: true,
                contextWindow: 1_048_576,
                maxOutputTokens: 131_072,
                reasoning: {
                  enabled: true,
                  levels: ['high', 'max'],
                  defaultLevel: 'max',
                  providerOptionsByLevel: {
                    max: {
                      reasoningEffort: 'max',
                      thinking: { type: 'enabled' },
                    },
                  },
                },
              },
            },
          },
        },
        model: 'deepseek/deepseek-v4-flash',
        permission: {
          mode: 'yolo',
          disallowedTools: ['WebSearch', 'WebFetch', 'FetchURL'],
        },
        features: { memory: false, mcp: false },
        plugins: { enabled: false },
        skills: { enabled: false },
      })}\n`,
      { mode: 0o600 },
    );
  },
};

const [rawProfile, baseUrl, systemRoot, command, ...args] = process.argv.slice(2);
if (!isExternalProfile(rawProfile)) throw new Error('external subject profile is required');
const profile = rawProfile;
if (!command) throw new Error('external subject command is required');
if (!baseUrl || !URL.canParse(baseUrl)) throw new Error('external subject base URL is required');
if (!systemRoot?.startsWith('/')) throw new Error('external subject system root is required');

let credentialPath: string | undefined;
let child: ChildProcess | undefined;
let stopped = false;
const stop = (signal: NodeJS.Signals) => {
  stopped = true;
  removeCredential();
  child?.kill(signal);
};
const terminate = () => stop('SIGTERM');
const interrupt = () => stop('SIGINT');
process.once('SIGTERM', terminate);
process.once('SIGINT', interrupt);

const logsRoot = rooted(systemRoot, '/logs/agent');
const statePath = join(logsRoot, `${profile}.wrapper-state.json`);
const usagePath = join(logsRoot, `${profile}.provider-usage.json`);
const artifacts: Record<string, unknown>[] = [];
let usage: Usage | null = null;
let costUsd: number | null = null;
let status: SubjectStatus = 'infra_failed';
let failureReason: string | null = 'external subject setup failed';

try {
  await mkdir(logsRoot, { recursive: true, mode: 0o700 });
  await writeState('started');
  const identity = decodePreverifiedToolchain(profile, systemRoot, command);
  artifacts.push({ kind: 'toolchain', profile, ...identity });
  await writeState('toolchain_verified');

  const key =
    process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('external subject credential is missing');
  const proxy = await startMeteringProxy(
    baseUrl,
    key,
    profile === 'claude-code',
    profile,
    usagePath,
  );
  try {
    await writeState('proxy_started');
    const prepared = await prepareProfile(profile, proxy.baseUrl, systemRoot, args);
    credentialPath = prepared.credentialPath;
    if (profile === 'claude-code') prepareClaudeWorkspace(systemRoot, prepared.home);
    const result = await runChild(command, args, prepared.env, profile, async (exitCode) => {
      proxy.stopAccepting();
      if (exitCode !== undefined) await writeState('child_exited', { exitCode });
    });
    child = undefined;
    const metering = await proxy.report();
    const derived = deriveMetering(metering);
    usage = metering.usage;
    costUsd = derived.costUsd;
    const classified = classifyExecution(
      profile,
      result.exitCode,
      result.stdout,
      metering.admittedRequests,
    );
    status = stopped ? 'indeterminate' : classified.status;
    failureReason = stopped ? 'external subject cancelled' : classified.failureReason;
    await writeState('result_ready', {
      status,
      requests: metering.requests,
      admittedRequests: metering.admittedRequests,
      usageRequests: metering.usageRequests,
      removedWebTools: metering.removedWebTools,
    });
    artifacts.push(
      { kind: 'external-process', profile, exitCode: result.exitCode },
      streamArtifact('stdout', profile, result.stdout),
      streamArtifact('stderr', profile, result.stderr),
      {
        kind: 'provider-metering',
        profile,
        requests: metering.requests,
        admittedRequests: metering.admittedRequests,
        usageRequests: metering.usageRequests,
        usageComplete: derived.usageComplete,
        removedWebTools: metering.removedWebTools,
        models: metering.models,
        toolNames: metering.toolNames,
      },
      fileArtifact('wrapper-state', statePath, profile),
    );
  } finally {
    await proxy.close();
  }
} catch (error) {
  status = stopped ? 'indeterminate' : 'infra_failed';
  failureReason = stopped
    ? 'external subject cancelled'
    : safeFailure(error, 'external subject setup failed');
  await writeState('setup_failed', { failureReason }).catch(() => undefined);
} finally {
  process.removeListener('SIGTERM', terminate);
  process.removeListener('SIGINT', interrupt);
  removeCredential();
}

// A process's exit code reports what it did, and anything that can read only
// the exit code — the relay, a log, an operator — should read the same status
// the frame carries. The adapter still prefers the frame where it has one; this
// is what it falls back to when the frame carries no status of its own.
process.exitCode = status === 'completed' ? 0 : 1;

writeRelayResult(resultToken, {
  schemaVersion: 'maka.external_subject_result.v2',
  status,
  failureReason,
  usage,
  costUsd,
  artifacts,
});

async function prepareProfile(
  selected: Profile,
  proxyBaseUrl: string,
  root: string,
  executableArgs: string[],
): Promise<{ env: NodeJS.ProcessEnv; home: string; credentialPath?: string }> {
  const env = { ...process.env };
  const home = rooted(root, `/tmp/maka-eval-${selected}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  env.HOME = home;
  const credential = await PROFILE_PREPARERS[selected]({
    env,
    home,
    root,
    proxyBaseUrl,
    executableArgs,
  });
  return { env, home, ...(credential ? { credentialPath: credential } : {}) };
}

async function runChild(
  executable: string,
  executableArgs: string[],
  env: NodeJS.ProcessEnv,
  selected: Profile,
  onExit: (exitCode?: number) => Promise<void>,
): Promise<{ exitCode: number; stdout: ClassifiedStream; stderr: StreamDiagnostic }> {
  const running = spawn(executable, executableArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = running;
  const stdout = classifyStream(running.stdout, selected);
  const stderr = captureStreamDiagnostic(running.stderr);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    let settled = false;
    running.once('error', (error) => {
      if (settled) return;
      settled = true;
      void onExit().then(() => reject(error), reject);
    });
    running.once('exit', (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      void onExit(exitCode).then(() => resolveExit(exitCode), reject);
    });
  });
  const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr]);
  return { exitCode, stdout: stdoutResult, stderr: stderrResult };
}

interface StreamDiagnostic {
  readonly observedBytes: number;
  readonly sha256: string;
}

type ClassifiedStream = StreamDiagnostic &
  (
    | {
        readonly classification: 'classified';
        readonly completed: boolean;
        readonly reportedError: boolean;
        readonly nonempty: boolean;
      }
    | {
        readonly classification: 'record-too-large';
        readonly limitBytes: number;
      }
  );

async function classifyStream(input: Readable, selected: Profile): Promise<ClassifiedStream> {
  const digest = createHash('sha256');
  const decoder = new TextDecoder();
  let observedBytes = 0;
  let buffered = '';
  let completed = false;
  let reportedError = false;
  let nonempty = false;
  let recordTooLarge = false;
  const consume = (line: string) => {
    nonempty ||= line.trim().length > 0;
    const signal = classifyLine(selected, line);
    completed ||= signal.completed;
    reportedError ||= signal.reportedError;
  };
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    observedBytes += bytes.byteLength;
    digest.update(bytes);
    buffered += decoder.decode(bytes, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      consume(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
    if (Buffer.byteLength(buffered) > CLASSIFIABLE_RECORD_LIMIT_BYTES) {
      recordTooLarge = true;
      buffered = '';
    }
  }
  buffered += decoder.decode();
  if (buffered) consume(buffered);
  const streamDiagnostic = { observedBytes, sha256: digest.digest('hex') };
  if (recordTooLarge) {
    return {
      ...streamDiagnostic,
      classification: 'record-too-large',
      limitBytes: CLASSIFIABLE_RECORD_LIMIT_BYTES,
    };
  }
  return {
    ...streamDiagnostic,
    classification: 'classified',
    completed,
    reportedError,
    nonempty,
  };
}

async function captureStreamDiagnostic(input: Readable): Promise<StreamDiagnostic> {
  const digest = createHash('sha256');
  let observedBytes = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    observedBytes += bytes.byteLength;
    digest.update(bytes);
  }
  return { observedBytes, sha256: digest.digest('hex') };
}

function streamArtifact(kind: string, profile: Profile, capture: StreamDiagnostic) {
  return {
    kind,
    profile,
    bytes: capture.observedBytes,
    sha256: capture.sha256,
    ...('classification' in capture &&
    capture.classification === 'record-too-large' &&
    'limitBytes' in capture
      ? { classification: capture.classification, limitBytes: capture.limitBytes }
      : {}),
  };
}

function prepareClaudeWorkspace(root: string, home: string): void {
  if (root !== '/') return;
  const result = spawnSync('/bin/chown', ['-R', '1000:1000', process.cwd(), home, '/logs/agent']);
  if (result.status !== 0) throw new Error('Claude Code workspace ownership setup failed');
  if (!process.setgid || !process.setuid) {
    throw new Error('Claude Code user isolation is unavailable');
  }
  process.setgid(1000);
  process.setuid(1000);
}

function classifyExecution(
  selected: Profile,
  exitCode: number,
  output: ClassifiedStream,
  admittedRequests: number,
): { status: SubjectStatus; failureReason: string | null } {
  if (output.classification === 'record-too-large') {
    return {
      status: 'infra_failed',
      failureReason: `${selected} output record exceeded the classification limit`,
    };
  }
  // Neither harness emits a structured completion event: zcode and the DeepSeek
  // Harness one-shot CLI print the final assistant message and nothing else, so
  // a clean exit with output is the whole signal on offer. Scores come from the verifier either way; this
  // only decides whether the attempt reads as completed or failed.
  const completed =
    output.completed ||
    ((selected === 'zcode' || selected === 'deepseek-harness') &&
      exitCode === 0 &&
      output.nonempty);
  const reportedError = output.reportedError;
  if (admittedRequests === 0) {
    return { status: 'infra_failed', failureReason: `${selected} failed before model admission` };
  }
  if (completed && !reportedError) {
    return { status: 'completed', failureReason: null };
  }
  return { status: 'failed', failureReason: `${selected} execution failed` };
}

function classifyLine(
  selected: Profile,
  line: string,
): { completed: boolean; reportedError: boolean } {
  if (!line.trim()) return { completed: false, reportedError: false };
  let completed = false;
  let reportedError = false;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (selected === 'codex') {
      completed ||= event.type === 'turn.completed';
      reportedError ||= event.type === 'turn.failed';
    } else if (selected === 'claude-code') {
      if (event.type === 'result') {
        completed ||= event.is_error === false;
        reportedError ||= event.is_error === true;
      }
    } else if (selected === 'reasonix') {
      completed ||= event.type === 'result' && event.is_error !== true;
      reportedError ||= event.type === 'result' && event.is_error === true;
    } else if (selected === 'opencode') {
      completed ||= event.type === 'step_finish';
      reportedError ||= event.type === 'error';
    } else if (selected === 'kimi-code') {
      completed ||= event.role === 'assistant';
      reportedError ||= event.role === 'error' || event.type === 'error';
    } else if (selected === 'pi') {
      completed ||= event.type === 'agent_end';
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === 'assistant') {
        reportedError ||= message.stopReason === 'error' || message.stopReason === 'aborted';
      }
    }
  } catch {
    return { completed: false, reportedError: false };
  }
  return { completed, reportedError };
}

async function startMeteringProxy(
  upstreamBaseUrl: string,
  upstreamKey: string,
  anthropic: boolean,
  selected: Profile,
  checkpointPath: string,
): Promise<{
  baseUrl: string;
  // Metering is only readable as one settled snapshot: a request still in
  // flight when the child exits would otherwise be missing from the counts that
  // decide admission, usage, and cost.
  stopAccepting(): void;
  report(): Promise<ProviderMeteringCounts>;
  close(): Promise<void>;
}> {
  const total = zeroUsage();
  let requests = 0;
  let inFlightRequests = 0;
  let admittedRequests = 0;
  let usageRequests = 0;
  let removedWebTools = 0;
  let settled = false;
  const requestModels = new Set<string>();
  const observedToolNames = new Set<string>();
  const snapshot = (): ProviderMeteringCounts => ({
    usage:
      usageRequests > 0 ? { ...total, totalTokens: total.inputTokens + total.outputTokens } : null,
    settled,
    requests,
    inFlightRequests,
    admittedRequests,
    usageRequests,
    removedWebTools,
    models: [...requestModels].sort(),
    toolNames: [...observedToolNames].sort(),
  });
  // The wrapper's own result frame is lost when the process is killed rather
  // than asked to stop, and a run that is cut off is exactly the run with the
  // most tokens spent. The checkpoint is therefore written at the start and the
  // settlement of every request, so whatever survives on disk is a truthful
  // lower bound at worst. Writes are serialized through one chain: two
  // concurrent requests must not interleave into a half-written file.
  // A failed write leaves the previous snapshot on disk, which is still a
  // truthful lower bound. It must not do more than that: an unhandled rejection
  // here would propagate down the chain and turn a run that finished into an
  // infrastructure failure over a file that exists only in case the run does
  // not finish.
  let checkpointWrites = Promise.resolve();
  const persistCheckpoint = () => {
    const value = signMeteringCheckpoint(
      {
        schemaVersion: PROVIDER_USAGE_CHECKPOINT_SCHEMA,
        profile: selected,
        ...snapshot(),
      },
      resultToken,
    );
    checkpointWrites = checkpointWrites.then(() =>
      writeJsonAtomic(checkpointPath, value).catch(() => undefined),
    );
    return checkpointWrites;
  };
  await persistCheckpoint();
  // Undici defaults to aborting a request after 300s without headers or body
  // bytes. A reasoning model can legitimately be quiet for longer, and killing
  // it here would turn a slow answer into an infrastructure failure. The
  // benchmark's own agent timeout stays the only deadline.
  const timeouts = { headersTimeout: 0, bodyTimeout: 0 };
  const dispatcher = process.env.HTTPS_PROXY
    ? new ProxyAgent({ uri: process.env.HTTPS_PROXY, ...timeouts })
    : new Agent(timeouts);
  const active = new Set<Promise<void>>();
  let accepting = true;
  const stopAccepting = () => {
    accepting = false;
  };
  const server = createServer((request, response) => {
    // Refused rather than counted: a request the proxy declined was never
    // admitted by the provider and never billed, so it is not part of what
    // this run spent.
    if (!accepting) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'provider proxy has settled' }));
      return;
    }
    const operation = (async () => {
      requests += 1;
      inFlightRequests += 1;
      try {
        await persistCheckpoint();
        const projected = removeEvalWebTools(await readRequest(request));
        removedWebTools += projected.removed;
        if (projected.model) requestModels.add(projected.model);
        for (const name of projected.toolNames) observedToolNames.add(name);
        const target = joinUpstream(upstreamBaseUrl, request.url ?? '/');
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value === undefined ||
            ['host', 'content-length', 'connection', 'authorization', 'x-api-key'].includes(
              name.toLowerCase(),
            )
          )
            continue;
          headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        if (anthropic) headers['x-api-key'] = upstreamKey;
        else headers.authorization = `Bearer ${upstreamKey}`;
        const upstream = await undiciFetch(target, {
          method: request.method,
          headers,
          body: projected.body.length === 0 ? undefined : new Uint8Array(projected.body),
          dispatcher,
        });
        response.statusCode = upstream.status;
        upstream.headers.forEach((value, name) => {
          if (
            !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(
              name,
            )
          )
            response.setHeader(name, value);
        });
        const parser = usageParser(anthropic);
        let counted = false;
        const admit = async () => {
          if (counted || !upstream.ok || !parser.admitted()) return;
          counted = true;
          admittedRequests += 1;
          await persistCheckpoint();
        };
        try {
          // Admission is a fact about the provider, not about this request
          // finishing: once the stream carries the event, the model work has
          // been done and billed whatever happens to this process next. It is
          // therefore recorded and persisted the moment it is observed, so a
          // checkpoint written mid-stream already knows. `admitted` is
          // monotonic and `counted` makes the increment idempotent, so this
          // costs one write per request rather than one per chunk.
          if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              const chunk = Buffer.from(next.value);
              parser.push(chunk.toString('utf8'));
              // Before the chunk is handed to a downstream this process does not
              // control: once it is written, a disconnect or a kill can end this
              // request at any point, and the admission would be lost with it.
              await admit();
              response.write(chunk);
            }
          }
          response.end();
        } finally {
          const parsed = parser.finish();
          await admit();
          if (counted && parsed.usage) {
            usageRequests += 1;
            addUsage(total, parsed.usage);
          }
        }
      } finally {
        inFlightRequests -= 1;
        await persistCheckpoint();
      }
    })().catch((error: unknown) => {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: safeFailure(error, 'provider proxy failed') }));
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider proxy did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stopAccepting,
    report: async () => {
      // Admission closes before anything is drained, so settlement is made
      // true rather than asserted about a moment. The subject's own process has
      // exited by now, but the processes it left behind have not — they run in
      // this container and this proxy is still bound — and a request accepted
      // after the flag was set would leave a checkpoint claiming settlement
      // with work in flight. Closing the socket would not do this: it stops new
      // connections while leaving established ones free to send another
      // request, and it waits on idle keep-alive sockets that may never close.
      stopAccepting();
      await Promise.allSettled([...active]);
      // Settlement is something this process observes; it is not recoverable
      // from the counts. A checkpoint whose last successful write happened
      // mid-run also has no requests in flight as of that write, so a reader
      // cannot tell it from this one except by being told.
      settled = true;
      await persistCheckpoint();
      return snapshot();
    },
    close: async () => {
      stopAccepting();
      await Promise.allSettled([...active]);
      await checkpointWrites;
      await closeServer(server);
      await dispatcher.close();
    },
  };
}

function usageParser(anthropic: boolean): {
  push(text: string): void;
  // Monotonic, and readable before the stream ends: the caller records
  // admission when the provider states it, not when the request settles.
  admitted(): boolean;
  finish(): { usage: Usage | null; admitted: boolean };
} {
  let buffered = '';
  let current: Usage | null = null;
  let admitted = false;
  const consume = (line: string) => {
    const raw = line.trim().replace(/^data:\s*/u, '');
    if (!raw || raw === '[DONE]') return;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      admitted ||= isInferenceAdmissionEvent(value, anthropic);
      current = mergeUsage(current, usageFromEvent(value, anthropic));
    } catch {
      return;
    }
  };
  return {
    push(text) {
      buffered += text;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        consume(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    },
    admitted() {
      return admitted;
    },
    finish() {
      if (buffered.trim()) consume(buffered);
      return { usage: current, admitted };
    },
  };
}

function usageFromEvent(event: Record<string, unknown>, anthropic: boolean): Usage | null {
  const response =
    event.type === 'response.completed' && isRecord(event.response) ? event.response : event;
  const message =
    event.type === 'message_start' && isRecord(event.message) ? event.message : response;
  const raw = isRecord(message.usage) ? message.usage : isRecord(event.usage) ? event.usage : null;
  if (!raw) return null;
  const input = number(raw.input_tokens ?? raw.prompt_tokens);
  const output = number(raw.output_tokens ?? raw.completion_tokens);
  const inputDetails = isRecord(raw.input_tokens_details)
    ? raw.input_tokens_details
    : isRecord(raw.prompt_tokens_details)
      ? raw.prompt_tokens_details
      : {};
  const outputDetails = isRecord(raw.output_tokens_details)
    ? raw.output_tokens_details
    : isRecord(raw.completion_tokens_details)
      ? raw.completion_tokens_details
      : {};
  // `prompt_cache_hit_tokens` is where DeepSeek's chat-completions responses
  // put cache reads, and the runtime's own adapter reads it ahead of the
  // OpenAI-shaped field. Omitting it here would not lose the tokens — they
  // stay in `prompt_tokens`, and would then be billed as uncached input at
  // fifty times the cached rate.
  const cacheRead = number(
    raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? inputDetails.cached_tokens,
  );
  const cacheWrite = number(
    raw.cache_creation_input_tokens ??
      raw.cache_write_input_tokens ??
      inputDetails.cache_write_tokens ??
      inputDetails.cache_creation_tokens,
  );
  const reasoning = number(outputDetails.reasoning_tokens);
  const totalInput = anthropic ? input + cacheRead + cacheWrite : input;
  return {
    inputTokens: totalInput,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    totalTokens: totalInput + output,
  };
}

function mergeUsage(left: Usage | null, right: Usage | null): Usage | null {
  if (!right) return left;
  if (!left) return right;
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    reasoningTokens: Math.max(left.reasoningTokens, right.reasoningTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
  };
}

function addUsage(target: Usage, value: Usage): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cacheReadTokens += value.cacheReadTokens;
  target.cacheWriteTokens += value.cacheWriteTokens;
  target.reasoningTokens += value.reasoningTokens;
  target.totalTokens = target.inputTokens + target.outputTokens;
}

function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function readRequest(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once('end', () => resolveBody(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function joinUpstream(baseUrl: string, requestUrl: string): string {
  const base = new URL(baseUrl);
  const request = new URL(requestUrl, 'http://maka-eval.local');
  base.pathname = `${base.pathname.replace(/\/$/u, '')}/${request.pathname.replace(/^\//u, '')}`;
  base.search = request.search;
  return base.toString();
}

function fileArtifact(kind: string, path: string, selected: Profile): Record<string, unknown> {
  const bytes = statSync(path).size;
  return {
    kind,
    profile: selected,
    path: `/logs/agent/${basename(path)}`,
    bytes,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

async function writePolicy(directory: string, name: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(directory, 0o755);
  const path = join(directory, name);
  await writeFile(path, contents, { mode: 0o644 });
  await chmod(path, 0o644);
}

function rooted(root: string, absolutePath: string): string {
  return root === '/' ? absolutePath : join(root, absolutePath.replace(/^\//u, ''));
}

function removeCredential(): void {
  if (credentialPath) rmSync(credentialPath, { force: true });
}

function safeFailure(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (/toolchain (?:fingerprint|checksum|path)/u.test(error.message)) return error.message;
  if (/credential is missing/u.test(error.message)) return error.message;
  if (/workspace ownership/u.test(error.message)) return error.message;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function writeState(phase: string, detail: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    statePath,
    `${JSON.stringify({ schemaVersion: 1, profile, phase, ...detail })}\n`,
    { mode: 0o600 },
  );
}
