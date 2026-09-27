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
  /** With `prefix`, a short continuation of that draft; without, the next message. */
  generate(sessionId: string, prefix?: string): Promise<string | undefined>;
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

/** Quiet time after the last edit before a continuation is requested. */
export const PROMPT_CONTINUATION_DEBOUNCE_MS = 350;
/** Shorter drafts carry too little intent to continue. */
export const PROMPT_CONTINUATION_MIN_CHARS = 4;

/**
 * Whether a draft's text can take a continuation. The caller separately checks
 * what only the editor knows (caret, inline tokens, open menus, composition).
 */
export function continuationDraftEligible(text: string): boolean {
  return (
    Array.from(text).length >= PROMPT_CONTINUATION_MIN_CHARS &&
    !/\s$/u.test(text) &&
    !text.startsWith('/')
  );
}

/**
 * Inline continuation of a partly typed draft (#5703). State changes only on a
 * new draft or a settled request, never from layout, so no render can feed back
 * into another. A result is shown only while the draft still equals the prefix
 * it was requested for; Esc dismisses it until the draft changes again.
 */
export function usePromptContinuation(input: {
  sessionId?: string;
  streaming: boolean;
  blocked: boolean;
  text: string;
  /** Read once when the pause elapses: caret at end, no tokens, no open menu. */
  canContinue(): boolean;
}) {
  const service = useContext(Context);
  const [offer, setOffer] = useState<{ sessionId: string; prefix: string; text: string }>();
  const epoch = useRef(0);
  const live = useRef(input);
  live.current = input;
  const dismiss = () => {
    epoch.current += 1;
    setOffer(undefined);
  };
  useEffect(() => {
    const generation = ++epoch.current;
    if (
      !service?.enabled ||
      !input.sessionId ||
      input.blocked ||
      input.streaming ||
      !continuationDraftEligible(input.text)
    )
      return;
    const sessionId = input.sessionId;
    const prefix = input.text;
    const timer = setTimeout(() => {
      if (generation !== epoch.current || !live.current.canContinue()) return;
      void service
        .generate(sessionId, prefix)
        .then((text) => {
          const now = live.current;
          if (
            !text ||
            generation !== epoch.current ||
            now.sessionId !== sessionId ||
            now.text !== prefix ||
            now.streaming ||
            now.blocked
          )
            return;
          setOffer({ sessionId, prefix, text });
        })
        .catch(() => undefined);
    }, PROMPT_CONTINUATION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      epoch.current += 1;
    };
  }, [service, input.sessionId, input.streaming, input.blocked, input.text]);
  return {
    text:
      service?.enabled &&
      !input.streaming &&
      !input.blocked &&
      offer !== undefined &&
      offer.sessionId === input.sessionId &&
      offer.prefix === input.text
        ? offer.text
        : undefined,
    prefix: offer?.prefix,
    dismiss,
  };
}
