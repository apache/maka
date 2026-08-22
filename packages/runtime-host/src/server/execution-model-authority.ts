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

import { randomUUID } from 'node:crypto';
import {
  authorizeConnectionModel,
  PROVIDER_DEFAULTS,
  type RuntimeExecutionConnection,
} from '@maka/core/llm-connections';
import { isModelExplicitlyUnsupportedForChat } from '@maka/core/model-catalog';
import { parseRequestHeaders, type RuntimePolicy } from '@maka/core/runtime-policy';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import type { ModelCallKind } from '@maka/core/usage-stats/types';
import {
  buildPricingLookup,
  llmCallUsageFields,
  recordLlmCallStrict,
} from '@maka/runtime/telemetry';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import { buildSessionRecapMessages } from '@maka/runtime/session-recap';
import {
  buildSessionTitlePrompt,
  cleanGeneratedSessionTitle,
  SESSION_TITLE_GENERATION_TIMEOUT_MS,
} from '@maka/runtime/session-title';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import {
  generateToolFreeModelCall,
  generateProviderPrefixModelCall,
  type ToolFreeModelCallContent,
  ProviderPrefixModelCallUnavailableError,
} from '@maka/runtime/tool-free-model-call';
import { modelUsesAnthropicMessages } from '@maka/runtime/model-runtime';
import { type BackendFactoryContext } from '@maka/runtime/session-manager';
import { type GoalEvaluatorResource } from '@maka/runtime/goal-evaluator';
import { type ModelMessage } from '@maka/runtime/model-protocol';
import {
  memoryExtractionMaxOutputTokens,
  type MemoryExtractionSourceSnapshot,
} from '@maka/runtime/memory-extraction';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import {
  createHostOAuthModelFetch,
  OAuthExecutionCredentialError,
  type HostOAuthExecutionAuthority,
  type HostOAuthExecutionBinding,
} from './oauth-execution-authority.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

export interface HostGoalEvaluatorInput {
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly oauthCredentials: HostOAuthExecutionAuthority;
  readonly usage: InteractiveUsageStoresWriter;
  readonly requestDrain: () => void;
  readonly readSessionHeader: (sessionId: string) => Promise<SessionHeader>;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export type HostAuxiliaryModelFailureClass =
  | 'aborted'
  | 'timeout'
  | 'configuration'
  | 'provider'
  | 'persistence'
  | 'unknown';

export type HostSessionRecapModelResult =
  | {
      readonly ok: true;
      readonly modelId: string;
      readonly messages: readonly ModelMessage[];
      readonly raw: string;
    }
  | {
      readonly ok: false;
      readonly modelId?: string;
      readonly messages?: readonly ModelMessage[];
      readonly errorClass: Exclude<HostAuxiliaryModelFailureClass, 'persistence'>;
    }
  | {
      readonly ok: false;
      readonly modelId?: string;
      readonly messages?: readonly ModelMessage[];
      readonly errorClass: 'persistence';
    };

export interface HostSessionEffectModel {
  generateTitle(input: {
    readonly sessionId: string;
    readonly header: SessionHeader;
    readonly sourceText: string;
    readonly abortSignal: AbortSignal;
  }): Promise<string | undefined>;
  generateRecap(input: {
    readonly sessionId: string;
    readonly effectId: string;
    readonly header: SessionHeader;
    readonly events: readonly RuntimeEvent[];
    readonly abortSignal: AbortSignal;
  }): Promise<HostSessionRecapModelResult>;
}

export type HostSessionEffectModelInput = Omit<HostGoalEvaluatorInput, 'readSessionHeader'>;

export type HostDailyReviewModelResult =
  | { readonly ok: true; readonly text: string; readonly modelKey: string }
  | {
      readonly ok: false;
      readonly errorClass: HostAuxiliaryModelFailureClass;
    };

export interface HostDailyReviewModel {
  generate(input: {
    readonly modelKey: string;
    readonly prompt: string;
    readonly abortSignal: AbortSignal;
  }): Promise<HostDailyReviewModelResult>;
}

export interface HostMemoryExtractionModel {
  generate(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly prompt: string;
    readonly stage: 'proposal' | 'localized' | 'canonicalize';
    readonly abortSignal: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly errorClass: HostAuxiliaryModelFailureClass }
  >;
}

/** Creates bounded extraction calls on the source Session's model authority. */
export function createHostMemoryExtractionModel(
  input: HostSessionEffectModelInput,
): HostMemoryExtractionModel {
  const authority = createAuxiliaryModelCallAuthority(input);
  return Object.freeze({
    generate: async ({
      snapshot,
      prompt,
      stage,
      abortSignal,
    }: Parameters<HostMemoryExtractionModel['generate']>[0]) => {
      try {
        const maxOutputTokens = memoryExtractionMaxOutputTokens(snapshot);
        const result = await runHostAuxiliaryModelCall(authority, {
          transportContextId: snapshot.sessionId,
          telemetrySessionId: snapshot.sessionId,
          header: snapshot.sourceHeader,
          callKind: 'memory_extraction',
          callId: `memory_${stage}_${authority.newId()}`,
          abortSignal,
          buildRequest: () =>
            stage === 'canonicalize'
              ? {
                  prompt,
                  maxOutputTokens,
                  maxRetries: 0,
                }
              : snapshot.trigger === 'compaction'
                ? {
                    messages: [...snapshot.sourceMessages, { role: 'user', content: prompt }],
                    maxOutputTokens,
                    maxRetries: 0,
                  }
                : {
                    ...(snapshot.sourceSystemPrompt ? { system: snapshot.sourceSystemPrompt } : {}),
                    messages: [...snapshot.sourceMessages, { role: 'user', content: prompt }],
                    tools: snapshot.sourceTools,
                    activeTools: snapshot.sourceActiveTools,
                    ...(snapshot.sourceProviderOptions
                      ? { providerOptions: snapshot.sourceProviderOptions }
                      : {}),
                    maxOutputTokens,
                  },
        });
        return { ok: true as const, text: result.text };
      } catch (error) {
        return {
          ok: false as const,
          errorClass: auxiliaryModelErrorClass(error, abortSignal),
        };
      }
    },
  });
}

/** Creates root-scoped Daily Review calls on the canonical Host model authority. */
export function createHostDailyReviewModel(
  input: HostSessionEffectModelInput,
): HostDailyReviewModel {
  const authority = createAuxiliaryModelCallAuthority(input);
  return Object.freeze({
    generate: async ({
      modelKey,
      prompt,
      abortSignal,
    }: Parameters<HostDailyReviewModel['generate']>[0]) => {
      const effectiveAbortSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(60_000)]);
      try {
        const header = await readAuxiliaryPreflight(authority, effectiveAbortSignal, () =>
          resolveDailyReviewHeader(authority.runtimePolicy, modelKey),
        );
        const result = await runHostAuxiliaryModelCall(authority, {
          transportContextId: 'daily-review',
          header,
          callKind: 'daily_review',
          callId: `daily_review_${authority.newId()}`,
          abortSignal: effectiveAbortSignal,
          buildRequest: () => ({ prompt, maxOutputTokens: 2_048 }),
        });
        return {
          ok: true as const,
          text: result.text,
          modelKey: `${header.llmConnectionSlug}::${result.modelId}`,
        };
      } catch (error) {
        return {
          ok: false as const,
          errorClass: auxiliaryModelErrorClass(error, effectiveAbortSignal),
        };
      }
    },
  });
}

/** Creates tool-free Session title and recap calls on canonical Host model authority. */
export function createHostSessionEffectModel(
  input: HostSessionEffectModelInput,
): HostSessionEffectModel {
  const authority = createAuxiliaryModelCallAuthority(input);
  return Object.freeze({
    generateTitle: async ({
      sessionId,
      header,
      sourceText,
      abortSignal: callerAbortSignal,
    }: Parameters<HostSessionEffectModel['generateTitle']>[0]) => {
      if (!sourceText.trim()) return undefined;
      const abortSignal = AbortSignal.any([
        callerAbortSignal,
        AbortSignal.timeout(SESSION_TITLE_GENERATION_TIMEOUT_MS),
      ]);
      try {
        const result = await runHostAuxiliaryModelCall(authority, {
          transportContextId: sessionId,
          telemetrySessionId: sessionId,
          header,
          callKind: 'session_title',
          callId: `session_title_${sessionId}_${authority.newId()}`,
          abortSignal,
          buildRequest: () => ({
            prompt: buildSessionTitlePrompt(sourceText),
            maxOutputTokens: 1_024,
          }),
        });
        return result.finishReason === 'length'
          ? undefined
          : cleanGeneratedSessionTitle(result.text);
      } catch {
        return undefined;
      }
    },
    generateRecap: async ({
      sessionId,
      effectId,
      header,
      events,
      abortSignal: callerAbortSignal,
    }: Parameters<HostSessionEffectModel['generateRecap']>[0]) => {
      const abortSignal = AbortSignal.any([callerAbortSignal, AbortSignal.timeout(30_000)]);
      let modelId: string | undefined;
      let messages: readonly ModelMessage[] | undefined;
      try {
        const result = await runHostAuxiliaryModelCall(authority, {
          transportContextId: sessionId,
          telemetrySessionId: sessionId,
          header,
          callKind: 'session_recap',
          callId: `session_recap_${sessionId}_${effectId}`,
          abortSignal,
          buildRequest: (target) => {
            modelId = target.model;
            messages = buildSessionRecapMessages({
              events,
              connection: target.connection,
              modelId: target.model,
            });
            return { messages, maxOutputTokens: 1_024 };
          },
        });
        return {
          ok: true as const,
          modelId: result.modelId,
          messages: messages ?? [],
          raw: result.text,
        };
      } catch (error) {
        return {
          ok: false as const,
          ...(modelId ? { modelId } : {}),
          ...(messages ? { messages } : {}),
          errorClass: auxiliaryModelErrorClass(error, abortSignal),
        };
      }
    },
  });
}

/** Creates a tool-free Goal judge on the Session's canonical connection and model. */
export function createHostGoalEvaluator(input: HostGoalEvaluatorInput): GoalEvaluatorResource {
  const authority = createAuxiliaryModelCallAuthority(input);
  return createOwnedGoalEvaluator({
    evaluate: async (prompt, sessionId, signal) => {
      const header = await readDuringBackendCreation(
        () => input.readSessionHeader(sessionId),
        signal,
      );
      return (
        await runHostAuxiliaryModelCall(authority, {
          transportContextId: sessionId,
          telemetrySessionId: sessionId,
          header,
          callKind: 'goal_evaluation',
          callId: `goal_evaluation_${sessionId}_${authority.newId()}`,
          abortSignal: signal,
          buildRequest: () => ({ prompt, maxOutputTokens: 1_024 }),
        })
      ).text;
    },
  });
}

type AuxiliaryModelCallAuthorityInput = Pick<
  HostGoalEvaluatorInput,
  | 'runtimePolicy'
  | 'oauthCredentials'
  | 'usage'
  | 'requestDrain'
  | 'createFetchTransport'
  | 'now'
  | 'newId'
>;

interface AuxiliaryModelCallAuthority {
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly oauthCredentials: HostOAuthExecutionAuthority;
  readonly usage: InteractiveUsageStoresWriter;
  readonly createFetchTransport: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly telemetry: {
    insertLlmCall(
      record: Parameters<InteractiveUsageStoresWriter['telemetry']['recordLlmCall']>[0],
    ): Promise<void>;
  };
  readonly requestDrain: () => void;
  readonly now: () => number;
  readonly newId: () => string;
}

type AuxiliaryModelRequest =
  | (ToolFreeModelCallContent & {
      readonly maxOutputTokens: number;
      readonly maxRetries?: number;
      readonly system?: string;
      readonly providerOptions?: Record<string, unknown>;
      readonly tools?: never;
    })
  | {
      readonly messages: readonly ModelMessage[];
      readonly system?: string;
      readonly tools: MemoryExtractionSourceSnapshot['sourceTools'];
      readonly activeTools: readonly string[];
      readonly providerOptions?: Record<string, unknown>;
      readonly maxOutputTokens?: number;
    };

interface HostAuxiliaryModelCallInput {
  readonly transportContextId: string;
  readonly telemetrySessionId?: string;
  readonly header: Pick<SessionHeader, 'llmConnectionSlug' | 'model' | 'thinkingLevel'>;
  readonly callKind: Exclude<ModelCallKind, 'main'>;
  readonly callId: string;
  readonly abortSignal: AbortSignal;
  readonly buildRequest: (target: ResolvedExecutionTarget) => AuxiliaryModelRequest;
}

function createAuxiliaryModelCallAuthority(
  input: AuxiliaryModelCallAuthorityInput,
): AuxiliaryModelCallAuthority {
  let drainRequested = false;
  const requestDrain = () => {
    if (drainRequested) return;
    drainRequested = true;
    input.requestDrain();
  };
  return {
    runtimePolicy: input.runtimePolicy,
    oauthCredentials: input.oauthCredentials,
    usage: input.usage,
    createFetchTransport: input.createFetchTransport ?? createProxiedFetchTransport,
    telemetry: {
      insertLlmCall: async (record) => {
        try {
          await input.usage.telemetry.recordLlmCall(record);
        } catch (error) {
          requestDrain();
          throw error;
        }
      },
    },
    requestDrain,
    now: input.now ?? Date.now,
    newId: input.newId ?? randomUUID,
  };
}

async function runHostAuxiliaryModelCall(
  authority: AuxiliaryModelCallAuthority,
  input: HostAuxiliaryModelCallInput,
): Promise<{
  readonly text: string;
  readonly finishReason?: string;
  readonly modelId: string;
}> {
  const target = await readAuxiliaryPreflight(authority, input.abortSignal, () =>
    readDuringBackendCreation(
      () =>
        resolveExecutionTarget(
          input.header,
          authority.runtimePolicy,
          authority.oauthCredentials,
          authority.createFetchTransport,
        ),
      input.abortSignal,
    ),
  );
  const pricingSnapshot = await readAuxiliaryPreflight(authority, input.abortSignal, () =>
    readDuringBackendCreation(() => authority.usage.pricing.snapshot(), input.abortSignal),
  );
  const request = input.buildRequest(target);
  const pricing = buildPricingLookup(pricingSnapshot.overrides);
  const transport = authority.createFetchTransport(
    toRuntimePolicyProxy(target.networkProxy, target.proxySecret),
  );
  let apiKey = target.apiKey;
  let modelFetch: typeof fetch = transport.fetch;
  let readDeferredOAuthFailure: (() => unknown | undefined) | undefined;
  try {
    if (target.oauthBinding) {
      const oauth = normalizeAuxiliaryOAuthBinding(authority, target.oauthBinding);
      readDeferredOAuthFailure = oauth.readDeferredFailure;
      const initialOAuthTokens = await readDuringBackendCreation(
        () => oauth.binding.resolve(),
        input.abortSignal,
      );
      apiKey = initialOAuthTokens.access_token;
      modelFetch = createHostOAuthModelFetch({
        binding: oauth.binding,
        initialTokens: initialOAuthTokens,
        connection: target.connection,
        sessionId: input.transportContextId,
        modelId: target.model,
        fetchFn: transport.fetch,
      });
    }
    const startedAt = authority.now();
    const baseRecord = {
      ...(input.telemetrySessionId ? { sessionId: input.telemetrySessionId } : {}),
      callKind: input.callKind,
      callId: input.callId,
      connectionSlug: target.connection.slug,
      providerId: target.connection.providerType,
      modelId: target.model,
      startedAt,
    };
    let result:
      | Awaited<ReturnType<typeof generateToolFreeModelCall>>
      | Awaited<ReturnType<typeof generateProviderPrefixModelCall>>;
    try {
      result = await readDuringBackendCreation(() => {
        const providerOptions = buildProviderOptions(
          target.connection,
          target.model,
          input.header.thinkingLevel,
        );
        const model = getAIModel({
          connection: target.connection,
          apiKey,
          modelId: target.model,
          fetch: modelFetch,
          requestHeaders: target.requestHeaders,
        });
        return request.tools !== undefined
          ? generateProviderPrefixModelCall({
              model,
              ...request,
              toolChoicePolicy: modelUsesAnthropicMessages(target.connection, target.model)
                ? 'omit'
                : 'none',
              abortSignal: input.abortSignal,
              providerOptions: request.providerOptions ?? providerOptions,
            })
          : generateToolFreeModelCall({
              model,
              ...request,
              abortSignal: input.abortSignal,
              providerOptions: request.providerOptions ?? providerOptions,
            });
      }, input.abortSignal);
      const oauthFailure = readDeferredOAuthFailure?.();
      if (oauthFailure) throw oauthFailure;
    } catch (error) {
      const effectiveError = readDeferredOAuthFailure?.() ?? error;
      try {
        await recordLlmCallStrict(
          { repo: authority.telemetry, lookupPricing: pricing },
          {
            ...baseRecord,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Math.max(0, authority.now() - startedAt),
            status: input.abortSignal.aborted ? 'aborted' : 'error',
            errorClass: evaluatorErrorClass(effectiveError),
          },
        );
      } catch (accountingError) {
        throw new AuxiliaryModelCallLocalError('accounting', accountingError);
      }
      throw effectiveError;
    }
    try {
      await recordLlmCallStrict(
        { repo: authority.telemetry, lookupPricing: pricing },
        {
          ...baseRecord,
          ...(result.usage
            ? llmCallUsageFields(result.usage)
            : { inputTokens: 0, outputTokens: 0 }),
          ...(result.finishReason && !result.usage ? { rawFinishReason: result.finishReason } : {}),
          latencyMs: Math.max(0, authority.now() - startedAt),
          status: 'success',
        },
      );
    } catch (accountingError) {
      throw new AuxiliaryModelCallLocalError('accounting', accountingError);
    }
    return {
      text: result.text,
      modelId: target.model,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    };
  } finally {
    try {
      await transport.close();
    } catch (cleanupError) {
      authority.requestDrain();
      throw new AuxiliaryModelCallLocalError('cleanup', cleanupError);
    }
  }
}

class AuxiliaryModelCallLocalError extends Error {
  constructor(
    readonly phase: 'preflight' | 'accounting' | 'cleanup',
    cause: unknown,
  ) {
    super(`Auxiliary model call ${phase} failed`, { cause });
    this.name = 'AuxiliaryModelCallLocalError';
  }
}

async function readAuxiliaryPreflight<T>(
  authority: AuxiliaryModelCallAuthority,
  abortSignal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      abortSignal.aborted &&
      !(
        error instanceof AuxiliaryModelCallLocalError ||
        (error instanceof OAuthExecutionCredentialError && error.code === 'persistence_failed')
      )
    ) {
      throw error;
    }
    throw normalizeAuxiliaryAuthorityError(authority, error);
  }
}

function normalizeAuxiliaryOAuthBinding(
  authority: AuxiliaryModelCallAuthority,
  binding: HostOAuthExecutionBinding,
): {
  readonly binding: HostOAuthExecutionBinding;
  readonly readDeferredFailure: () => unknown | undefined;
} {
  let deferredFailure: unknown;
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeAuxiliaryAuthorityError(authority, error);
      if (
        deferredFailure === undefined &&
        (normalized instanceof AuxiliaryModelCallLocalError ||
          normalized instanceof AuxiliaryModelCallConfigurationError)
      ) {
        deferredFailure = normalized;
      }
      throw normalized;
    }
  };
  return Object.freeze({
    binding: Object.freeze({
      providerType: binding.providerType,
      connectionSlug: binding.connectionSlug,
      resolve: () => read(() => binding.resolve()),
      ...(binding.forceRefresh ? { forceRefresh: () => read(() => binding.forceRefresh!()) } : {}),
    }),
    readDeferredFailure: () => deferredFailure,
  });
}

function normalizeAuxiliaryAuthorityError(
  authority: AuxiliaryModelCallAuthority,
  error: unknown,
): unknown {
  if (
    error instanceof AuxiliaryModelCallConfigurationError ||
    error instanceof AuxiliaryModelCallLocalError
  ) {
    return error;
  }
  if (error instanceof OAuthExecutionCredentialError) {
    switch (error.code) {
      case 'credential_unavailable':
      case 'credential_superseded':
        return new AuxiliaryModelCallConfigurationError(error.message, { cause: error });
      case 'refresh_failed':
        return error;
      case 'persistence_failed':
        authority.requestDrain();
        return new AuxiliaryModelCallLocalError('preflight', error);
    }
  }
  authority.requestDrain();
  return new AuxiliaryModelCallLocalError('preflight', error);
}

function createOwnedGoalEvaluator(
  evaluator: Pick<GoalEvaluatorResource, 'evaluate'>,
): GoalEvaluatorResource {
  const active = new Set<Promise<void>>();
  let closing = false;
  let closeTask: Promise<void> | undefined;
  return {
    evaluate: (prompt, sessionId, signal) => {
      if (closing) return Promise.reject(new Error('Goal evaluator is closing'));
      const task = evaluator.evaluate(prompt, sessionId, signal);
      const settled = task.then(
        () => undefined,
        () => undefined,
      );
      active.add(settled);
      void settled.finally(() => active.delete(settled));
      return task;
    },
    close: () => {
      closing = true;
      closeTask ??= Promise.all([...active]).then(() => undefined);
      return closeTask;
    },
  };
}

function evaluatorErrorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function auxiliaryModelErrorClass(
  error: unknown,
  abortSignal: AbortSignal,
): HostAuxiliaryModelFailureClass {
  if (error instanceof AuxiliaryModelCallLocalError) return 'persistence';
  if (abortSignal.aborted) {
    const reason = abortSignal.reason;
    return reason instanceof Error && reason.name === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  if (!(error instanceof Error)) return 'unknown';
  if (error instanceof ProviderPrefixModelCallUnavailableError) return 'configuration';
  if (error instanceof AuxiliaryModelCallConfigurationError) return 'configuration';
  return 'provider';
}

class AuxiliaryModelCallConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuxiliaryModelCallConfigurationError';
  }
}

interface ResolvedExecutionTarget {
  readonly connection: RuntimeExecutionConnection;
  readonly model: string;
  readonly apiKey: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly oauthBinding?: HostOAuthExecutionBinding;
  readonly networkProxy: RuntimePolicy['networkProxy'];
  readonly proxySecret?: string;
}

async function resolveDailyReviewHeader(
  runtimePolicy: RuntimePolicyStoresWriter,
  modelKey: string,
): Promise<Pick<SessionHeader, 'llmConnectionSlug' | 'model' | 'thinkingLevel'>> {
  const explicit = parseDailyReviewModelKey(modelKey);
  if (modelKey.trim() && !explicit) {
    throw new AuxiliaryModelCallConfigurationError('Daily Review model key is invalid');
  }
  if (explicit) {
    return {
      llmConnectionSlug: explicit.connectionSlug,
      model: explicit.modelId,
      thinkingLevel: 'off',
    };
  }
  const catalog = await runtimePolicy.connectionCatalog.getSnapshot();
  const target = catalog.defaultTarget;
  const connection = target
    ? catalog.connections.find((candidate) => candidate.connectionId === target.connectionId)
    : undefined;
  if (!target || !connection) {
    throw new AuxiliaryModelCallConfigurationError(
      'Daily Review has no canonical default model target',
    );
  }
  return {
    llmConnectionSlug: connection.slug,
    model: target.modelId,
    thinkingLevel: 'off',
  };
}

function parseDailyReviewModelKey(
  modelKey: string,
): { readonly connectionSlug: string; readonly modelId: string } | undefined {
  const trimmed = modelKey.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf('::');
  if (separator <= 0 || separator >= trimmed.length - 2) return undefined;
  const connectionSlug = trimmed.slice(0, separator).trim();
  const modelId = trimmed.slice(separator + 2).trim();
  return connectionSlug && modelId ? { connectionSlug, modelId } : undefined;
}

export async function resolveExecutionTarget(
  header: Pick<BackendFactoryContext['header'], 'llmConnectionSlug' | 'model' | 'thinkingLevel'>,
  runtimePolicy: {
    readonly operations: Pick<
      RuntimePolicyStoresWriter['operations'],
      'resolveExecutionConnection'
    >;
  },
  oauthCredentials: HostOAuthExecutionAuthority,
  createFetchTransport: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport,
): Promise<ResolvedExecutionTarget> {
  const resolved = await runtimePolicy.operations.resolveExecutionConnection(
    header.llmConnectionSlug,
  );
  if (resolved.kind !== 'ready') {
    throw new AuxiliaryModelCallConfigurationError(
      `Runtime Host model connection is not ready: ${resolved.kind}`,
    );
  }
  const provider = PROVIDER_DEFAULTS[resolved.connection.providerType];
  if (!provider) {
    throw new AuxiliaryModelCallConfigurationError('Runtime Host model provider is not executable');
  }
  const model = header.model.trim();
  const discovered = resolved.connection.models.some((candidate) => candidate.id === model);
  const modelInfo = authorizeConnectionModel(resolved.connection, model);
  if (!model || !modelInfo) {
    throw new AuxiliaryModelCallConfigurationError(
      'Runtime Host Session model is not enabled by its canonical connection',
    );
  }
  if (isModelExplicitlyUnsupportedForChat(modelInfo)) {
    throw new AuxiliaryModelCallConfigurationError(
      'Runtime Host Session model is not chat-capable',
    );
  }

  // Relay profiles are part of the canonical connection so provider options
  // and declared model capabilities derive from the same policy snapshot.
  const connection: RuntimeExecutionConnection = {
    slug: resolved.connection.slug,
    providerType: resolved.connection.providerType,
    ...(resolved.connection.baseUrl ? { baseUrl: resolved.connection.baseUrl } : {}),
    defaultModel: model,
    models: discovered
      ? [...resolved.connection.models]
      : [...resolved.connection.models, modelInfo],
    ...(resolved.connection.relayModelProfiles === undefined
      ? {}
      : { relayModelProfiles: resolved.connection.relayModelProfiles }),
    ...(resolved.connection.requestBodyOverlay === undefined
      ? {}
      : { requestBodyOverlay: resolved.connection.requestBodyOverlay }),
  };
  const requestHeaders = resolved.secretMaterial.requestHeaders
    ? parseRequestHeaders(resolved.secretMaterial.requestHeaders.secret)
    : {};
  if (provider.authKind === 'oauth_token') {
    const material = resolved.secretMaterial.connection;
    if (!material) {
      throw new AuxiliaryModelCallConfigurationError(
        'Runtime Host OAuth credential is not configured',
      );
    }
    const refreshProxy = toRuntimePolicyProxy(
      resolved.networkProxy,
      resolved.secretMaterial.networkProxy?.secret,
    );
    return {
      connection,
      model,
      apiKey: '',
      requestHeaders,
      oauthBinding: oauthCredentials.bind({
        providerType: resolved.connection.providerType,
        connectionSlug: resolved.connection.slug,
        material,
        createRefreshTransport: () => createFetchTransport(refreshProxy),
      }),
      networkProxy: resolved.networkProxy,
      ...(resolved.secretMaterial.networkProxy
        ? { proxySecret: resolved.secretMaterial.networkProxy.secret }
        : {}),
    };
  }

  return {
    connection,
    model,
    apiKey: resolved.secretMaterial.connection?.secret ?? '',
    requestHeaders,
    networkProxy: resolved.networkProxy,
    ...(resolved.secretMaterial.networkProxy
      ? { proxySecret: resolved.secretMaterial.networkProxy.secret }
      : {}),
  };
}

export function readDuringBackendCreation<T>(
  read: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (!abortSignal) return read();
  if (abortSignal.aborted) return Promise.reject(backendCreationAbortReason(abortSignal));

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(backendCreationAbortReason(abortSignal));
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
  const pending = Promise.resolve().then(() => {
    if (abortSignal.aborted) throw backendCreationAbortReason(abortSignal);
    return read();
  });
  return Promise.race([pending, aborted]).finally(() => {
    if (onAbort) abortSignal.removeEventListener('abort', onAbort);
  });
}

function backendCreationAbortReason(abortSignal: AbortSignal): unknown {
  return (
    abortSignal.reason ??
    new DOMException('Runtime Host backend creation was aborted', 'AbortError')
  );
}
