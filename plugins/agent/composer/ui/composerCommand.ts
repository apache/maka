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

import type { ComposerCommand } from '../../../../packages/plugin-sdk/src/composer-view.js';

type Invocation = {
  owner: object;
  text: string;
  revision: string | number;
  command: ComposerCommand;
  argument?: string;
  current(): boolean;
  consume?(): void;
};

export function createComposerCommandRunner() {
  let pending: Invocation | null = null;
  return (invocation: Invocation) => {
    if (
      pending?.owner === invocation.owner &&
      pending.text === invocation.text &&
      pending.revision === invocation.revision &&
      pending.command.id === invocation.command.id
    )
      return;
    pending = invocation;
    const finish = (accepted: void | boolean) => {
      if (pending === invocation) pending = null;
      if (accepted !== false && invocation.current()) invocation.consume?.();
    };
    try {
      const result = invocation.command.run(invocation.argument);
      if (result instanceof Promise)
        void result.then(finish, (reason) => {
          if (pending === invocation) pending = null;
          throw reason;
        });
      else finish(result);
    } catch (reason) {
      if (pending === invocation) pending = null;
      throw reason;
    }
  };
}

export type ComposerCommandRunner = ReturnType<typeof createComposerCommandRunner>;
