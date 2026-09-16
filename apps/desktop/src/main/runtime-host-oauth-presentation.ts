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

import type { OAuthPresentationBackend } from '@maka/runtime-host/client';

const PRESENTATION_TIMEOUT_MS = 30_000;

export interface OAuthExternalPresentation {
  readonly stateHint: string;
}

export interface OAuthPresentationExpectation {
  readonly presented: Promise<OAuthExternalPresentation>;
  renew(): void;
  cancel(reason?: unknown): void;
}

/** Never crosses the Host protocol: raised and consumed inside the main process. */
export class OAuthPresentationError extends Error {
  name = 'OAuthPresentationError';
}

export class OAuthLoginInProgressError extends Error {
  name = 'OAuthLoginInProgressError';
}

/** Bridges a Host-owned OAuth attempt to Desktop-owned system-browser presentation. */
export class RuntimeHostOAuthPresentation implements OAuthPresentationBackend {
  #pending: PendingPresentation | undefined;

  constructor(private readonly openSystemBrowser: (url: string) => Promise<void>) {}

  expect(attemptId: string, expectedStateHint?: string): OAuthPresentationExpectation {
    if (this.#pending) throw new OAuthLoginInProgressError('Another OAuth login is already in progress');
    let resolvePresented!: (presentation: OAuthExternalPresentation) => void;
    let rejectPresented!: (reason?: unknown) => void;
    let presentedSettled = false;
    const presented = new Promise<OAuthExternalPresentation>((accept, decline) => {
      resolvePresented = accept;
      rejectPresented = decline;
    });
    // The timeout can fire before waitForPresentation attaches. Keep a no-op
    // handler; the real waiter still observes the same rejection.
    void presented.catch(() => undefined);
    const expire = () => {
      if (this.#pending !== pending) return;
      this.#pending = undefined;
      rejectPresented(new OAuthPresentationError('Runtime Host did not present OAuth authorization'));
    };
    let timer = setTimeout(expire, PRESENTATION_TIMEOUT_MS);
    const pending: PendingPresentation = {
      attemptId,
      expectedStateHint,
      resolve: (presentation) => {
        clearTimeout(timer);
        presentedSettled = true;
        if (this.#pending === pending) this.#pending = undefined;
        resolvePresented(presentation);
      },
      reject: (reason) => {
        clearTimeout(timer);
        if (this.#pending === pending) this.#pending = undefined;
        if (!presentedSettled) rejectPresented(reason);
      },
    };
    this.#pending = pending;
    return {
      presented,
      renew: () => {
        if (this.#pending !== pending) return;
        clearTimeout(timer);
        timer = setTimeout(expire, PRESENTATION_TIMEOUT_MS);
      },
      cancel: (reason = new Error('OAuth presentation cancelled')) => {
        if (this.#pending === pending) pending.reject(reason);
      },
    };
  }

  async openExternal(
    url: string,
    stateHint: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const pending = this.#pending;
    if (!pending || !stateHint) {
      throw new OAuthPresentationError('Desktop has no matching OAuth presentation request');
    }
    if (pending.expectedStateHint !== undefined && pending.expectedStateHint !== stateHint) {
      throw new OAuthPresentationError('Desktop OAuth presentation belongs to another attempt');
    }
    let opened = false;
    try {
      await this.openSystemBrowser(url);
      opened = true;
      signal.throwIfAborted();
      pending.resolve({ stateHint });
    } catch (error) {
      // A browser that will not open is a Desktop-owned presentation failure;
      // anything after it opened (an abort) keeps its own shape.
      const failure = opened
        ? error
        : new OAuthPresentationError('Desktop could not open the system browser');
      pending.reject(failure);
      throw failure;
    }
  }

  cancel(attemptId: string, reason: unknown = new Error('OAuth presentation cancelled')): void {
    if (this.#pending?.attemptId === attemptId) this.#pending.reject(reason);
  }
}

interface PendingPresentation {
  readonly attemptId: string;
  readonly expectedStateHint?: string;
  resolve(presentation: OAuthExternalPresentation): void;
  reject(reason?: unknown): void;
}
