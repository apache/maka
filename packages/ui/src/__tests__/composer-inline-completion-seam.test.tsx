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
 * Regression contract for the renderer crash reported in apache/maka#4117.
 *
 * The 0.1.11 composer fed a prompt-history completion candidate to the Astryx
 * `ChatComposerInput` inline-offer engine:
 *
 *     inlineCompletion={matchCompletion(text) ?? undefined}
 *
 * That vendor engine (0.4.0) re-decided the offer after every render through a
 * dependency-less `useEffect(reconcileOffer)`, and both of its exits wrote the
 * same announcement state — `withdrawOffer()` unconditionally called
 * `setInlineCompletionAnnouncement('')` while a standing offer called it with
 * the offer text. Whether the loop terminated depended on a
 * `getBoundingClientRect` comparison (`offerFullyVisible`) agreeing between
 * the pass that inserted the offer span and the pass that re-measured it after
 * the announcement commit. When real layout disagreed — a draft at the
 * max-rows scroll cap, the offer's tail wrapping the field's bottom edge
 * inside the tolerance, zoom or font rounding — the two writes flip-flopped,
 * each flip scheduled another commit-phase update in the same nested chain,
 * and React threw error 185 ("Maximum update depth exceeded") at the
 * fiftieth. The renderer crash dialog in the report is that throw; the
 * minified stack resolves to `withdrawOffer`'s announcement dispatch called
 * from `reconcileOffer` inside `ChatComposerInput`, mounted by the composer
 * form.
 *
 * The seam is closed on two sides — the completion wiring was removed from
 * the composer (#3292), and Astryx 0.5.0 no longer ships the engine (#3755).
 * The flip-flop itself cannot be pinned by a unit harness: it needs real
 * Chromium layout to disagree between the two measurement passes, which no
 * DOM emulator performs. What every reintroduction would have to touch — and
 * what these tests therefore pin — is the seam itself:
 *
 *   1. the composer passes no `inlineCompletion*` prop to `ChatComposerInput`;
 *   2. the history hook carries no prompt-completion source to feed one.
 *
 * A safe reintroduction means a loop-proof offer engine (termination must not
 * rest on cross-pass layout agreement) plus recorded capacity to detect the
 * loop; neither exists today.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function readPackageSource(relativePath: string): string {
  const url = new URL(`../../src/${relativePath}`, import.meta.url);
  try {
    return readFileSync(fileURLToPath(url), 'utf8');
  } catch (error) {
    throw new Error(
      `expected ${relativePath} beside the test source; update the seam contract if it moved`,
      { cause: error },
    );
  }
}

test('the composer passes no inlineCompletion props to ChatComposerInput', () => {
  const composerSource = readPackageSource('composer.tsx');
  assert.doesNotMatch(
    composerSource,
    /inlineCompletion/,
    'composer.tsx feeds ChatComposerInput an inline completion again — that wiring drove the ' +
      'layout-dependent announcement flip-flop behind the #4117 renderer crash (React error 185). ' +
      'Reintroducing it needs a loop-proof offer engine and a recorded decision; see the file ' +
      'header and the removal in #3292.',
  );
});

test('the history hook carries no prompt-completion source', () => {
  const historySource = readPackageSource('use-composer-history.ts');
  assert.doesNotMatch(
    historySource,
    /matchCompletion|matchPromptHistory|prompt-history-match/,
    'use-composer-history.ts exposes a prompt-history completion again — the only consumer that ' +
      'matcher ever had was the inline-completion prop behind the #4117 renderer crash.',
  );
});
