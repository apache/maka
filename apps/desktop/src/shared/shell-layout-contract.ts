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

/* The Desktop shell's width contract, in one place for the main process and
   the renderer. The renderer side lives in
   `src/renderer/application/contracts/shell-layout-contract.ts`; CSS reads the
   two lengths it needs from tokens (`--maka-conversation-min-width`,
   `--agents-content-area-gap`) because the WorkHub renderer is a separate
   document that loads the same token sheet. */

/**
 * The native window floor. The frame caps the sidebar and the Workbar so the
 * conversation keeps its minimum; this is what leaves the sidebar its own
 * minimum (180px) beside that conversation and the seam between them, so no
 * width the window can reach clips the shell.
 */
export const SHELL_WINDOW_MIN_WIDTH = 600;
