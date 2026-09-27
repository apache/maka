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
import { LocaleProvider } from '../locale-context.js';
import type { BundledSkillCatalogEntry } from '../module-panel-types.js';
import { SkillsModuleMain } from '../skills-panel.js';
import { ToastProvider } from '../toast.js';

function renderDiscover(props: Partial<Parameters<typeof SkillsModuleMain>[0]>): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <ToastProvider>
        <SkillsModuleMain onInstallBundledSkill={() => undefined} onInstallManagedSkill={() => undefined} {...props} />
      </ToastProvider>
    </LocaleProvider>,
  );
}

const computerUse: Omit<BundledSkillCatalogEntry, 'installed'> = {
  id: 'computer-use',
  name: 'Computer Use',
  description: 'Operate desktop applications.',
  category: '效率工具',
  declaredTools: ['Computer'],
};

test('an available bundled skill is offered in Discover with an install action', () => {
  const markup = renderDiscover({ bundledSkillCatalog: [{ ...computerUse, installed: false }] });
  assert.match(markup, /aria-label="Install Computer Use"/);
});

test('an installed bundled skill is listed once, under Installed', () => {
  const markup = renderDiscover({
    skills: [{ id: 'computer-use', name: 'Computer Use', description: 'Operate desktop applications.', path: '/skills/computer-use', sourceType: 'bundled', enabled: true, runtimeStatus: 'enabled' }],
    bundledSkillCatalog: [{ ...computerUse, installed: true }],
  });
  assert.equal(markup.match(/>Computer Use</g)?.length, 1);
  assert.match(markup.split('>Installed<')[1] ?? '', />Computer Use</);
  assert.doesNotMatch(markup, /Install Computer Use/);
});

test('a skill offered both built in and by a source is one Discover entry, the built-in one', () => {
  const markup = renderDiscover({
    bundledSkillCatalog: [{ ...computerUse, installed: false }],
    managedSkillSources: [{ id: 'computer-use', name: 'Computer Use', description: 'From a source.', category: '效率工具', sourceType: 'local' }],
  });
  assert.equal(markup.match(/aria-label="Install Computer Use"/g)?.length, 1);
  assert.match(markup, /Operate desktop applications\./);
  assert.doesNotMatch(markup, /From a source\./);
});
