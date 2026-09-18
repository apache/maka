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
 * Loopback ranges for the suites that bind real Command Code login listeners.
 * `node --test` runs test files side by side, so each suite walks a range of
 * its own that starts where the previous one ends. All of them sit off the
 * CLI's range, so a developer's own `command-code login` and the tests never
 * contend for a port.
 */

/** `commandcode-browser-login.test.ts`. */
export const CONTROLLER_SUITE_PORTS = { startPort: 46_959, maxPortAttempts: 10 } as const;

/** `commandcode-login-ipc-main.test.ts`. */
export const IPC_SUITE_PORTS = {
  startPort: CONTROLLER_SUITE_PORTS.startPort + CONTROLLER_SUITE_PORTS.maxPortAttempts,
  maxPortAttempts: 10,
} as const;
