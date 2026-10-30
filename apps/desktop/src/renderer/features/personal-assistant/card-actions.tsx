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

import { useMemo, type ReactNode } from 'react';
import { MessageCardActionsContext, type MessageCardActions } from '@maka/ui';
import { usePersonalAssistantServices } from './services.js';
import { originalHost } from './navigation.js';

export function PersonalAssistantCardActions({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const services = usePersonalAssistantServices();
  const actions = useMemo<MessageCardActions>(() => {
    const call = async (cardId: string, actionKey?: string) => {
      const target = originalHost(sessionId, (await services.hostSnapshot()).entries);
      return services.call(actionKey === undefined ? 'assistant.card-status' : 'assistant.card-reply', {
        sessionId: target.sessionId, cardId, ...(actionKey === undefined ? {} : { actionKey }),
      }, target.host);
    };
    return { read: id => call(id), choose: (id, key) => call(id, key) };
  }, [sessionId, services]);
  return <MessageCardActionsContext.Provider value={actions}>{children}</MessageCardActionsContext.Provider>;
}
