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

import { cleanup, signal } from 'nsh';
import type { ServiceMethods } from '../../../../packages/plugin-sdk/src/index.js';
import type { Control } from '../../../../plugins/agent/conversations/ui/Conversation';
import type { Host } from './host';
import { createTransientText, createText, errorText, message } from './text';

type AgentMcpView = ServiceMethods['agent']['projectMcp']['output'];
type AgentMcpTrustResult = ServiceMethods['agent']['trustProjectMcp']['output'];

type Configuration = Extract<AgentMcpView, { kind: 'configuration' }>;
export type ProjectMcp = ReturnType<typeof createProjectMcp>;
export function createProjectMcp(host: Host, sessionId: string, control: Control) {
  const proposal = signal<Configuration | null>(null);
  const pending = signal(false);
  const error = createText();
  const notice = createTransientText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const check = async () => {
    const view = await host.query('agent', 'projectMcp', { sessionId });
    if (!alive) return false;
    error.set('');
    notice.set('');
    const required = view.kind === 'configuration' && !view.trusted;
    proposal.set(required ? view : null);
    return !required;
  };
  const trust = async (revision: string) => {
    if (!alive || pending() || proposal()?.revision !== revision) return;
    pending.set(true);
    error.set('');
    try {
      const result: AgentMcpTrustResult = await control('trustProjectMcp', { sessionId, revision });
      if (!alive) return;
      if (result.kind === 'changed') {
        await check();
        if (alive)
          error.set(message('The MCP configuration changed. Review it again before trusting it.'));
      } else {
        proposal.set(null);
        notice.set(message('Project MCP configuration trusted. Send your draft when ready.'));
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
  return {
    proposal,
    pending,
    error,
    notice,
    check,
    trust,
    dismiss() {
      if (!pending()) proposal.set(null);
    },
  };
}
