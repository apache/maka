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

import type { Awaitable, Cancellation, Json, Registration } from './host.js';
import type { HttpRequest, HttpResponse } from './http.js';

type Options = { providerOptions?: Json };
export type ModelContent = Options &
  (
    | { type: 'text'; text: string }
    | { type: 'file'; mediaType: string; data: { type: 'data'; data: string } }
  );
export type ModelToolOutput =
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'json' | 'error-json'; value: Json }
  | { type: 'content'; value: readonly ModelContent[] };
/** providerOptions.maka.notification marks supplemental output, not a second settlement.
 * Native Responses adapters preserve the custom call ID; JSON-only adapters may
 * carry it as a labelled observation. openai.toolKind preserves custom calls in deltas. */
export type ModelToolResult = Options & {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ModelToolOutput;
};
export type ModelAssistantPart = Options &
  (
    | { type: 'text' | 'reasoning'; text: string }
    | {
        type: 'tool-call';
        toolCallId: string;
        toolName: string;
        input: Json;
        providerExecuted?: boolean;
      }
    | ModelToolResult
  );
export type ModelMessage = Options &
  (
    | { role: 'system'; content: string }
    | { role: 'user'; content: readonly ModelContent[] }
    | { role: 'assistant'; content: readonly ModelAssistantPart[] }
    | { role: 'tool'; content: readonly ModelToolResult[] }
  );
export interface ModelRequest {
  provider: {
    kind:
      | 'openai_chat'
      | 'openai_responses'
      | 'anthropic'
      | { openai_compatible: { name: string } }
      | {
          open_responses: {
            reasoningReplay: 'plaintext-content' | 'plaintext-summary';
            compatibility?: 'alibaba-token-plan';
          };
        };
    model: string;
    baseUrl: string;
    headers?: Readonly<Record<string, string>>;
    bodyOverlay?: Readonly<Record<string, Json>> | null;
  } & ({ apiKey: string } | { requestHeaders: Readonly<Record<string, string>> });
  prompt: readonly ModelMessage[];
  tools?: readonly {
    name: string;
    description: string;
    inputSchema: Json;
    freeform?: { syntax: 'lark'; definition: string };
    outputSchema?: Json;
    provider?: { id: string; args: Json };
  }[];
  providerOptions: Json;
  maxOutputTokens?: number | null;
}
export interface ModelUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}
type Metadata = { provider_options: Json | null };
export type ModelEvent =
  | { kind: 'part_started'; data: Metadata & { id: string; text_kind: 'text' | 'thinking' } }
  | { kind: 'part_delta'; data: Metadata & { id: string; text: string } }
  | { kind: 'part_finished'; data: Metadata & { id: string } }
  | {
      kind: 'tool_call';
      data: Metadata & { id: string; name: string; input: Json; provider_executed: boolean };
    }
  | {
      kind: 'provider_tool_result';
      data: Metadata & { id: string; name: string; output: Json; is_error: boolean };
    }
  | {
      kind: 'source';
      data: Metadata &
        (
          | { kind: 'url'; id: string; url: string; title: string | null }
          | {
              kind: 'document';
              id: string;
              media_type: string;
              title: string;
              filename: string | null;
            }
        );
    }
  | {
      kind: 'response_metadata';
      data: { id: string | null; model: string | null; timestamp: string | null };
    }
  | {
      kind: 'finished';
      data: Metadata & { reason: 'stop' | 'tool-calls' | 'length'; usage: ModelUsage };
    };
export type ModelFrame = { kind: 'text'; data: string } | { kind: 'binary'; data: Uint8Array };
export interface ModelTransport {
  /** A changed routing identity invalidates cached sockets. Not a credential. */
  readonly identity: string;
  request(request: HttpRequest): Promise<HttpResponse>;
  /** Socket identifiers belong to this adapter session, not another session. */
  connect(request: {
    url: string;
    headers?: readonly (readonly [string, string])[];
  }): Promise<string>;
  send(socket: string, frame: ModelFrame): Promise<void>;
  receive(socket: string): Promise<ModelFrame | null>;
  close(socket: string): Promise<void>;
}
export interface ModelContext {
  readonly signal: Cancellation;
  readonly transport: ModelTransport;
  /** Report observed provider progress without emitting a canonical event. */
  progress(): Promise<void>;
  /** Await each emission. Host validates completion and applies backpressure. */
  emit(event: ModelEvent): Promise<void>;
}
export interface ModelConfirmation {
  prompt: readonly ModelMessage[];
  settled_tool_call_ids: readonly string[];
  response_id: string | null;
}
export interface ModelSession {
  stream(request: ModelRequest, context: ModelContext): Awaitable<void>;
  /** Called before the next request, with Host-committed history. */
  confirm?(confirmation: ModelConfirmation): Awaitable<void>;
}
export interface ModelAdapters {
  /** Ordinary scoped contribution. Same-name Session registration shadows profile.
   * Session objects are ephemeral; canonical requests never depend on their cache.
   * HTTP bodies end with a call; sockets close with the session.
   */
  register(
    name: string,
    open: (lifetime: 'request' | 'conversation') => Awaitable<ModelSession>,
  ): Promise<Registration>;
}
/** Throw an Error carrying modelFailure to preserve typed retry evidence.
 * replaySafe must be false if provider-side effects may already have occurred.
 */
export type ModelFailure =
  | 'Cancelled'
  | 'TimedOut'
  | { Adapter: string }
  | { ContextOverflow: { observed_output: boolean } }
  | {
      Provider: {
        reason: 'network' | 'rate_limit' | 'provider_unavailable' | 'stream_truncated';
        message: string;
        replaySafe: boolean;
        retryAfterMs: number | null;
      };
    };
