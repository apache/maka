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
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const composerCssUrl = [
  new URL('../../renderer/styles/composer.css', import.meta.url),
  new URL('../../../src/renderer/styles/composer.css', import.meta.url),
].find((candidate) => existsSync(candidate));

if (!composerCssUrl) throw new Error('Could not locate renderer/styles/composer.css');

const composerCss = readFileSync(composerCssUrl, 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = composerCss.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}', 'u'));
  assert.ok(match, 'missing composer layout rule: ' + selector);
  return match[1] ?? '';
}

describe('composer footer layout', () => {
  it('lets the left footer shrink without growing its wrapper', () => {
    const footerLeft = rule('.maka-composer-astryx div:has(> .maka-composer-left-controls)');
    assert.match(footerLeft, /min-width:\s*0;/u);
    assert.doesNotMatch(footerLeft, /flex:/u);
  });

  it('keeps model controls on one row and permits long labels to ellipsize', () => {
    const controls = rule('.maka-composer-left-controls');
    assert.match(controls, /flex-wrap:\s*nowrap;/u);
    assert.match(controls, /min-width:\s*0;/u);

    const modelSelection = rule('.maka-composer-left-controls .maka-model-selection-controls');
    assert.match(modelSelection, /min-width:\s*0;/u);
    assert.match(modelSelection, /flex:\s*0\s+1\s+auto;/u);
    assert.match(modelSelection, /max-width:\s*100%;/u);

    const modelText = rule('.maka-composer-model-chip-text');
    assert.match(modelText, /text-overflow:\s*ellipsis;/u);
    assert.match(modelText, /white-space:\s*nowrap;/u);
  });
});
