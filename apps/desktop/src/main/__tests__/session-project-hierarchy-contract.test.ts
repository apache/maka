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
  it('uses one shared gap between adjacent session rows in every grouping mode', () => {
    const adjacentSessionRule = sidebarCss.match(
      /\.maka-session-row\s*\+\s*\.maka-session-row\s*\{([^}]*)\}/,
    );

    assert.ok(adjacentSessionRule, 'adjacent session rows must share an explicit spacing rule');
    assert.match(
      adjacentSessionRule[1] ?? '',
      /margin-block-start:\s*var\(--space-0-5\);/,
      'session rows must use the shared 2px spacing token',
    );
  });

  it('paints both rows on action hover without promoting the row to pressed', () => {
    const hoverRule = sidebarCss.match(
      /@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?background-color:\s*var\(--color-overlay-hover\);[\s\S]*?)\n\}/,
    );
    assert.ok(hoverRule, 'action hover feedback must be gated to fine pointers');
    assert.match(
      hoverRule[1] ?? '',
      /\.maka-project-row:has\(> div > \.maka-session-row-action:hover\)/,
      'project action hover must paint its navigation row',
    );
    assert.match(
      hoverRule[1] ?? '',
      /\.maka-session-row:has\(> \.maka-session-row-action:hover\)/,
      'project and session action hover must paint their navigation row identically',
    );
    assert.doesNotMatch(
      sidebarCss,
      /\.maka-project-row:has\(> div > \.maka-session-row-action button:active\)/,
      'project action press must remain local to the action button',
    );
    assert.doesNotMatch(
      sidebarCss,
      /\.maka-session-row:has\(> \.maka-session-row-action button:active\)/,
      'session action press must remain local to the action button',
    );
  });

  it('keeps nested session buttons the same inline length as the project header', () => {
    const projectChildrenRule = sidebarCss.match(
      /\.maka-project-row\s*>\s*div\s*>\s*\[role=["']group["']\]\s*>\s*div\s*\{([^}]*)\}/,
    );

    assert.ok(projectChildrenRule, 'project children must have an explicit hierarchy rule');
    // SideNav's default spacing-6 would inset the whole session button.
    assert.match(
      projectChildrenRule[1] ?? '',
      /padding-inline-start:\s*0\s*!important;/,
      'project sessions must not inherit SideNav\'s nested inset',
    );
  });
});
