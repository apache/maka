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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionReviewBaseBranchPicker,
} from '../../renderer/features/workbar/testing.js';

const AUTO_SENTINEL = 'AUTO_SENTINEL';

function renderPicker(baseBranch: string | null) {
  return renderToStaticMarkup(
    createElement(SessionReviewBaseBranchPicker, {
      baseBranch,
      baseBranchOptions: [
        { label: 'main', value: 'refs/heads/main' },
        { label: 'origin/develop', value: 'refs/remotes/origin/develop' },
      ],
      label: AUTO_SENTINEL,
      onSelect: () => undefined,
    }),
  );
}

/** The visible trigger only: `label` is required by Selector and always lands
 * in the markup as a visually hidden element, sentinel and all. */
function renderTrigger(baseBranch: string | null) {
  const markup = renderPicker(baseBranch);
  const start = markup.indexOf('<button');
  return markup.slice(start, markup.indexOf('</button>', start));
}

describe('session review base branch', () => {
  it('shows the compared branch instead of an auto pseudo-entry', () => {
    const trigger = renderTrigger('refs/remotes/origin/develop');
    assert.match(trigger, />origin\/develop</);
    assert.doesNotMatch(trigger, /refs\/remotes/);
    assert.doesNotMatch(trigger, new RegExp(AUTO_SENTINEL));
  });

  it('falls back to the plain label while nothing is pinned', () => {
    assert.match(renderTrigger(null), new RegExp(AUTO_SENTINEL));
  });
});
