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
import { Clipboard } from 'nsh/clipboard';
import type {
  SettingsCredentialLogin,
  SettingsCredentialLoginResult,
  SettingsLoginPrompt,
} from '../../../../packages/plugin-sdk/src/index.js';
import { host } from './host';
import { errorText, message, UiError } from './text';
import { settingsRejection, settingsValue, type SettingsOperations } from './settingsOperations';

export type LoginAction = { editor: number; input: SettingsCredentialLogin };
type Saved = Extract<SettingsCredentialLoginResult, { kind: 'saved' }>;
type Original = Awaited<ReturnType<typeof host.beginSetting>>;
type Login = { occurrence: number; prompt: SettingsLoginPrompt | null; cancelling: boolean };
type CopyAction = { occurrence: number; field: 'url' | 'userCode'; value: string };

// The native Mutation owns the original call, receipt and cleanup. This is only
// the progress shown by its one consumer in the existing connection editor.
export function createConnectionLogin(
  operations: SettingsOperations,
  owner: {
    accepts(action: LoginAction): boolean;
    saved(action: LoginAction, result: Saved): Promise<void>;
    discover(action: LoginAction): Promise<void>;
  },
) {
  const state = signal<Login | null>(null);
  let alive = true;
  let occurrence = 0;
  let original: Original | null = null;
  cleanup(() => {
    alive = false;
    original?.cancel();
  });
  const start = async (action: LoginAction) => {
    if (!alive || !owner.accepts(action)) return;
    let saved = false;
    await operations.run(async () => {
      if (!alive || !owner.accepts(action)) return;
      const id = ++occurrence;
      state.set({ occurrence: id, prompt: null, cancelling: false });
      try {
        const mutation = await host.beginSetting(
          'authentication',
          'loginCredential',
          action.input,
          null,
        );
        original = mutation;
        if (!alive || state()?.cancelling) mutation.cancel();
        for (;;) {
          const event = await mutation.next();
          if (!event)
            throw new UiError(
              'Sign-in ended without a final receipt. Recover the original action.',
            );
          if (event.kind === 'not_dispatched') {
            if (alive) operations.notice.set(message('Sign-in cancelled before it started.'));
            return;
          }
          if (event.kind === 'progress') {
            // This exact method's progress and output are validated against
            // settingsAuthentication by the Host before native delivery.
            const prompt = event.value as SettingsLoginPrompt;
            if (alive && state()?.occurrence === id) state.set({ ...state()!, prompt });
            continue;
          }
          const result = settingsValue(event.reply) as SettingsCredentialLoginResult;
          let failure: UiError | null = null;
          if (result.kind === 'saved') {
            // A saved business receipt remains saved if cleanup fails. Retire
            // its old editable basis before reporting that independent error.
            await owner.saved(action, result);
            if (alive)
              operations.notice.set(message('Sign-in saved in the Host credential vault.'));
          } else if (result.kind === 'failed') {
            failure = new UiError(
              result.reason === 'cancelled'
                ? 'Sign-in cancelled.'
                : result.reason === 'expired'
                  ? 'The sign-in code expired. Start a new sign-in to try again.'
                  : 'Sign-in failed. Check the provider and network, then try again.',
            );
          } else failure = settingsRejection(result);
          if (event.cleanupError)
            throw new UiError(
              '{result} Its original request could not finish its resource cleanup.',
              { result: failure ? errorText(failure) : message('Sign-in was saved.') },
            );
          if (failure) throw failure;
          saved = result.kind === 'saved';
          return;
        }
      } finally {
        original = null;
        if (alive && state()?.occurrence === id) state.set(null);
      }
    });
    if (alive && saved) {
      await operations.run(async () => {
        operations.notice.set(message('Sign-in saved in the Host credential vault.'));
        await owner.discover(action);
      });
    }
  };
  const cancel = (id: number) => {
    const current = state();
    if (!alive || current?.occurrence !== id || current.cancelling) return;
    state.set({ ...current, cancelling: true });
    // Request cancellation; keep observing this same original until its real
    // business outcome and cleanup arrive. It may already have been saved.
    original?.cancel();
  };
  const copy = async (action: CopyAction) => {
    const current = state();
    if (
      !alive ||
      current?.occurrence !== action.occurrence ||
      current.prompt?.[action.field] !== action.value
    )
      return;
    try {
      await Clipboard.writeText(action.value);
      if (alive && state()?.occurrence === action.occurrence)
        operations.notice.set(
          action.field === 'url' ? message('Sign-in URL copied.') : message('Sign-in code copied.'),
        );
    } catch (reason) {
      if (alive && state()?.occurrence === action.occurrence) operations.report(reason);
    }
  };
  return { state, start, cancel, copy };
}

export type ConnectionLoginOwner = ReturnType<typeof createConnectionLogin>;
