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

import { parseGraphCommand, type ParsedGraphCommand } from '@maka/core/graph-command';
import { parseSwarmCommand, type ParsedSwarmCommand } from '@maka/core/swarm-command';
import { parseSideChatCommand, type SideChatCommand } from './side-chat-command.js';

export type DesktopSlashCommand =
  | { kind: 'compact' }
  | { kind: 'side'; command: SideChatCommand }
  | { kind: 'graph'; command: ParsedGraphCommand }
  | { kind: 'swarm'; command: ParsedSwarmCommand };

/** Classify input with the same parsers that own Desktop command execution. */
export function parseDesktopSlashCommand(input: string): DesktopSlashCommand | null {
  if (input.trim() === '/compact') return { kind: 'compact' };
  const side = parseSideChatCommand(input);
  if (side) return { kind: 'side', command: side };
  const graph = parseGraphCommand(input);
  if (graph) return { kind: 'graph', command: graph };
  const swarm = parseSwarmCommand(input);
  return swarm ? { kind: 'swarm', command: swarm } : null;
}
