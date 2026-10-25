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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type Client = Pick<DesktopRuntimeHostClient, 'hostId' | 'request' | 'submitMessage'>;

/** Reuse the same durable Inbox admission as the main assistant conversation. */
export function createPetAssistantChat(resolveClient: () => Client | undefined) {
  const client = () => {
    const current = resolveClient();
    if (!current) throw Error('助手连接暂不可用');
    return current;
  };
  const target = async (current: Client) => {
    const enabled = (await current.request('personal-assistant.call', { method: 'assistant.enablement', input: {} })).value as { enabled: boolean };
    if (!enabled.enabled) throw Error('请先在 Maka 设置中开启个人助手');
    const binding = (await current.request('personal-assistant.call', { method: 'assistant.binding', input: {} })).value as { state?: { sessionId?: string } };
    if (!binding.state?.sessionId) throw Error('请先在 Maka 中打开一次个人助手');
    return JSON.stringify([current.hostId, binding.state.sessionId]);
  };
  return {
    async target() { return target(client()); },
    async cardAction(input: { target: string; cardId: string; actionKey?: string }) {
      const current = client();
      if (await target(current) !== input.target || resolveClient() !== current)
        throw Error('助手或 Host 已变化，请重新打开消息');
      const [, sessionId] = JSON.parse(input.target);
      const result = await current.request('personal-assistant.call', {
        method: input.actionKey === undefined ? 'assistant.card-status' : 'assistant.card-reply',
        input: { sessionId, cardId: input.cardId, ...(input.actionKey === undefined ? {} : { actionKey: input.actionKey }) },
      });
      return result.value as { selectedKey: string | null };
    },
    async send(input: { target: string; id: string; text: string }) {
      const current = client();
      if (await target(current) !== input.target || resolveClient() !== current)
        throw Error('助手或 Host 已变化，请重新打开输入框');
      const [, sessionId] = JSON.parse(input.target);
      const result = await current.submitMessage({ sessionId, messageId: input.id, placement: 'current_turn', content: { text: input.text } });
      if (result.disposition === 'blocked') throw Error('消息未送达，请检查助手状态');
    },
  };
}
