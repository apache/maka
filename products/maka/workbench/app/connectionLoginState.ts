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

import { cleanup, signal, Clipboard, openUrl } from 'nsh';
import type {
  SettingsCredentialLogin,
  SettingsCredentialLoginResult,
  SettingsLoginPrompt,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { errorText, message, UiError } from './text';
import { settingsRejection, settingsValue, type SettingsOperations } from './settingsOperations';

export type LoginAction = { editor: number; input: SettingsCredentialLogin };
type Saved = Extract<SettingsCredentialLoginResult, { kind: 'saved' }>;
type Original = Awaited<ReturnType<Host['beginSetting']>>;
type Authorization = {
  kind: 'authorizing';
  occurrence: number;
  prompt: SettingsLoginPrompt | null;
  cancelling: boolean;
  browser: 'idle' | 'opening' | 'opened' | 'failed';
};
type Login = Authorization | { kind: 'models'; occurrence: number };
type PromptAction = { occurrence: number; url: string };
type CopyAction = { occurrence: number; field: 'url' | 'userCode'; value: string };

export function createConnectionLogin(
  host: Host,
  operations: SettingsOperations,
  owner: {
    accepts(action: LoginAction): boolean;
    saved(action: LoginAction, result: Saved): Promise<void>;
    discover(action: LoginAction): Promise<void>;
  },
) {
  const state = signal<Login | null>(null);
  const copied = signal<CopyAction['field'] | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let occurrence = 0;
  let original: Original | null = null;
  cleanup(() => {
    alive = false;
    clearTimeout(copyTimer);
    original?.cancel();
  });
  const authorization = () => {
    const current = state();
    return current?.kind === 'authorizing' ? current : null;
  };
  const open = async (action: PromptAction) => {
    const current = authorization();
    if (
      !alive ||
      current?.occurrence !== action.occurrence ||
      current.cancelling ||
      current.prompt?.url !== action.url ||
      current.browser === 'opening'
    )
      return;
    state.set({ ...current, browser: 'opening' });
    let opened = false;
    try {
      opened = (await openUrl(action.url)).opened;
    } catch {
      // The same sign-in can still finish after the user opens the copied URL.
    }
    const latest = authorization();
    if (alive && latest?.occurrence === action.occurrence)
      state.set({ ...latest, browser: opened ? 'opened' : 'failed' });
  };
  const start = async (action: LoginAction) => {
    if (!alive || !owner.accepts(action)) return;
    await operations.run(async () => {
      if (!alive || !owner.accepts(action)) return;
      const id = ++occurrence;
      copied.set(null);
      state.set({
        kind: 'authorizing',
        occurrence: id,
        prompt: null,
        cancelling: false,
        browser: 'idle',
      });
      try {
        const mutation = await host.beginSetting(
          'authentication',
          'loginCredential',
          action.input,
          null,
        );
        original = mutation;
        if (!alive || authorization()?.cancelling) mutation.cancel();
        let saved = false;
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
            const prompt = event.value as SettingsLoginPrompt;
            const current = authorization();
            if (alive && current?.occurrence === id) {
              const first = current.prompt === null;
              state.set({ ...current, prompt });
              if (first) void open({ occurrence: id, url: prompt.url });
            }
            continue;
          }
          const result = settingsValue(event.reply) as SettingsCredentialLoginResult;
          let failure: UiError | null = null;
          if (result.kind === 'saved') {
            await owner.saved(action, result);
            if (alive) {
              operations.error.set('');
            }
            saved = true;
          } else if (result.kind === 'failed') {
            if (result.reason === 'cancelled') {
              if (alive) operations.notice.set(message('Sign-in cancelled.'));
            } else {
              failure = new UiError(
                result.reason === 'expired'
                  ? 'The sign-in code expired. Start a new sign-in to try again.'
                  : 'Sign-in failed. Check the provider and network, then try again.',
              );
            }
          } else failure = settingsRejection(result);
          if (event.cleanupError)
            throw new UiError(
              '{result} Its original request could not finish its resource cleanup.',
              {
                result: failure
                  ? errorText(failure)
                  : message(saved ? 'Sign-in was saved.' : 'Sign-in cancelled.'),
              },
            );
          if (failure) throw failure;
          break;
        }
        original = null;
        if (alive && saved) {
          state.set({ kind: 'models', occurrence: id });
          try {
            await owner.discover(action);
          } catch (reason) {
            throw new UiError('Signed in, but models could not be loaded. {reason}', {
              reason: errorText(reason),
            });
          }
        }
      } finally {
        original = null;
        if (alive && state()?.occurrence === id) state.set(null);
      }
    });
  };
  const cancel = (id: number) => {
    const current = authorization();
    if (!alive || current?.occurrence !== id || current.cancelling) return;
    state.set({ ...current, cancelling: true });
    original?.cancel();
  };
  const copy = async (action: CopyAction) => {
    const current = authorization();
    if (
      !alive ||
      current?.occurrence !== action.occurrence ||
      current.prompt?.[action.field] !== action.value
    )
      return;
    try {
      await Clipboard.writeText(action.value);
      if (alive && authorization()?.occurrence === action.occurrence) {
        clearTimeout(copyTimer);
        copied.set(action.field);
        copyTimer = setTimeout(() => copied.set(null), 4000);
      }
    } catch (reason) {
      if (alive && authorization()?.occurrence === action.occurrence) operations.report(reason);
    }
  };
  return { state, authorization, copied, start, cancel, copy, open };
}

export type ConnectionLoginOwner = ReturnType<typeof createConnectionLogin>;
