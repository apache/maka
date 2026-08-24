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
  cancel(reason?: unknown): void;
}

/** Bridges a Host-owned OAuth attempt to Desktop-owned system-browser presentation. */
export class RuntimeHostOAuthPresentation implements OAuthPresentationBackend {
  #pending: PendingPresentation | undefined;

  constructor(private readonly openSystemBrowser: (url: string) => Promise<void>) {}

  expect(attemptId: string): OAuthPresentationExpectation {
    this.#pending?.reject(new Error('Another OAuth presentation replaced this attempt'));
    let resolvePresented!: (presentation: OAuthExternalPresentation) => void;
    let rejectPresented!: (reason?: unknown) => void;
    let presentedSettled = false;
    const presented = new Promise<OAuthExternalPresentation>((accept, decline) => {
      resolvePresented = accept;
      rejectPresented = decline;
    });
    // If a later expect() supersedes this one before waitForPresentation
    // attaches, Node would log UnhandledPromiseRejection. Keep a no-op
    // handler; real waiters still observe the same rejection.
    void presented.catch(() => undefined);
    const timer = setTimeout(() => {
      if (this.#pending?.attemptId !== attemptId) return;
      this.#pending = undefined;
      rejectPresented(new Error('Runtime Host did not present OAuth authorization'));
    }, PRESENTATION_TIMEOUT_MS);
    const pending: PendingPresentation = {
      attemptId,
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
      throw new Error('Desktop has no matching OAuth presentation request');
    }
    try {
      await this.openSystemBrowser(url);
      signal.throwIfAborted();
      pending.resolve({ stateHint });
    } catch (error) {
      pending.reject(error);
      throw error;
    }
  }

  cancel(attemptId: string, reason: unknown = new Error('OAuth presentation cancelled')): void {
    if (this.#pending?.attemptId === attemptId) this.#pending.reject(reason);
  }
}

interface PendingPresentation {
  readonly attemptId: string;
  resolve(presentation: OAuthExternalPresentation): void;
  reject(reason?: unknown): void;
}
