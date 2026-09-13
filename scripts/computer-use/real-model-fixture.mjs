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

import { app, BrowserWindow, screen } from 'electron';
import { getCuE2eScenario } from './e2e-scenarios.mjs';
import { createCuE2eFixture } from './e2e-fixture.mjs';

const scenario = getCuE2eScenario(process.env.MAKA_CU_E2E_SCENARIO ?? 'l0-observe-only');

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

let fixture;

app.whenReady().then(async () => {
  fixture = await createCuE2eFixture({ BrowserWindow, screen, scenario });
  for (let index = 0; index < 4; index += 1) {
    for (const windowId of fixture.windowIds()) {
      const window = fixture.getWindow(windowId);
      window.showInactive();
      window.moveTop();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.stdout.write(`CU_FIXTURE_READY ${process.pid}\n`);
});

async function shutdown() {
  fixture?.destroy();
  app.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
