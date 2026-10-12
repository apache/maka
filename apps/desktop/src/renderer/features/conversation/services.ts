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

import { createElement, useMemo, useState, useEffect, type ReactNode } from 'react';
import { ComposerPromptSuggestionProvider } from '@maka/ui';
import { createServicesContext } from '../../application/contracts/feature-services.js';
import type { ConversationServices } from './ports.js';

const context = createServicesContext<ConversationServices>('ConversationServicesProvider');
export function ConversationServicesProvider(props: { services: ConversationServices; children: ReactNode }) {
  const port = props.services.promptSuggestions;
  const [enabled, setEnabled] = useState(() => port?.readEnabled() ?? false);
  useEffect(() => {
    const refresh = () => setEnabled(port?.readEnabled() ?? false);
    const unsubscribe = port?.subscribeEnabled?.(refresh);
    refresh();
    return unsubscribe;
  }, [port]);
  const service = useMemo(() => port ? {
    enabled,
    setEnabled: (next: boolean) => { port.writeEnabled(next); setEnabled(next); },
    generate: (sessionId: string) => port.generate(sessionId),
  } : undefined, [port, enabled]);
  return createElement(context.Provider, { services: props.services },
    createElement(ComposerPromptSuggestionProvider, { service, children: props.children }));
}
export const useConversationServices = context.useServices;
