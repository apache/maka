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
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { Archive, Unarchive } from '../icons.js';

function iconPathData(icon: ReactElement): string[] {
  const { document } = parseHTML(renderToStaticMarkup(icon));
  return [...document.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '');
}

test('archive and unarchive use one tray with inverse arrows', () => {
  const archive = iconPathData(<Archive />);
  const unarchive = iconPathData(<Unarchive />);

  assert.deepEqual(archive.slice(0, 2), unarchive.slice(0, 2));
  assert.deepEqual(archive.slice(2), ['M12 3v14', 'm7 12 5 5 5-5']);
  assert.deepEqual(unarchive.slice(2), ['M12 17V3', 'm7 8 5-5 5 5']);
});
