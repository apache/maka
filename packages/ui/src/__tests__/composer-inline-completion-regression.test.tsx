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

/**
 * Regression coverage for the renderer crash reported in apache/maka#4117.
 *
 * The 0.1.11 composer fed a prompt-history completion candidate to the Astryx
 * `ChatComposerInput` inline-completion engine:
 *
 *     inlineCompletion={matchCompletion(text) ?? undefined}
 *
 * That vendor engine (0.4.0) re-decided the offer after every render through a
 * dependency-less `useEffect(reconcileOffer)`, and both of its exits wrote the
 * same piece of React state — `withdrawOffer()` unconditionally called
 * `setInlineCompletionAnnouncement('')` while a standing offer called it with
 * the offer text. Whether the loop terminated depended on a
 * `getBoundingClientRect` comparison (`offerFullyVisible`) agreeing between
 * the pass that inserted the offer span and the pass that re-measured it after
 * the announcement commit. When real layout disagreed — a draft at the
 * max-rows scroll cap, the offer's tail wrapping the field's bottom edge
 * inside the tolerance, zoom or font rounding — the two writes flip-flopped,
 * each flip scheduled another commit-phase update in the same nested chain,
 * and React threw error #185 ("Maximum update depth exceeded") at the
 * fiftieth. The renderer crash dialog in the report is that throw; the
 * minified stack resolves to `withdrawOffer`'s announcement dispatch called
 * from `reconcileOffer` inside `ChatComposerInput`, mounted by the composer
 * form.
 *
 * The unstable seam is closed on two sides — the completion wiring was removed
 * from the composer, and Astryx 0.5.0 no longer ships the engine — so these
 * tests pin the seam shut instead of re-testing vendor internals:
 *
 *   1. driving the composer through the reported scenario (prompt history
 *      seeded, draft a strict prefix of the newest entry) must settle with no
 *      offer span in the editable and no update-depth crash;
 *   2. the history hook must not expose a completion source again;
 *   3. the composer must not pass `inlineCompletion` to `ChatComposerInput`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { useComposerHistory } from '../use-composer-history.js';
import type { ComposerTextPort } from '../chat-input-behavior.js';

const HISTORY_STORAGE_KEY = 'maka-input-history';
/** The prompt a retyping user is closing in on; its strict prefixes are drafts. */
const NEWEST_PROMPT = 'summarize the weekly report and mail it to the team';

interface StorageShim {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

/**
 * The globals the composer and its vendor input read at render and event
 * time. The DOM lib types some of these as always present, so the swap goes
 * through a loose record — values are restored in the same shape they were
 * found, and only the keys this fixture actually touches.
 */
interface DomGlobals {
  document?: unknown;
  window?: unknown;
  Node?: unknown;
  HTMLElement?: unknown;
  Element?: unknown;
  HTMLBRElement?: unknown;
  localStorage?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}

const TOUCHED_GLOBALS = [
  'document',
  'window',
  'Node',
  'HTMLElement',
  'Element',
  'HTMLBRElement',
  'localStorage',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

function domGlobals(): DomGlobals {
  return globalThis as unknown as DomGlobals;
}

function snapshotDomGlobals(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of TOUCHED_GLOBALS) {
    snapshot[key] = domGlobals()[key];
  }
  return snapshot;
}

function restoreDomGlobals(snapshot: Record<string, unknown>): void {
  for (const key of TOUCHED_GLOBALS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete domGlobals()[key];
    } else {
      (domGlobals() as Record<string, unknown>)[key] = value;
    }
  }
}

/**
 * Let React's scheduler and any component timers finish while the isolated
 * globals are still installed, so nothing queued by the scenario fires after
 * the real globals have been put back.
 */
async function drainScheduledWork(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface InstalledDom {
  document: Document;
  window: { Event: typeof Event };
  container: Element;
}

/**
 * A linkedom document plus the globals the composer reads at render time:
 * `localStorage` is an in-memory shim seeded with prompt history (the real
 * one persists sent prompts, and this scenario needs a non-empty history),
 * and the DOM constructors the vendor's serializer touches (`Node`,
 * `HTMLElement`, …) come from the linkedom window.
 */
async function withIsolatedDom(
  historyEntries: string[],
  scenario: (dom: InstalledDom) => Promise<void> | void,
): Promise<void> {
  const original = snapshotDomGlobals();
  const backing = new Map<string, string>([
    [HISTORY_STORAGE_KEY, JSON.stringify(historyEntries)],
  ]);
  const storage: StorageShim = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
    removeItem: (key) => void backing.delete(key),
    clear: () => backing.clear(),
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  const container = document.querySelector('#root');
  assert.ok(container, 'the fixture mounts into its own document');
  Object.assign(globalThis, {
    document,
    window,
    Node: (window as unknown as { Node?: unknown }).Node,
    HTMLElement: (window as unknown as { HTMLElement?: unknown }).HTMLElement,
    Element: (window as unknown as { Element?: unknown }).Element,
    HTMLBRElement: (window as unknown as { HTMLBRElement?: unknown }).HTMLBRElement,
    localStorage: storage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  try {
    await scenario({ document, window, container });
  } finally {
    restoreDomGlobals(original);
  }
}

function mountComposer(container: Element): { unmount(): void } {
  const root = createRoot(container);
  root.render(
    <LocaleProvider locale="en">
      <Composer onSend={() => undefined} onStop={() => undefined} />
    </LocaleProvider>,
  );
  return root;
}

function editableOf(container: Element): HTMLDivElement {
  const editable = container.querySelector<HTMLDivElement>(
    '[data-maka-contract="composer-input"] [aria-multiline="true"]',
  );
  assert.ok(editable, 'the composer exposes its contenteditable input');
  return editable;
}

/** Type into the editable the way an input event reaches the value owner. */
async function typeDraft(
  dom: InstalledDom,
  draft: string,
): Promise<void> {
  const editable = editableOf(dom.container);
  await act(() => {
    editable.textContent = draft;
    editable.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('a draft closing in on the newest prompt settles without an offer span', async () => {
  await withIsolatedDom(['an older unrelated prompt', NEWEST_PROMPT], async (dom) => {
    const root = mountComposer(dom.container);
    try {
      await act(async () => undefined);
      // The reported crash needed a draft that a completion candidate would
      // extend; type three rounds of it, flushing a few macrotasks after each
      // so every render the offer engine would have chained through actually
      // runs. Each round previously left (or rebuilt) an offer span; with the
      // seam closed none may ever appear, and the input must stay alive.
      for (const draft of ['su', 'summarize the', 'summarize the weekly report']) {
        await typeDraft(dom, draft);
        for (let flush = 0; flush < 5; flush += 1) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
        assert.equal(
          dom.container.querySelectorAll('[data-astryx-inline-completion]').length,
          0,
          'no inline-completion offer span may appear in the composer',
        );
        assert.equal(editableOf(dom.container).isConnected, true);
      }
      assert.equal(
        editableOf(dom.container).textContent,
        'summarize the weekly report',
      );
    } finally {
      root.unmount();
      await drainScheduledWork();
    }
  });
});

test('the history hook exposes no completion source to feed an offer engine', async () => {
  await withIsolatedDom([NEWEST_PROMPT], async (dom) => {
    const textPort: ComposerTextPort = {
      getValue: () => '',
      setValue: () => undefined,
    };
    let api: ReturnType<typeof useComposerHistory> | undefined;
    function Probe() {
      api = useComposerHistory({
        text: textPort,
        saveCurrentDraft: () => undefined,
      });
      return null;
    }
    const root = createRoot(dom.container);
    try {
      act(() => root.render(<Probe />));
      assert.ok(api);
      assert.equal('matchCompletion' in api, false);
    } finally {
      root.unmount();
      await drainScheduledWork();
    }
  });
});

test('the composer passes no inlineCompletion props to ChatComposerInput', () => {
  // The offer engine's only host-side input was these props; assert the seam
  // itself stays closed so the unstable vendor engine can never be fed again.
  const composerSource = readFileSync(
    fileURLToPath(new URL('../../src/composer.tsx', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(composerSource, /inlineCompletion/);
  const historySource = readFileSync(
    fileURLToPath(new URL('../../src/use-composer-history.ts', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(historySource, /matchCompletion|matchPromptHistory/);
});
