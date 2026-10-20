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
 * Pins the one copy of each shell layout number that its consumer cannot
 * reach: JS cannot read var()s and container queries cannot read custom
 * properties, so the same lengths legitimately exist in three places —
 * maka-tokens.css, the renderer contract's JS mirrors, and the composer
 * container query literal. If one moves, they all must.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SHELL_CONTENT_AREA_GAP_PX,
  SHELL_CONVERSATION_MIN_WIDTH_PX,
  shellWorkbarGridRoom,
} from '../../renderer/application/contracts/shell-layout-contract.js';
import { SHELL_WINDOW_MIN_WIDTH } from '../../shared/shell-layout-contract.js';
import { SESSION_LIST_EXPANDED_MIN_WIDTH } from '../../renderer/features/session-navigation/testing.js';
import { SESSION_WORKBAR_MIN_WIDTH } from '../../renderer/features/workbar/testing.js';

const desktopRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rendererRoot = join(desktopRoot, 'src', 'renderer');
const tokens = readFileSync(join(rendererRoot, 'maka-tokens.css'), 'utf8');
const composer = readFileSync(join(rendererRoot, 'styles', 'composer.css'), 'utf8');
const frameStyle = readFileSync(join(rendererRoot, 'shell', 'frame-style.ts'), 'utf8');
const mainWindow = readFileSync(join(desktopRoot, 'src', 'main', 'main-window.ts'), 'utf8');

function tokenPx(name: string): number {
  const match = tokens.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
  return match ? Number(match[1]) : NaN;
}

describe('shell layout width single-sourcing', () => {
  it('keeps the JS mirrors equal to the CSS tokens they duplicate', () => {
    assert.equal(SHELL_CONVERSATION_MIN_WIDTH_PX, tokenPx('--maka-conversation-min-width'));
    assert.equal(SHELL_CONTENT_AREA_GAP_PX, tokenPx('--agents-content-area-gap'));
  });

  it('keeps the composer container-query literal at the conversation floor', () => {
    const match = composer.match(/@container\s+maka-composer\s+\(max-width:\s*(\d+)px\)/);
    assert.ok(match, 'composer.css must size its narrow-footer query off the floor');
    assert.equal(Number(match[1]), SHELL_CONVERSATION_MIN_WIDTH_PX);
  });

  it('keeps the frame Workbar cap on the same two tokens', () => {
    assert.match(frameStyle, /CONVERSATION_FLOOR = 'var\(--maka-conversation-min-width\)'/);
    assert.match(frameStyle, /SEAM = 'var\(--agents-content-area-gap\)'/);
  });

  it('keeps the titlebar overlay height at the --h-titlebar token', () => {
    const match = mainWindow.match(/TITLEBAR_OVERLAY_HEIGHT = (\d+)/);
    assert.ok(match, 'main-window.ts must define TITLEBAR_OVERLAY_HEIGHT');
    assert.equal(Number(match[1]), tokenPx('--h-titlebar'));
  });

  it('leaves the native window floor room for the rail beside the conversation', () => {
    assert.ok(
      SHELL_WINDOW_MIN_WIDTH >=
        SESSION_LIST_EXPANDED_MIN_WIDTH + SHELL_CONVERSATION_MIN_WIDTH_PX + SHELL_CONTENT_AREA_GAP_PX,
      `window floor ${SHELL_WINDOW_MIN_WIDTH} must fit rail ` +
        `${SESSION_LIST_EXPANDED_MIN_WIDTH} + conversation ` +
        `${SHELL_CONVERSATION_MIN_WIDTH_PX} + seam ${SHELL_CONTENT_AREA_GAP_PX}`,
    );
  });

  it('gives the Workbar room only where the grid actually leaves it', () => {
    // The two ends of the compact band beside a default 260px rail: squeezed
    // below its minimum at 960, comfortably over at the 1080 breakpoint.
    assert.ok(shellWorkbarGridRoom(960, 260) < SESSION_WORKBAR_MIN_WIDTH);
    assert.ok(shellWorkbarGridRoom(1080, 260) >= SESSION_WORKBAR_MIN_WIDTH);
    // At the native floor an expanded rail leaves nothing at all.
    assert.equal(shellWorkbarGridRoom(SHELL_WINDOW_MIN_WIDTH, 260), 0);
  });
});
