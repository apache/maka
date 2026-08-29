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
import { TranscriptHistoryNotice } from '../chat-view.js';

function renderNotice(isPending: boolean): string {
  return renderToStaticMarkup(
    <TranscriptHistoryNotice
      title="Viewing earlier messages"
      actionLabel="Return to latest"
      isPending={isPending}
      onReturnToLatest={() => undefined}
    />,
  );
}

test('presents historical position as quiet persistent status', () => {
  const markup = renderNotice(false);

  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-atomic="true"/);
  assert.match(markup, /Viewing earlier messages/);
  assert.match(markup, /Return to latest/);
  assert.doesNotMatch(markup, /saved|loaded/);
  assert.doesNotMatch(markup, /<strong/);
  assert.doesNotMatch(markup, /disabled/);
});

test('keeps the position status visible while return-to-latest is pending', () => {
  const markup = renderNotice(true);

  assert.match(markup, /Viewing earlier messages/);
  assert.doesNotMatch(markup, /saved|loaded/);
  assert.match(markup, /disabled/);
});
