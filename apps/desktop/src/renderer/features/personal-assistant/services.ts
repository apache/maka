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

import { createContext, useContext } from 'react';
import type { PersonalAssistantRequest } from '@maka/runtime-host/protocol';
import { createAssistantNavigation, type AssistantHost } from './navigation.js';
export type { AssistantHost } from './navigation.js';
export interface PersonalAssistantPort {
  call(method: PersonalAssistantRequest['method'], input?: unknown, host?: AssistantHost): Promise<any>;
  defaultHost(): Promise<AssistantHost>;
  hostSnapshot(): Promise<{ entries: ReadonlyArray<{ profile: { id: string }; hostId?: string; enabled: boolean }> }>;
  createSession(): Promise<{ id: string }>;
  listSessions(): Promise<Array<{ id: string }>>;
}
export function createPersonalAssistantServices(port: PersonalAssistantPort) {
  const navigation = createAssistantNavigation({
    host: port.defaultHost,
    binding: (host) => port.call('assistant.binding', {}, host),
    bind: (host, sessionId) => port.call('assistant.bind', { sessionId }, host),
    create: port.createSession,
    list: port.listSessions,
  });
  return { ...port, open: navigation.open };
}
const Context = createContext<ReturnType<typeof createPersonalAssistantServices> | null>(null);
export const PersonalAssistantServicesProvider = Context.Provider;
export function usePersonalAssistantServices() {
  const services = useContext(Context);
  if (!services) throw Error('PersonalAssistantServicesProvider is missing');
  return services;
}
