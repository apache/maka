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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ComposerPromptSuggestionService {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  generate(sessionId: string): Promise<string | undefined>;
}
const Context = createContext<ComposerPromptSuggestionService | undefined>(undefined);
export function ComposerPromptSuggestionProvider(props: { service?: ComposerPromptSuggestionService; children: ReactNode }) {
  return <Context.Provider value={props.service}>{props.children}</Context.Provider>;
}

/** Only turns witnessed on this surface trigger prediction; never replay history on mount. */
export function usePromptSuggestion(input: {
  sessionId?: string; streaming: boolean; blocked: boolean; text: string;
}) {
  const service = useContext(Context);
  const [offer, setOffer] = useState<{ sessionId: string; text: string }>();
  const previous = useRef({ sessionId: input.sessionId, streaming: input.streaming });
  const epoch = useRef(0);
  const live = useRef(input);
  live.current = input;
  const dismiss = () => { epoch.current += 1; setOffer(undefined); };
  useEffect(() => {
    const before = previous.current;
    previous.current = { sessionId: input.sessionId, streaming: input.streaming };
    const generation = ++epoch.current;
    setOffer(undefined);
    if (!service?.enabled || !input.sessionId || input.blocked || input.text.length
      || input.streaming || !before.streaming || before.sessionId !== input.sessionId) return;
    const sessionId = input.sessionId;
    void service.generate(sessionId).then((text) => {
      if (!text || generation !== epoch.current || live.current.sessionId !== sessionId
        || live.current.streaming || live.current.blocked || live.current.text.length) return;
      setOffer({ sessionId, text });
    }).catch(() => undefined);
    return () => { epoch.current += 1; };
  }, [service, input.sessionId, input.streaming, input.blocked, input.text]);
  return {
    service,
    text: service?.enabled && !input.streaming && !input.blocked && !input.text.length
      && offer?.sessionId === input.sessionId ? offer?.text : undefined,
    dismiss,
  };
}
