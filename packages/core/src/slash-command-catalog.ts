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

export type SlashCommandSessionRequirement = 'none' | 'required';
export type SlashCommandSurface = 'desktop' | 'tui';

export interface SlashCommandSpec {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly session: SlashCommandSessionRequirement;
  readonly surfaces: readonly SlashCommandSurface[];
}

export const SLASH_COMMAND_CATALOG = [
  { id: 'compact', session: 'required', surfaces: ['desktop', 'tui'] },
  { id: 'context', session: 'required', surfaces: ['tui'] },
  { id: 'exit', aliases: ['quit'], session: 'none', surfaces: ['tui'] },
  { id: 'goal', session: 'required', surfaces: ['tui'] },
  { id: 'graph', session: 'none', surfaces: ['desktop', 'tui'] },
  { id: 'help', session: 'none', surfaces: ['tui'] },
  { id: 'model', session: 'required', surfaces: ['tui'] },
  { id: 'move', session: 'required', surfaces: ['tui'] },
  { id: 'new', session: 'none', surfaces: ['tui'] },
  { id: 'permissions', session: 'required', surfaces: ['tui'] },
  { id: 'recap', session: 'required', surfaces: ['tui'] },
  { id: 'rename', session: 'required', surfaces: ['tui'] },
  { id: 'resume', session: 'required', surfaces: ['tui'] },
  { id: 'rewind', session: 'required', surfaces: ['tui'] },
  { id: 'session', session: 'none', surfaces: ['tui'] },
  { id: 'setup', session: 'none', surfaces: ['tui'] },
  { id: 'side', session: 'required', surfaces: ['desktop'] },
  { id: 'skill', session: 'required', surfaces: ['tui'] },
  { id: 'swarm', session: 'none', surfaces: ['desktop', 'tui'] },
  { id: 'thinking', session: 'required', surfaces: ['tui'] },
  { id: 'transcript', session: 'required', surfaces: ['tui'] },
] as const satisfies readonly SlashCommandSpec[];

export type SlashCommandId = (typeof SLASH_COMMAND_CATALOG)[number]['id'];

type CatalogCommand = (typeof SLASH_COMMAND_CATALOG)[number];
type CatalogCommandForSurface<Command, Surface extends SlashCommandSurface> = Command extends {
  readonly surfaces: readonly SlashCommandSurface[];
}
  ? Surface extends Command['surfaces'][number]
    ? Command
    : never
  : never;

export type SlashCommandForSurface<Surface extends SlashCommandSurface> = CatalogCommandForSurface<
  CatalogCommand,
  Surface
>;
export type SlashCommandIdForSurface<Surface extends SlashCommandSurface> =
  SlashCommandForSurface<Surface>['id'];

export function slashCommandsForSurface<Surface extends SlashCommandSurface>(
  surface: Surface,
): readonly SlashCommandForSurface<Surface>[] {
  return SLASH_COMMAND_CATALOG.filter((command) =>
    (command.surfaces as readonly SlashCommandSurface[]).includes(surface),
  ) as unknown as readonly SlashCommandForSurface<Surface>[];
}
