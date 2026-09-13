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

import type { OrchestrationMode } from './orchestration.js';

export type ParsedSwarmCommand =
  | { kind: 'status' }
  | { kind: 'set_mode'; mode: OrchestrationMode }
  | { kind: 'run_once'; task: string };

/** Parse the exact `/swarm` command without treating lookalike prompts as commands. */
export function parseSwarmCommand(input: string): ParsedSwarmCommand | null {
  const trimmed = input.trim();
  const commandToken = trimmed.split(/\s+/, 1)[0] ?? '';
  if (commandToken !== '/swarm') return null;

  const tail = trimmed.slice(commandToken.length).trim();
  if (!tail || tail === 'status') return { kind: 'status' };
  if (tail === 'on') return { kind: 'set_mode', mode: 'swarm' };
  if (tail === 'off') return { kind: 'set_mode', mode: 'default' };
  return { kind: 'run_once', task: tail };
}
