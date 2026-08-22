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

import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';

/**
 * Keep the canonical Bash result intact for durable storage while removing the
 * command already present in the paired provider-visible Bash call.
 */
export function projectBashToolResultForModel(output: unknown): unknown {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    (output as { kind?: unknown }).kind !== 'terminal'
  ) {
    return output;
  }
  const { cmd: _cmd, ...projected } = output as Record<string, unknown>;
  return projected;
}

export function bashToolResultToModelOutput(output: unknown): ToolResultOutput {
  return toolResultOutput(projectBashToolResultForModel(output), false);
}
