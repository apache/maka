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
 * Regression boundary retained after apache/maka#4117 (React error 185).
 * Maka 0.1.11 patched Astryx 0.4.0 with a layout-measuring inline offer engine;
 * the published upstream 0.4.0 package did not contain that engine.
 *
 * The old effect could alternate visibility and announcement state, but this
 * remains a suspected mechanism, not a reproduced cause of the reported crash.
 * A real Chromium sweep on 2026-09-22 covered 2,040 natural layout/edit cases
 * without errors. Artificial alternating geometry caused repeated DOM updates
 * but did not reproduce React error 185 either. See
 * https://github.com/ARE404/maka-agent/blob/d5ae5b88d11f223fe006f073058f12273ee39411/docs/reports/prompt-suggestion-repro/README.md
 * for evidence and limitations.
 *
 * Keep the removed history-to-inline-engine wiring closed. Next-prompt
 * prediction uses an independent overlay with no layout-driven state effects.
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
      'suspected layout-dependent announcement loop investigated after #4117 (React error 185). ' +
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
      'matcher ever had was the inline-completion prop investigated after #4117.',
  );
});
