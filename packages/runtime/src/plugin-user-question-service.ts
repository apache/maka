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

import type { InteractionFormInput, InteractionFormResult } from '@maka/core/interaction';
import type { UserQuestion, UserQuestionResult } from '@maka/core/user-question';
import { Service, type Context } from './plugin-kernel.js';
import type { PluginAgentService } from './plugin-agent-service.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly userQuestions: PluginUserQuestionService;
  }
}

/** Structured human-input surface bound to the current Agent invocation. */
export class PluginUserQuestionService extends Service {
  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'userQuestions');
  }

  ask(questions: readonly UserQuestion[]): Promise<UserQuestionResult> {
    const ask = this.agents.requireInvocation().toolContext?.askUserQuestion;
    if (!ask) throw new Error('User questions are unavailable on this Agent surface');
    return ask([...questions]);
  }

  requestForm(
    form: InteractionFormInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<InteractionFormResult> {
    const invocation = this.agents.requireInvocation();
    const request = invocation.toolContext?.requestUserForm;
    if (!request) throw new Error('Structured user forms are unavailable on this Agent surface');
    return request(form, { cancellationSignal: options.signal ?? invocation.abortSignal });
  }
}
