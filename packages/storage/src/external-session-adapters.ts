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

import { ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import {
  ClaudeCodeSessionAdapter,
  type ClaudeCodeSessionAdapterOptions,
} from './claude-code-session-adapter.js';
import { CodexSessionAdapter, type CodexSessionAdapterOptions } from './codex-session-adapter.js';

export interface ExternalSessionAdapterOptions {
  codex?: CodexSessionAdapterOptions;
  claudeCode?: ClaudeCodeSessionAdapterOptions;
}

/** Default source registry shared by product-facing external Session import surfaces. */
export function createExternalSessionAdapterRegistry(
  options: ExternalSessionAdapterOptions = {},
): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([
    new CodexSessionAdapter(options.codex),
    new ClaudeCodeSessionAdapter(options.claudeCode),
  ]);
}
