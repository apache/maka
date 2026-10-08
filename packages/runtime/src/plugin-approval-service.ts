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

import type {
  SandboxBoundaryExpansion,
  SandboxBoundarySettlement,
} from '@maka/core/sandbox-boundary';
import { Service, type Context } from './plugin-kernel.js';
import type { PluginAgentService } from './plugin-agent-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly approval: PluginApprovalService;
  }
}

export interface PluginApprovalRequest {
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
}

/** Permission request surface backed by Maka's durable Sandbox Boundary authority. */
export class PluginApprovalService extends Service {
  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'approval');
  }

  request(request: PluginApprovalRequest): Promise<SandboxBoundarySettlement> {
    const ask = this.agents.requireInvocation().toolContext?.requestSandboxBoundary;
    if (!ask) throw new Error('Approval is unavailable on this Agent surface');
    return ask(request.expansion, request.justification);
  }
}
