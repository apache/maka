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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PermissionMode } from '@maka/core/permission';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { AgentProfile } from './agent-catalog.js';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import type { MakaToolContext } from './tool-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly agents: PluginAgentService;
    readonly agent?: PluginAgent;
  }
}

export interface PluginAgentInvocation {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode?: PermissionMode;
  readonly executionBoundary?: ExecutionBoundary;
  readonly toolCallId?: string;
  readonly abortSignal: AbortSignal;
  readonly toolContext?: MakaToolContext;
}

export interface PluginAgentDescriptor {
  readonly id: string;
  readonly sessionId: string;
  readonly root: boolean;
  readonly status?: string;
  readonly ownerId?: string;
}

export interface PluginAgentCreateOptions {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly agentProfile?: AgentProfile;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  readonly signal?: AbortSignal;
}

export interface PluginAgentResumeOptions {
  readonly sessionId: string;
  readonly prompt?: string;
  readonly signal?: AbortSignal;
}

export interface PluginAgentRuntime {
  create(
    options: PluginAgentCreateOptions,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<PluginAgentDescriptor>;
  resume(
    options: PluginAgentResumeOptions,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<PluginAgentDescriptor>;
  get(
    id: string,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<PluginAgentDescriptor | undefined>;
  list(initiator: PluginAgentInvocation | undefined): Promise<readonly PluginAgentDescriptor[]>;
  roots(initiator: PluginAgentInvocation | undefined): Promise<readonly PluginAgentDescriptor[]>;
  followup(
    id: string,
    message: unknown,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<unknown>;
  steer(
    id: string,
    message: unknown,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<unknown>;
  inject(
    id: string,
    message: unknown,
    initiator: PluginAgentInvocation | undefined,
  ): Promise<unknown>;
  cancel(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  whenIdle(id: string, signal: AbortSignal | undefined): Promise<void>;
  snapshot(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  inbox(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  result(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  artifacts(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  transcript(id: string, initiator: PluginAgentInvocation | undefined): Promise<unknown>;
  dispose(id: string, initiator: PluginAgentInvocation | undefined): Promise<void>;
}

export interface PluginAgent {
  readonly id: string;
  readonly sessionId: string;
  readonly root: boolean;
  readonly status?: string;
  readonly ownerId?: string;
  followup(message: unknown): Promise<unknown>;
  steer(message: unknown): Promise<unknown>;
  inject(message: unknown): Promise<unknown>;
  cancel(): Promise<unknown>;
  whenIdle(signal?: AbortSignal): Promise<void>;
  snapshot(): Promise<unknown>;
  inbox(): Promise<unknown>;
  result(): Promise<unknown>;
  artifacts(): Promise<unknown>;
  transcript(): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Agent registry and invocation carrier exposed to trusted Host plugins. */
export class PluginAgentService extends Service {
  private readonly invocations = new AsyncLocalStorage<PluginAgentInvocation>();
  private agentRuntime: PluginAgentRuntime | undefined;

  constructor(ctx: Context) {
    super(ctx, 'agents');
    ctx.accessor('agent', {
      get: () => this.current(),
    });
  }

  bindRuntime(runtime: PluginAgentRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Agent Runtime');
    if (this.agentRuntime) throw new Error('Plugin Agent Runtime is already bound');
    this.agentRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.agentRuntime === runtime) this.agentRuntime = undefined;
      },
      'agents.bindRuntime()',
    );
  }

  currentInvocation(): PluginAgentInvocation | undefined {
    return this.invocations.getStore();
  }

  requireInvocation(): PluginAgentInvocation {
    const invocation = this.currentInvocation();
    if (!invocation) throw new Error('This capability requires an active Agent invocation');
    return invocation;
  }

  withInvocation<T>(toolContext: MakaToolContext, operation: () => T): T {
    const invocation: PluginAgentInvocation = Object.freeze({
      sessionId: toolContext.sessionId,
      ...(toolContext.runId ? { runId: toolContext.runId } : {}),
      turnId: toolContext.turnId,
      cwd: toolContext.cwd,
      ...(toolContext.permissionMode ? { permissionMode: toolContext.permissionMode } : {}),
      ...(toolContext.executionBoundary
        ? { executionBoundary: toolContext.executionBoundary }
        : {}),
      toolCallId: toolContext.toolCallId,
      abortSignal: toolContext.abortSignal,
      toolContext,
    });
    return this.invocations.run(invocation, operation);
  }

  current(): PluginAgent | undefined {
    const invocation = this.currentInvocation();
    if (!invocation) return undefined;
    return this.handle({
      id: invocation.sessionId,
      sessionId: invocation.sessionId,
      root: true,
      status: 'running',
    });
  }

  async create(options: PluginAgentCreateOptions = {}): Promise<PluginAgent> {
    return this.handle(await this.runtime().create(options, this.currentInvocation()));
  }

  async resume(options: PluginAgentResumeOptions): Promise<PluginAgent> {
    return this.handle(await this.runtime().resume(options, this.currentInvocation()));
  }

  async get(id: string): Promise<PluginAgent | undefined> {
    const descriptor = await this.runtime().get(assertId(id), this.currentInvocation());
    return descriptor ? this.handle(descriptor) : undefined;
  }

  async list(): Promise<readonly PluginAgent[]> {
    return Object.freeze(
      (await this.runtime().list(this.currentInvocation())).map((descriptor) =>
        this.handle(descriptor),
      ),
    );
  }

  async roots(): Promise<readonly PluginAgent[]> {
    return Object.freeze(
      (await this.runtime().roots(this.currentInvocation())).map((descriptor) =>
        this.handle(descriptor),
      ),
    );
  }

  private runtime(): PluginAgentRuntime {
    if (!this.agentRuntime) throw new Error('Plugin Agent Runtime is unavailable');
    return this.agentRuntime;
  }

  private handle(descriptor: PluginAgentDescriptor): PluginAgent {
    const service = this;
    const id = assertId(descriptor.id);
    const invoke = () => service.currentInvocation();
    return Object.freeze({
      ...descriptor,
      id,
      followup: (message: unknown) => service.runtime().followup(id, message, invoke()),
      steer: (message: unknown) => service.runtime().steer(id, message, invoke()),
      inject: (message: unknown) => service.runtime().inject(id, message, invoke()),
      cancel: () => service.runtime().cancel(id, invoke()),
      whenIdle: (signal?: AbortSignal) =>
        service.runtime().whenIdle(id, signal ?? invoke()?.abortSignal),
      snapshot: () => service.runtime().snapshot(id, invoke()),
      inbox: () => service.runtime().inbox(id, invoke()),
      result: () => service.runtime().result(id, invoke()),
      artifacts: () => service.runtime().artifacts(id, invoke()),
      transcript: () => service.runtime().transcript(id, invoke()),
      dispose: () => service.runtime().dispose(id, invoke()),
    });
  }
}

function assertId(id: string): string {
  if (!id || /[\0\r\n]/u.test(id)) throw new TypeError('Agent id is invalid');
  return id;
}
