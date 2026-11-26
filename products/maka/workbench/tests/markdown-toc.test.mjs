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
import test from 'node:test';
import { pickActiveHeading, pickViewedTurn, tocLayoutMode } from '../app/markdownTocModel.ts';

test('tocLayoutMode picks docked on wide margins, compact only when left gutter clears text, and hidden on narrow viewports', () => {
  assert.equal(tocLayoutMode({ listWidth: 1400, railInset: 0, terminal: false }).kind, 'docked');
  assert.equal(tocLayoutMode({ listWidth: 1400, railInset: 0, terminal: true }).kind, 'docked');
  // 720px with 44px TurnRail gutter leaves a 44px left gutter: compact fits cleanly beside text.
  const compactWithRail = tocLayoutMode({ listWidth: 720, railInset: 44, terminal: false });
  assert.equal(compactWithRail.kind, 'compact');
  // Without TurnRail at 800px there is no left gutter: must hide rather than cover text.
  assert.equal(tocLayoutMode({ listWidth: 800, railInset: 0, terminal: false }).kind, 'hidden');
  assert.equal(tocLayoutMode({ listWidth: 960, railInset: 44, terminal: true }).kind, 'hidden');
});

test('pickViewedTurn selects the turn with largest visible overlap and preserves tie preference', () => {
  const turns = [
    { turnKey: 't1', top: -200, bottom: 120 },
    { turnKey: 't2', top: 130, bottom: 580 },
  ];
  assert.equal(pickViewedTurn(turns, 0, 600, 't1'), 't2');
  const tied = [
    { turnKey: 't1', top: 0, bottom: 300 },
    { turnKey: 't2', top: 300, bottom: 600 },
  ];
  assert.equal(pickViewedTurn(tied, 0, 600, 't1'), 't1');
  assert.equal(pickViewedTurn(tied, 0, 600, 't2'), 't2');
});

test('pickActiveHeading tracks reading block across multi-part outputs and highlights last section at bottom', () => {
  const items = [
    { id: 'p0:0', partKey: 'p0', blockIndex: 0 },
    { id: 'p0:12', partKey: 'p0', blockIndex: 12 },
    { id: 'p1:0', partKey: 'p1', blockIndex: 0 },
    { id: 'p1:10', partKey: 'p1', blockIndex: 10 },
  ];
  assert.equal(
    pickActiveHeading(
      items,
      [
        { partKey: 'p0', firstBlock: 14, lastBlock: 20 },
        { partKey: 'p1', firstBlock: null, lastBlock: null },
      ],
      false,
    ),
    'p0:12',
  );
  // Second BotReply message visible while first scrolled offscreen.
  assert.equal(
    pickActiveHeading(
      items,
      [
        { partKey: 'p0', firstBlock: null, lastBlock: null },
        { partKey: 'p1', firstBlock: 2, lastBlock: 12 },
      ],
      false,
    ),
    'p1:0',
  );
  // At bottom (Return to latest): highlights final visible heading even when firstBlock is earlier.
  assert.equal(
    pickActiveHeading(
      items,
      [
        { partKey: 'p0', firstBlock: null, lastBlock: null },
        { partKey: 'p1', firstBlock: 6, lastBlock: 14 },
      ],
      true,
    ),
    'p1:10',
  );
  // Footnotes-only viewport (no content blocks visible): keeps final section at bottom
  // or preserves the prior active section mid-transcript without snapping back to item 0.
  assert.equal(
    pickActiveHeading(
      items,
      [
        { partKey: 'p0', firstBlock: null, lastBlock: null },
        { partKey: 'p1', firstBlock: null, lastBlock: null },
      ],
      true,
      'p0:12',
    ),
    'p1:10',
  );
  assert.equal(
    pickActiveHeading(
      items,
      [
        { partKey: 'p0', firstBlock: null, lastBlock: null },
        { partKey: 'p1', firstBlock: null, lastBlock: null },
      ],
      false,
      'p1:0',
    ),
    'p1:0',
  );
});
