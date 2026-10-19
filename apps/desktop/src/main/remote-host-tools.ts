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

import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import type { RemoteToolsRequest } from '@maka/runtime-host/protocol';
import type { RuntimeHostDesktopManager } from './runtime-host-desktop-manager.js';

type ScopedRequest<T = RemoteToolsRequest> = T extends { contextId: string; origin: unknown }
  ? Omit<T, 'origin'>
  : never;

const id = z.string().min(1).max(256);
/** Desktop-owned transport only. Execution, receipts and mailboxes live on Hosts. */
export class RemoteHostToolsBridge {
  private polling = false;
  private readonly feedbackErrors = new Map<string, string>();
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly manager: () => RuntimeHostDesktopManager | undefined,
    private readonly requestTimeoutMs = 15_000,
  ) {
    this.timer = setInterval(() => {
      void this.poll();
    }, 5000);
    this.timer.unref();
  }
  private targets() {
    return this.manager()?.entries() ?? [];
  }
  private target(hostId: string) {
    const candidates = this.targets().filter((t) => t.hostId === hostId && t.readiness === 'ready');
    if (candidates.length !== 1 || !('candidate' in candidates[0]!))
      throw Error('Target Host is offline or ambiguous');
    return candidates[0]!.candidate.client;
  }
  private async request(hostId: string, input: RemoteToolsRequest) {
    try {
      return (await this.target(hostId).request('remote.tools', input, this.requestTimeoutMs)).value;
    } catch (error) {
      if (input.action === 'call')
        throw new Error(`Remote response unavailable for callId=${input.callId}, contextId=${input.contextId}, hostId=${hostId}. Execution may still be running. Use RemoteToolResult or retry the SAME callId and arguments; do not create a new call to repeat the effect. ${String(error)}`, { cause: error });
      throw error;
    }
  }
  tools(scope?: { hostId: string; targetEpoch: string }): readonly MakaTool[] {
    const invoke = async (hostId: string, input: RemoteToolsRequest) => {
      if (this.stopped || !scope || !this.manager()?.ownsScope(scope))
        throw Error('Origin Host connection is no longer active');
      if (hostId === scope.hostId) throw Error('Use local tools for the current Host');
      return { hostId, value: await this.request(hostId, input) };
    };
    const scopedInvoke = async (hostId: string, request: ScopedRequest, sessionId: string) => {
      if (!scope || !this.manager()?.ownsScope(scope))
        throw Error('Origin connection is unavailable');
      const origin = (await this.request(scope.hostId, { action: 'origin', sessionId })) as {
        sessionId: string;
      };
      return invoke(hostId, {
        ...request,
        origin: { hostId: scope.hostId, sessionId: origin.sessionId },
      } as RemoteToolsRequest);
    };
    const tool = (
      name: string,
      description: string,
      parameters: MakaTool['parameters'],
      impl: MakaTool['impl'],
    ): MakaTool => ({
      name,
      description,
      parameters,
      impl,
      categoryHint: 'custom_tool',
      recoveryMode: 'never_auto_retry',
      executionSemantics: 'exclusive_step',
      ...(name === 'HostList' ? { discovery: 'direct' as const } : {}),
    });
    return [
      tool(
        'HostList',
        'List connected Maka Hosts. Optional hostId lists that Host’s existing Sessions to choose a workspace/permission template for RemoteHostOpen. Offline is not empty. No model is started.',
        z.object({ hostId: id.optional() }).strict(),
        async (input) => {
          if (!scope || !this.manager()?.ownsScope(scope))
            throw Error('Origin connection is unavailable');
          if (input.hostId) return invoke(input.hostId, { action: 'contexts' });
          return this.targets()
            .filter((t) => t.hostId !== scope.hostId)
            .map((t) => ({
              hostId: t.hostId,
              name: t.target.profile.name,
              status: t.readiness,
              feedbackError: [...this.feedbackErrors].filter(([pair]) => pair.startsWith(`${t.hostId}:`)).map(([, error]) => error).join("; ") || null,
            }));
        },
      ),
      tool(
        'RemoteHostOpen',
        'Open or recover a dedicated tool execution context on a target Host, using an existing Session as the workspace, model and permission template. Does not start a model or modify the template. Keep the returned context id for subsequent calls.',
        z.object({ hostId: id, templateSession: id }).strict(),
        async (input, ctx) => {
          if (!scope || !this.manager()?.ownsScope(scope))
            throw Error('Origin connection is unavailable');
          const origin = (await this.request(scope.hostId, {
            action: 'origin',
            sessionId: ctx.sessionId,
          })) as { sessionId: string };
          return invoke(input.hostId, {
            action: 'open',
            originHost: scope.hostId,
            originSession: origin.sessionId,
            templateSession: input.templateSession,
          });
        },
      ),
      tool(
        'RemoteToolSearch',
        'Discover exported tools and their exact argument schemas on a target Host. Remote references, cursors and task ids must be used on the same Host/context.',
        z.object({ hostId: id, contextId: id, query: z.string().max(300).default('') }).strict(),
        (input, ctx) =>
          scopedInvoke(
            input.hostId,
            {
              action: 'search',
              contextId: input.contextId,
              query: input.query,
            },
            ctx.sessionId,
          ),
      ),
      tool(
        'RemoteToolCall',
        'Execute one discovered tool on the target Host without another model call. Supply a stable callId; retries with the same content reuse its receipt. running means accepted, not complete: use RemoteToolResult. completed means settled: inspect the result for tool errors. outcome_unknown must be investigated, never replayed with a fresh id. MatterDelegate starts a remote continuous task; its updates return to the initiating assistant. Do not call local Matter tools with remote task IDs.',
        z
          .object({ hostId: id, contextId: id, callId: id, tool: id, arguments: z.unknown() })
          .strict(),
        (input, ctx) =>
          scopedInvoke(
            input.hostId,
            {
              action: 'call',
              contextId: input.contextId,
              callId: input.callId,
              tool: input.tool,
              arguments: input.arguments,
            },
            ctx.sessionId,
          ),
      ),
      tool(
        'RemoteToolCancel',
        'Request cancellation of a running remote tool call on user request. Cancellation is not rollback; inspect its final receipt. Use remote MatterTaskControl to cancel a delegated task.',
        z.object({ hostId: id, contextId: id, callId: id }).strict(),
        (input, ctx) =>
          scopedInvoke(
            input.hostId,
            {
              action: 'cancel',
              contextId: input.contextId,
              callId: input.callId,
            },
            ctx.sessionId,
          ),
      ),
      tool(
        'RemoteToolResult',
        'Read the durable receipt of a previously submitted remote call. Does not re-execute it. Task creation success is not task completion; query MatterTasks on the same Host/context.',
        z.object({ hostId: id, contextId: id, callId: id }).strict(),
        (input, ctx) =>
          scopedInvoke(
            input.hostId,
            {
              action: 'result',
              contextId: input.contextId,
              callId: input.callId,
            },
            ctx.sessionId,
          ),
      ),
    ];
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const ready = this.targets().filter((t) => t.readiness === 'ready');
      // Independent Host pairs must not wait for an unresponsive peer.
      await Promise.all(ready.flatMap((target) => ready
        .filter((origin) => origin.hostId !== target.hostId)
        .map(async (origin) => {
          const pair = `${target.hostId}:${origin.hostId}`;
          try {
            const events = (await this.request(target.hostId, {
              action: 'events', originHost: origin.hostId,
            })) as { id: string; sessionId: string; content: unknown }[];
            this.feedbackErrors.delete(pair);
            for (const event of events) {
              if (this.stopped) break;
              try {
                const receipt = (await this.request(origin.hostId, {
                  action: 'deliver', sessionId: event.sessionId,
                  id: `remote:${target.hostId}:${event.id}`, source: target.hostId,
                  content: { hostId: target.hostId, ...(event.content as object) },
                })) as { accepted: boolean; manualOnly?: boolean };
                if (receipt.accepted || receipt.manualOnly)
                  await this.request(target.hostId, { action: 'ack', ids: [event.id] });
              } catch (error) {
                // One rejected event must not prevent delivery of subsequent events.
                this.feedbackErrors.set(pair, String(error));
              }
            }
          } catch (error) {
            this.feedbackErrors.set(pair, String(error));
          }
        })));

    } finally {
      this.polling = false;
    }
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
