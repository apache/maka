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

import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  formatHostHandoff,
  type HostHandoffView,
  type OpenHostHandoffSurface,
} from '@maka/runtime-host/client';

/** One readline lifetime renders the shared decision; it never selects replacement policy. */
export function createCliHostHandoffSurface(
  locale: UiLocale,
  input: Readable = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stderr,
): OpenHostHandoffSurface {
  return (submit) => {
    const readline = createInterface({ input, output, terminal: output.isTTY === true });
    let current: HostHandoffView | undefined;
    let closed = false;
    let ended = false;
    const cancel = () => {
      if (current) submit(current.revision, 'cancel');
    };
    readline.on('SIGINT', cancel);
    readline.on('close', () => {
      ended = true;
      if (!closed) cancel();
    });
    readline.on('line', (line) => {
      if (!current) return;
      const answer = line.trim().toLowerCase();
      const action = answer === 'r' ? 'retry' : answer === 'stop' ? 'interrupt' : 'cancel';
      if (!current.actions.includes(action)) {
        readline.prompt();
        return;
      }
      submit(current.revision, action);
    });
    return {
      update(view) {
        if (closed || current?.revision === view.revision) return;
        current = view;
        if (ended) {
          cancel();
          return;
        }
        // Discard partially typed consent when the observed target/consequences change.
        if (output.isTTY) readline.write(null, { ctrl: true, name: 'u' });
        const copy = formatHostHandoff(view, locale);
        const text = [copy.title, copy.description, copy.detail, view.diagnostic]
          .filter(Boolean)
          .join('\n');
        output.write(
          '\n' +
            stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
              character === '\n' ? character : '\uFFFD',
            ) +
            '\n',
        );
        if (view.actions.length === 0) return;
        const options = copy.actions.map(
          ({ action, label }) =>
            `${action === 'interrupt' ? 'stop' : action === 'retry' ? 'r' : 'Enter'}: ${label}`,
        );
        readline.setPrompt(options.join(' · ') + ' > ');
        readline.prompt();
      },
      close() {
        closed = true;
        readline.close();
      },
    };
  };
}
