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

export interface AssistantHost {
  hostId: string;
  profileId: string;
}
export interface AssistantNavigationPorts {
  host(): Promise<AssistantHost>;
  binding(host: AssistantHost): Promise<{ state: null | { sessionId: string } }>;
  bind(host: AssistantHost, id: string): Promise<{ sessionId: string }>;
  create(): Promise<{ id: string }>;
  list(): Promise<{ id: string }[]>;
}
export const identity = (id: string): [string | null, string] => {
  try {
    const value = JSON.parse(id);
    if (Array.isArray(value) && value.length === 2) return value as [string, string];
  } catch {}
  return [null, id];
};
// Scope in-flight opening and candidates by Host, so switching Hosts cannot bind its neighbour's chat.
export function createAssistantNavigation(ports: AssistantNavigationPorts) {
  const openings = new Map<string, Promise<string>>();
  const candidates = new Map<string, string>();
  async function openAssistant(): Promise<string> {
    const host = await ports.host();
    if (!host) throw Error('请先连接 Host。');
    const key = `${host.hostId}:${host.profileId}`;
    const existing = openings.get(key);
    if (existing) return existing;
    const operation = (async () => {
      let { state } = await ports.binding(host);
      if (!state) {
        let candidate = candidates.get(key);
        if (!candidate) {
          const session = await ports.create();
          candidate = session.id;
          if (identity(candidate)[0] && identity(candidate)[0] !== host.hostId)
            throw Error('会话所在 Host 已变化，请重新打开个人助手。');
          candidates.set(key, candidate);
        }
        if ((await ports.host())?.hostId !== host.hostId)
          throw Error('Host 已切换，请重新打开个人助手。');
        if (identity(candidate)[0] && identity(candidate)[0] !== host.hostId)
          throw Error('会话所在 Host 已变化，请重新打开个人助手。');
        state = await ports.bind(host, identity(candidate)[1]);
      }
      const matches = (await ports.list()).filter((s) => {
        const [owner, id] = identity(s.id);
        return id === state.sessionId && (!owner || owner === host.hostId);
      });
      if (matches.length !== 1)
        throw Error('找不到此 Host 的助手会话，请确认 Host 在线且会话未删除。');
      return matches[0]!.id;
    })().finally(() => openings.delete(key));
    openings.set(key, operation);
    return operation;
  }

  return { open: openAssistant };
}


/** References belong to the displayed chat's Host; a default Host is never a fallback. */
export function originalHost(sessionId: string, entries: readonly {
  hostId?: string; enabled: boolean; profile: { id: string };
}[]): { host: AssistantHost; sessionId: string } {
  const [hostId, id] = identity(sessionId);
  if (typeof hostId !== 'string' || !hostId || typeof id !== 'string' || !id)
    throw Error('无法确定引用所属的 Host，请重新打开此会话。');
  const owner = entries.find(entry => entry.hostId === hostId && entry.enabled);
  if (!owner) throw Error('引用所属 Host 未连接。');
  return { host: { hostId, profileId: owner.profile.id }, sessionId: id };
}
