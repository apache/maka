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

import type { BrowserWindowConstructorOptions } from 'electron';
import type { CuE2eScenario } from './e2e-scenarios.mjs';

interface FixtureWindow {
  id: number;
  isDestroyed(): boolean;
  destroy(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  getContentBounds(): { x: number; y: number; width: number; height: number };
  showInactive(): void;
  moveTop(): void;
  setMenuBarVisibility(visible: boolean): void;
  loadURL(url: string): Promise<void>;
  webContents: {
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  };
}

export function createCuE2eFixture(input: {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => FixtureWindow;
  screen: {
    getPrimaryDisplay(): {
      workArea: { x: number; y: number; width: number; height: number };
    };
  };
  scenario: CuE2eScenario;
}): Promise<{
  scenario: CuE2eScenario;
  staleWindowIds: readonly number[];
  windowIds(): string[];
  getWindow(windowId: string): FixtureWindow;
  getWindowTitle(windowId: string): string;
  readState(windowId: string): Promise<unknown>;
  readAllStates(): Promise<Record<string, unknown>>;
  elementScreenRect(
    windowId: string,
    selector: string,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  elementScreenPoint(windowId: string, selector: string): Promise<{ x: number; y: number }>;
  destroy(): void;
}>;
