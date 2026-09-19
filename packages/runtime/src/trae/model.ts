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

import { traePublicProfile, TRAE_PUBLIC_CHAT_PATH } from './public-protocol.js';
import { redactSecrets } from '@maka/core/redaction';
import { randomUUID } from 'node:crypto';
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { TRAE, traeHeaders, record } from './protocol.js';
import { traeMessages, traeToolSchema } from './messages.js';
import { traeSse, TraeStreamTruncatedError } from './sse.js';

export function createTraeModel(input: {
  connection: RuntimeExecutionConnection;
  modelId: string;
  apiKey: string;
  fetch: typeof fetch;
  sessionId?: string;
}): LanguageModelV4 {
  const metadata = input.connection.models?.find((model) => model.id === input.modelId);
  const model = metadata?.trae;
  if (!model) throw new Error('Refresh the Trae model catalog before using this model');
  const sessionId = input.sessionId ?? randomUUID();
  const doStream: LanguageModelV4['doStream'] = async (options) => {
    const controller = new AbortController();
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, controller.signal])
      : controller.signal;
    const messages = traeMessages(options.prompt, model);
    const effort = options.providerOptions?.trae?.reasoningEffort;
    if (
      effort !== undefined &&
      (typeof effort !== 'string' || !model.reasoningEfforts.includes(effort))
    )
      throw new Error('Unsupported Trae reasoning effort');
    const tools = options.toolChoice?.type === 'none' ? [] : (options.tools ?? []);
    if (tools.some((tool) => tool.type !== 'function'))
      throw new Error('Trae only supports function tools');
    if (options.toolChoice?.type === 'required' || options.toolChoice?.type === 'tool')
      throw new Error('Trae does not expose forced tool selection');
    if (options.responseFormat?.type === 'json')
      throw new Error('Trae does not expose structured output constraints');
    const requestId = randomUUID();
    const employeeBody = {
      config_name: model.configName,
      model_name: model.modelName,
      messages,
      ...(tools.length
        ? {
            tools: tools
              .filter((tool) => tool.type === 'function')
              .map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description ?? '',
                  parameters: JSON.stringify(traeToolSchema(tool.inputSchema)),
                },
              })),
          }
        : {}),
      session_id: sessionId,
      conversation_id: requestId,
      is_preset: true,
      access_type: 4,
      max_tokens: Math.min(
        options.maxOutputTokens ?? metadata?.maxOutputTokens ?? 8192,
        metadata?.maxOutputTokens ?? Infinity,
      ),
      parallel_tool_calls: true,
      ...(effort ? { reasoning_effort: effort === 'ultra' ? 'max' : effort } : {}),
      user_input:
        [...messages]
          .reverse()
          .find((message) => message.role === 'user')
          ?.content.filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n') ?? '',
    };
    const account = input.connection.traeAccount;
    const profile = account && account !== 'employee' ? traePublicProfile(account) : undefined;
    if (profile && (!model.function || !profile.functions.includes(model.function))) {
      throw new Error('Refresh the Trae model catalog before using this account');
    }
    const body = profile
      ? {
          model: model.configName,
          config_name: model.configName,
          function: model.function,
          stream: true,
          messages,
          ...(employeeBody.tools ? { tools: employeeBody.tools } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
        }
      : employeeBody;
    const url = profile
      ? `${profile.baseUrl}${TRAE_PUBLIC_CHAT_PATH}`
      : `${TRAE.baseUrl}${TRAE.chatPath}`;
    const response = await input.fetch(url, {
      method: 'POST',
      headers: {
        ...options.headers,
        ...(profile ? { 'content-type': 'application/json' } : traeHeaders(input.apiKey)),
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new APICallError({
        message: `Trae request failed: HTTP ${response.status}`,
        url,
        requestBodyValues: undefined,
        statusCode: response.status,
        isRetryable: response.status === 429 || response.status >= 500,
      });
    }
    if (!response.body) throw new Error('Trae returned an empty response');
    const iterator = streamParts(
      response.body,
      tools.map((tool) => tool.name),
      signal,
      !!profile,
    );
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          controller.abort();
          await iterator.return(undefined);
        },
      }),
    };
  };
  return {
    specificationVersion: 'v4',
    provider: 'trae',
    modelId: input.modelId,
    supportedUrls: {},
    doStream,
    async doGenerate(options: LanguageModelV4CallOptions) {
      const result = await doStream(options);
      const content: LanguageModelV4Content[] = [];
      let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined;
      for await (const part of result.stream) {
        if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
          const type = part.type === 'text-delta' ? 'text' : 'reasoning';
          const last = content.at(-1);
          if (last?.type === type) last.text += part.delta;
          else content.push({ type, text: part.delta });
        } else if (part.type === 'tool-call') content.push(part);
        else if (part.type === 'finish') finish = part;
        else if (part.type === 'error') throw part.error;
      }
      if (!finish)
        throw new TraeStreamTruncatedError('Trae stream ended without a completion event');
      return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [] };
    },
  };
}

async function* streamParts(
  body: ReadableStream<Uint8Array>,
  toolNames: string[],
  signal: AbortSignal,
  publicWire = false,
): AsyncGenerator<LanguageModelV4StreamPart> {
  yield { type: 'stream-start', warnings: [] };
  const calls = new Map<number, { id?: string; name: string; arguments: string }>();
  let text = false;
  let reasoning = false;
  let queued = false;
  let usage = usageFrom({});
  for await (const frame of traeSse(body, signal)) {
    const data = record(frame.data) ?? {};
    if (frame.event === 'error') {
      const code =
        typeof data.code === 'number' || typeof data.code === 'string'
          ? String(data.code).slice(0, 32)
          : 'unknown';
      // Trae explains most rejections only in this frame; keep that text so a
      // code the adapter does not know is still actionable for the user.
      const detail =
        typeof data.message === 'string' && data.message.trim()
          ? `: ${redactSecrets(data.message.trim()).slice(0, 200)}`
          : '';
      // 1005 is an entitlement refusal: `extra` names the plan the model needs.
      let plan: unknown;
      try {
        plan = record(typeof data.extra === 'string' ? JSON.parse(data.extra) : data.extra)?.plan;
      } catch {
        /* No plan detail; the code alone still names the refusal. */
      }
      throw Object.assign(
        new Error(
          code === '4008'
            ? 'Trae account quota exhausted'
            : code === '1005'
              ? `Trae subscription does not include this model${plan === undefined ? '' : ` (requires plan ${String(plan).slice(0, 16)})`}`
              : `Trae stream failed (code ${code})${detail}`,
        ),
        { code: `trae_${code}` },
      );
    }
    if (frame.event === 'queue_begin' || frame.event === 'request_wait_in_queue') {
      queued = true;
      yield {
        type: 'raw',
        rawValue: {
          type: 'trae-queue',
          queued: true,
          ...(Number.isSafeInteger(data.position) && Number(data.position) >= 0
            ? { position: data.position }
            : {}),
        },
      };
    } else if (frame.event === 'queue_end') {
      queued = false;
      yield { type: 'raw', rawValue: { type: 'trae-queue', queued: false } };
    } else if (frame.event === 'token_usage') {
      usage = usageFrom(data);
      yield { type: 'raw', rawValue: { type: 'trae-heartbeat' } };
    } else if (frame.event === 'output') {
      yield { type: 'raw', rawValue: { type: 'trae-heartbeat' } };
      if (queued) {
        queued = false;
        yield { type: 'raw', rawValue: { type: 'trae-queue', queued: false } };
      }
      if (typeof data.reasoning_content === 'string' && data.reasoning_content.length) {
        if (!reasoning) {
          reasoning = true;
          yield { type: 'reasoning-start', id: 'reasoning' };
        }
        yield { type: 'reasoning-delta', id: 'reasoning', delta: data.reasoning_content };
      }
      if (typeof data.response === 'string' && data.response.length) {
        if (!text) {
          text = true;
          yield { type: 'text-start', id: 'text' };
        }
        yield { type: 'text-delta', id: 'text', delta: data.response };
      }
      if (Array.isArray(data.tool_calls))
        for (const value of data.tool_calls) {
          const raw = record(value);
          const fn = record(raw?.function_call) ?? record(raw?.function);
          const existingIndex = raw?.id
            ? [...calls].find(([, call]) => call.id === raw.id)?.[0]
            : undefined;
          const nextIndex = calls.size ? Math.max(...calls.keys()) + 1 : 0;
          const inferredIndex = raw?.id
            ? (existingIndex ?? nextIndex)
            : calls.size <= 1
              ? (calls.keys().next().value ?? 0)
              : undefined;
          const candidate = raw?.index ?? (publicWire ? inferredIndex : undefined);
          if (!raw || !fn || !Number.isSafeInteger(candidate) || Number(candidate) < 0)
            throw new Error('Invalid Trae tool call');
          const index = Number(candidate);
          const call = calls.get(index) ?? { name: '', arguments: '' };
          // A fragment may repeat its tool name, but cannot rebind accumulated
          // arguments to another tool, even when the wire omits identity.
          if (typeof fn.name === 'string' && fn.name && call.name && fn.name !== call.name)
            throw new Error('Trae tool call changed its name');
          if (typeof raw.id === 'string' && raw.id) call.id = raw.id;
          if (typeof fn.name === 'string' && fn.name) call.name = fn.name;
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          if (call.arguments.length > 4 * 1024 * 1024 || calls.size > 1024)
            throw new Error('Trae tool call exceeded its limit');
          calls.set(index, call);
        }
    } else if (frame.event === 'done') {
      if (queued) yield { type: 'raw', rawValue: { type: 'trae-queue', queued: false } };
      if (reasoning) yield { type: 'reasoning-end', id: 'reasoning' };
      if (text) yield { type: 'text-end', id: 'text' };
      const raw = typeof data.finish_reason === 'string' ? data.finish_reason : '';
      const truncated = raw === 'length' || raw === 'max_output_tokens';
      if (!['', 'stop', 'tool_calls', 'length', 'max_output_tokens'].includes(raw))
        throw new Error('Trae did not complete the response successfully');
      if (!truncated && !text && calls.size === 0)
        throw new Error('Trae returned no usable output');
      if (raw === 'tool_calls' && calls.size === 0) throw new Error('Trae returned no tool calls');
      if (!truncated)
        for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
          if (!call.name || !toolNames.includes(call.name))
            throw new Error('Trae returned an unknown tool');
          const args = call.arguments || '{}';
          JSON.parse(args); // Never execute a truncated or malformed tool call.
          yield {
            type: 'tool-call',
            toolCallId: call.id ?? randomUUID(),
            toolName: call.name,
            input: args,
          };
        }
      yield {
        type: 'finish',
        usage,
        finishReason: {
          unified: truncated
            ? 'length'
            : calls.size
              ? 'tool-calls'
              : raw === '' || raw === 'stop'
                ? 'stop'
                : 'other',
          raw,
        },
      };
      return;
    } else {
      // A heartbeat is activity, but is never exposed as model output.
      yield { type: 'raw', rawValue: { type: 'trae-heartbeat' } };
    }
  }
  throw new TraeStreamTruncatedError('Trae stream disconnected before completion');
}
function usageFrom(data: Record<string, unknown>): LanguageModelV4Usage {
  const number = (key: string) =>
    typeof data[key] === 'number' && Number.isSafeInteger(data[key]) && Number(data[key]) >= 0
      ? Number(data[key])
      : undefined;
  return {
    inputTokens: {
      total: number('prompt_tokens'),
      noCache: undefined,
      cacheRead: number('cache_read_input_tokens'),
      cacheWrite: number('cache_creation_input_tokens'),
    },
    outputTokens: {
      total: number('completion_tokens'),
      text: undefined,
      reasoning: number('reasoning_tokens'),
    },
  };
}
