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

import { clearLine, createInterface, cursorTo, type Interface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  formatHostHandoff,
  type HostHandoffView,
  type OpenHostHandoffSurface,
} from '@maka/runtime-host/client';

/** The surface owns terminal input; replacement policy stays in the shared handoff. */
export function createCliHostHandoffSurface(
  locale: UiLocale,
  input: Readable = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stderr,
): OpenHostHandoffSurface {
  return (submit) => {
    let readline: Interface | undefined;
    let current: HostHandoffView | undefined;
    let closed = false;
    let ended = false;
    const releaseReader = () => {
      const previous = readline;
      readline = undefined;
      previous?.close();
    };
    const cancel = () => {
      if (current) submit(current.revision, 'cancel');
    };
    return {
      update(view) {
        if (closed || current?.revision === view.revision) return;
        current = view;
        if (ended) {
          cancel();
          return;
        }
        // A new observation gets a new input buffer. Ctrl+U leaves text after
        // the cursor intact and is ignored by readline in TERM=dumb.
        releaseReader();
        if (output.isTTY) {
          clearLine(output, 0);
          cursorTo(output, 0);
        }
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
        // Create the reader only after the explanation is visible, with the
        // final action prompt already installed. Never draw readline's default >.
        const reader = createInterface({
          input,
          output,
          terminal: output.isTTY === true,
          prompt: options.join(' · ') + ' > ',
        });
        readline = reader;
        reader.on('SIGINT', cancel);
        reader.on('close', () => {
          if (readline !== reader) return;
          ended = true;
          if (!closed) cancel();
        });
        reader.on('line', (line) => {
          if (readline !== reader || current?.revision !== view.revision) return;
          const answer = line.trim().toLowerCase();
          const action =
            answer === 'r'
              ? 'retry'
              : answer === 'stop'
                ? 'interrupt'
                : answer === ''
                  ? 'cancel'
                  : undefined;
          if (!action || !view.actions.includes(action)) {
            reader.prompt();
            return;
          }
          submit(view.revision, action);
        });
        reader.prompt();
      },
      close() {
        closed = true;
        releaseReader();
      },
    };
  };
}
