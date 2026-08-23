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

/** Either a React synthetic event or the native one it wraps. */
export interface ChatInputCompositionEvent {
  key?: string;
  nativeEvent?: object;
}

export function isChatInputComposing(
  event: ChatInputCompositionEvent,
  trackedComposition = false,
): boolean {
  const native: object = event.nativeEvent ?? event;
  return trackedComposition || event.key === 'Process'
    || ('isComposing' in native && native.isComposing === true);
}

/**
 * The draft text as the backend should receive it.
 *
 * `ChatComposerInput` anchors an inline token to what follows it with a
 * NO-BREAK SPACE, and its own backspace-eats-the-token check keys on that exact
 * codepoint — so the editor has to keep it and only the wire is normalized.
 * Without this, every message written after a mention carries a U+00A0 where
 * the user typed an ordinary space: invisible in the transcript, and a
 * character no tool splitting a path on ASCII whitespace will match.
 */
export function composerWireText(draft: string): string {
  return draft.replace(/ /g, ' ').trim();
}

/**
 * Wraps an async lookup into the shape Astryx's trigger menu expects, adding
 * the two things `useTriggerMenu` assumes a `SearchSource` provides.
 *
 * `searchItems` probes the source with `search('')` once per keystroke purely
 * to learn whether it is async — it reads nothing but `instanceof Promise` and
 * discards the value — and it calls `cancel()` immediately before, and only
 * before, each real search. So the probe is answered from a resolved constant
 * and never reaches the network, every real search runs fresh, and a search
 * superseded by a newer one is abandoned rather than allowed to race its stale
 * results into an open menu.
 */
export function createTriggerSearchSource<Item>(
  run: (query: string) => Promise<Item[]>,
): { bootstrap(): Promise<Item[]>; search(query: string): Promise<Item[]>; cancel(): void } {
  const probeAnswer = Promise.resolve<Item[]>([]);
  /** Never settles, so a superseded search can never write to the menu. */
  const abandoned = (): Promise<Item[]> => new Promise<Item[]>(() => {});
  let generation = 0;
  let armed = false;
  return {
    bootstrap: () => run('').catch(() => []),
    search(query) {
      if (!armed) return probeAnswer;
      armed = false;
      const ownGeneration = generation;
      const fresh = (items: Item[]) => (ownGeneration === generation ? items : abandoned());
      return run(query).then(fresh, () => fresh([]));
    },
    cancel() {
      generation += 1;
      armed = true;
    },
  };
}

export function fileTransferContainsFiles(types: Iterable<string>, fileCount: number): boolean {
  return fileCount > 0 || Array.from(types).includes('Files');
}

/**
 * The composer's text surface, seen by the hooks that own draft persistence and
 * prompt-history recall.
 *
 * Those hooks used to hold an `HTMLTextAreaElement` ref and poke `.value` /
 * `.setSelectionRange()` directly. The input is now Astryx's contentEditable
 * `ChatComposerInput`, whose value is React state and whose caret is owned by
 * the component — so they talk to this two-method port instead and stay free
 * of any DOM shape.
 */
export interface ComposerTextPort {
  /** The serialized draft text, tokens included. */
  getValue(): string;
  /** Replace the draft text without moving focus. */
  setValue(value: string): void;
}

/**
 * Case-insensitive AND-of-substring matcher shared by the file re-filter and
 * the skill filter: every whitespace-separated token in `query` must appear
 * somewhere in `text`. An empty query matches everything (shows the full list).
 */
export function mentionQueryMatches(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}

/** Normalize `/skill:<query>` and bare `/<query>` into the same Skill search query. */
export function skillMentionQuery(query: string): string {
  return query.toLowerCase().startsWith('skill:') ? query.slice('skill:'.length) : query;
}

/** Return the searchable command query only when `/` starts the draft's first token. */
export function slashCommandQuery(
  textBeforeCaret: string,
  textAfterCaret: string,
  rawQuery: string,
): string | null {
  if (rawQuery.toLowerCase().startsWith('skill:')) return null;
  if (/^\S/.test(textAfterCaret)) return null;
  const triggerIndex = textBeforeCaret.length - rawQuery.length - 1;
  if (triggerIndex < 0 || textBeforeCaret[triggerIndex] !== '/') return null;
  return textBeforeCaret.slice(0, triggerIndex).trim() === '' ? rawQuery : null;
}

export interface ChatInputActionOwner<ActionId> {
  readonly pending: ActionId | null;
  run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined>;
  reset(): void;
}

export function createChatInputActionOwner<ActionId>(
  onPendingChange: (action: ActionId | null) => void,
): ChatInputActionOwner<ActionId> {
  let pending: ActionId | null = null;
  let generation = 0;
  return {
    get pending() {
      return pending;
    },
    async run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined> {
      if (pending !== null) return undefined;
      const ownedGeneration = ++generation;
      pending = actionId;
      onPendingChange(actionId);
      try {
        return await action();
      } finally {
        if (generation === ownedGeneration && pending === actionId) {
          pending = null;
          onPendingChange(null);
        }
      }
    },
    reset() {
      generation += 1;
      pending = null;
    },
  };
}
