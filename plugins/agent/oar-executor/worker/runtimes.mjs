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

import { antigravityRuntime } from '@botiverse/oar/runtimes/antigravity';
import { claudeRuntime } from '@botiverse/oar/runtimes/claude';
import { codebuddyRuntime } from '@botiverse/oar/runtimes/codebuddy';
import { codexRuntime } from '@botiverse/oar/runtimes/codex';
import { grokRuntime } from '@botiverse/oar/runtimes/grok';
import { kimiRuntime } from '@botiverse/oar/runtimes/kimi';
import { opencodeRuntime } from '@botiverse/oar/runtimes/opencode';
import { qoderRuntime } from '@botiverse/oar/runtimes/qoder';
import { qwenRuntime } from '@botiverse/oar/runtimes/qwen';

// SDK runtimes have no independently owned process tree to settle.
export const runtimes = new Map(
  [
    antigravityRuntime,
    claudeRuntime,
    codebuddyRuntime,
    codexRuntime,
    grokRuntime,
    kimiRuntime,
    opencodeRuntime,
    qoderRuntime,
    qwenRuntime,
  ].map((runtime) => [runtime.id, runtime]),
);
