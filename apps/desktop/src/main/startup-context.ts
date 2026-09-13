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

import { app } from 'electron';

// E2E switches must never fire in a packaged build, and must never run against
// the real user data: a stray MAKA_E2E on a build/dev machine would otherwise
// swap in the fake backend or hide the window. app.isPackaged is true for
// asar-packaged builds; MAKA_E2E_USER_DATA_DIR must also be set, so the fake
// backend can't write test sessions into a real profile if someone sets only
// MAKA_E2E.
export const hasIsolatedE2eProfile =
  !app.isPackaged &&
  !!process.env.MAKA_E2E_USER_DATA_DIR;
export const isE2e = hasIsolatedE2eProfile && process.env.MAKA_E2E === '1';
export const isComputerUseRealModelE2e =
  hasIsolatedE2eProfile &&
  process.env.MAKA_CU_REAL_MODEL_E2E === '1';
export const isIsolatedE2e = isE2e || isComputerUseRealModelE2e;
