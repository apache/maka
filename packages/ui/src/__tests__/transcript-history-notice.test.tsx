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
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptGapRow } from '../chat-view.js';

function renderGap(direction: 'older' | 'newer', isPending: boolean): string {
  return renderToStaticMarkup(
    <TranscriptGapRow
      direction={direction}
      description={direction === 'older' ? 'Earlier messages are not loaded.' : 'Newer messages are not loaded.'}
      actionLabel={direction === 'older' ? 'Load earlier messages' : 'Load newer messages'}
      isPending={isPending}
      onActivate={() => undefined}
    />,
  );
}

test('presents an older boundary gap as an in-flow transcript row', () => {
  const markup = renderGap('older', false);

  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-atomic="true"/);
  assert.match(markup, /data-transcript-gap="older"/);
  assert.match(markup, /maka-transcript-gap-row/);
  assert.match(markup, /Earlier messages are not loaded/);
  assert.match(markup, /Load earlier messages/);
  assert.doesNotMatch(markup, /<strong/);
  assert.doesNotMatch(markup, /disabled/);
});

test('keeps a newer boundary gap visible while its shared loader is pending', () => {
  const markup = renderGap('newer', true);

  assert.match(markup, /data-transcript-gap="newer"/);
  assert.match(markup, /Newer messages are not loaded/);
  assert.match(markup, /Load newer messages/);
  assert.match(markup, /disabled/);
  assert.match(markup, /aria-busy="true"/);
});
