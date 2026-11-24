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

import { cleanup, signal } from 'nsh';

const order = ['copy', 'ask', 'quote', 'fork', 'regenerate', 'edit'] as const;

/** A message action that its context menu offers beside its button. */
export type MessageCommand = {
  kind: (typeof order)[number];
  label(): string;
  busy(): boolean;
  /** The action as the menu opens, or null where the message has none. */
  action(): (() => void) | null;
};

/** The context menu of one message; its actions add their commands while they exist. */
export type MessageMenu = ReturnType<typeof createMessageMenu>;

export function createMessageMenu() {
  const commands = signal<MessageCommand[]>([]);
  return {
    commands: () => [...commands()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
    add(command: MessageCommand) {
      commands.set([...commands(), command]);
      cleanup(() => commands.set(commands().filter((item) => item !== command)));
    },
  };
}
