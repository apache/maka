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

import type { AttachmentRef } from '@maka/core/events';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import type { PluginAgentInvocation, PluginAgentService } from './plugin-agent-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly attachments: PluginAttachmentService;
  }
}

export interface PluginAttachmentCreateInput {
  readonly name: string;
  readonly mimeType: string;
  readonly content: string | Uint8Array;
  readonly summary?: string;
}

export interface PluginAttachmentRuntime {
  create(
    input: PluginAttachmentCreateInput,
    invocation: PluginAgentInvocation,
  ): Promise<AttachmentRef>;
  read(ref: AttachmentRef, invocation: PluginAgentInvocation): Promise<Uint8Array>;
  list(invocation: PluginAgentInvocation): Promise<readonly AttachmentRef[]>;
}

/** Session-owned rich result publication and retrieval. */
export class PluginAttachmentService extends Service {
  private attachmentRuntime?: PluginAttachmentRuntime;

  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'attachments');
  }

  bindRuntime(runtime: PluginAttachmentRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Attachment Runtime');
    if (this.attachmentRuntime) throw new Error('Plugin Attachment Runtime is already bound');
    this.attachmentRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.attachmentRuntime === runtime) this.attachmentRuntime = undefined;
      },
      'attachments.bindRuntime()',
    );
  }

  create(input: PluginAttachmentCreateInput) {
    return this.runtime().create(input, this.agents.requireInvocation());
  }

  read(ref: AttachmentRef) {
    return this.runtime().read(ref, this.agents.requireInvocation());
  }

  list() {
    return this.runtime().list(this.agents.requireInvocation());
  }

  private runtime(): PluginAttachmentRuntime {
    if (!this.attachmentRuntime) throw new Error('Plugin Attachment Runtime is unavailable');
    return this.attachmentRuntime;
  }
}
