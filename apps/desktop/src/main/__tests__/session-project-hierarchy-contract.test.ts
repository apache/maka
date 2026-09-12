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

const sidebarCssUrl = [
  new URL('../../renderer/styles/sidebar.css', import.meta.url),
  new URL('../../../src/renderer/styles/sidebar.css', import.meta.url),
].find((candidate) => existsSync(candidate));

if (!sidebarCssUrl) throw new Error('Could not locate renderer/styles/sidebar.css');

const sidebarCss = readFileSync(sidebarCssUrl, 'utf8');

describe('project-grouped session hierarchy', () => {
  it('shares the project row left edge with its sessions', () => {
    const projectChildrenRule = sidebarCss.match(
      /\.maka-project-row\s*>\s*div\s*>\s*\[role=["']group["']\]\s*>\s*div\s*\{([^}]*)\}/,
    );

    assert.ok(projectChildrenRule, 'project children must have an explicit hierarchy rule');
    // Product contract: session rows sit on the project row's left edge, so
    // the two hover/selected fills start on the same x rather than the 8px
    // nest that used to offset only the session rows. SideNav's default
    // spacing-6 is a fixed child inset, not that alignment.
    //
    // These pin the declarations, not the geometry they serve: a StyleX
    // default, a later equal-or-higher-specificity rule, or a renamed wrapper
    // class would leave this green while the rail drifts apart. The rendered
    // half is owned by the ProjectGroups play in
    // packages/ui/stories/session-list-panel.stories.tsx (session inset within
    // 1px, title x within 2px).
    assert.match(
      projectChildrenRule[1] ?? '',
      /padding-inline-start:\s*0\s*!important;/,
      'project sessions must not be inset from the project row',
    );

    // The gutter that replaces the nest: the same 1rem box as the project
    // folder icon, so titles still share one x.
    const signalRule = sidebarCss.match(/\.maka-session-row-signal\s*\{([^}]*)\}/);
    assert.ok(signalRule, 'the session status gutter must be declared');
    assert.match(
      signalRule[1] ?? '',
      /width:\s*1rem;/,
      'the session status gutter must match the project folder icon width',
    );
  });
});
