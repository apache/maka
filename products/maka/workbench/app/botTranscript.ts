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

import { signal } from 'nsh';
import type { createHost } from './host';
import { createBotTranscriptCore } from './botTranscriptCore';

export type { BotTranscriptMessage } from './botTranscriptCore';
export { botTurnEnding } from './botTranscriptCore';

/** Reactive view of the Bot's transcript; see `createBotTranscriptCore`. */
export function createBotTranscript(
  host: Pick<ReturnType<typeof createHost>, 'query' | 'subscribe'>,
  sessionId: string,
  known: () => string | null | undefined = () => undefined,
) {
  const version = signal(0);
  const core = createBotTranscriptCore(
    host as never,
    sessionId,
    () => version.set(version() + 1),
    undefined,
    // Read through a signal so a later answer from the application is noticed.
    () => known(),
  );
  return {
    isBot: () => (version(), known(), core.isBot()),
    /** `unknown` until the Host answers; Chat must not treat unknown as ordinary. */
    identity: () => (version(), known(), core.identity()),
    forTurn: (turnId: string) => (version(), core.forTurn(turnId)),
    close: () => core.close(),
  };
}
