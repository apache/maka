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

import type { BrowserViewRect } from '@maka/core/browser';

export interface ResolvedBrowserSession {
  readonly scope: unknown;
  readonly sessionId: string;
}

interface BrowserSelectionSink {
  show(documentId: string, generation: number, session: ResolvedBrowserSession): void;
  hide(documentId: string, generation: number): void;
  setViewport(
    documentId: string,
    generation: number,
    session: ResolvedBrowserSession,
    rect: BrowserViewRect | null,
  ): void;
}

/**
 * Orders native browser visibility around the renderer's current selection.
 * Session ownership resolution may finish out of order, so every async result
 * must still belong to the selection generation that started it before it can
 * reach main.
 */
export function createBrowserSelectionCoordinator(
  resolveSession: (sessionId: string) => Promise<ResolvedBrowserSession>,
  sink: BrowserSelectionSink,
  documentId: string = crypto.randomUUID(),
) {
  let generation = 0;
  let current:
    | {
        readonly generation: number;
        readonly sessionId: string;
        readonly resolved: Promise<ResolvedBrowserSession>;
      }
    | undefined;

  const isCurrent = (selection: NonNullable<typeof current>): boolean =>
    current === selection;

  return {
    setActiveSession(sessionId: string | null): void {
      generation += 1;
      if (!sessionId) {
        current = undefined;
        sink.hide(documentId, generation);
        return;
      }

      const selection = {
        generation,
        sessionId,
        resolved: resolveSession(sessionId),
      };
      current = selection;
      void selection.resolved.then(
        (session) => {
          if (isCurrent(selection)) sink.show(documentId, selection.generation, session);
        },
        () => {
          if (isCurrent(selection)) sink.hide(documentId, selection.generation);
        },
      );
    },

    setViewport(input: { sessionId: string; rect: BrowserViewRect | null }): void {
      const selection = current;
      if (!selection || selection.sessionId !== input.sessionId) return;
      void selection.resolved.then(
        (session) => {
          if (isCurrent(selection)) {
            sink.setViewport(documentId, selection.generation, session, input.rect);
          }
        },
        () => undefined,
      );
    },
  };
}
