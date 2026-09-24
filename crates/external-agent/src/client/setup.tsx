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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientContext, ClientSlots } from '@maka-agent/plugin-sdk/client';
import { copy } from './copy.js';

export type Agent = {
  id: string;
  displayName: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
};
type AuthMethod = { id: string; name: string; description?: string | null; type?: string };
type Initialized = {
  kind: 'initialized';
  agentInfo: { name: string; title?: string | null; version: string } | null;
  authMethods: AuthMethod[];
};
type SetupEvent =
  | Initialized
  | { kind: 'authorization_url'; url: string }
  | { kind: 'authenticated' };
type SetupRequest = { agentId: string; operationId: string } & (
  | { kind: 'check' }
  | { kind: 'authenticate'; methodId: string }
);
type SetupPhase =
  | 'idle'
  | 'checking'
  | 'authenticating'
  | 'cancelling'
  | 'checked'
  | 'authenticated'
  | 'cancelled'
  | 'failed';

export function AgentSetup({
  context,
  agent,
  locale,
  disabled,
}: {
  context: ClientContext;
  agent: Agent;
  locale: ClientSlots['settings.page']['locale'];
  disabled: boolean;
}) {
  const t = copy[locale];
  const stream = useMemo(
    () => context.remote.stream<SetupRequest, SetupEvent>('setup-request'),
    [context],
  );
  const active = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [initialized, setInitialized] = useState<Initialized | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setPhase('idle');
    setInitialized(null);
    setUrl(null);
    setError('');
    const abort = () => active.current?.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    return () => {
      context.signal.removeEventListener('abort', abort);
      abort();
      active.current = null;
    };
  }, [context]);
  async function run(methodId?: string) {
    if (active.current || context.signal.aborted || disabled) return;
    const controller = new AbortController();
    active.current = controller;
    const current = () => active.current === controller && !context.signal.aborted;
    setPhase(methodId === undefined ? 'checking' : 'authenticating');
    setError('');
    setUrl(null);
    if (methodId === undefined) setInitialized(null);
    let result: Initialized | null = null;
    let authenticated = false;
    try {
      const action =
        methodId === undefined
          ? { kind: 'check' as const }
          : { kind: 'authenticate' as const, methodId };
      for await (const event of stream(
        { agentId: agent.id, operationId: crypto.randomUUID(), ...action },
        controller.signal,
      )) {
        if (!current() || controller.signal.aborted) break;
        if (event.kind === 'initialized') result = event;
        else if (event.kind === 'authenticated') authenticated = true;
        else if (event.kind === 'authorization_url') {
          let link: URL;
          try {
            link = new URL(event.url);
          } catch {
            throw new Error(t.invalidAuthUrl);
          }
          if (link.protocol !== 'https:' || link.username || link.password)
            throw new Error(t.invalidAuthUrl);
          setUrl(link.href);
        }
      }
      if (!current()) return;
      if (controller.signal.aborted) setPhase('cancelled');
      else if (methodId === undefined && result) {
        setInitialized(result);
        setPhase('checked');
      } else if (methodId !== undefined && authenticated) setPhase('authenticated');
      else throw new Error(t.incompleteSetup);
    } catch (reason) {
      if (!current()) return;
      setPhase(controller.signal.aborted ? 'cancelled' : 'failed');
      // Preserve cleanup/provider errors, including those reported during cancellation.
      if (!(controller.signal.aborted && reason instanceof Error && reason.name === 'AbortError'))
        setError(String(reason));
    } finally {
      controller.abort();
      if (current()) {
        active.current = null;
        setUrl(null);
      }
    }
  }
  const working = phase === 'checking' || phase === 'authenticating' || phase === 'cancelling';
  return (
    <fieldset>
      <legend>{agent.displayName}</legend>
      <button type="button" disabled={disabled || working} onClick={() => void run()}>
        {t.check}
      </button>
      {phase !== 'idle' && <p role="status">{t[phase]}</p>}
      {error && <p role="alert">{error}</p>}
      {working && (
        <button
          type="button"
          disabled={phase === 'cancelling'}
          onClick={() => {
            setPhase('cancelling');
            active.current?.abort();
          }}
        >
          {t.cancel}
        </button>
      )}
      {url && (phase === 'authenticating' || phase === 'checking') && (
        <p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {t.openAuthorization}
          </a>{' '}
          <span>{new URL(url).host}</span>
        </p>
      )}
      {initialized && (
        <>
          {initialized.agentInfo && (
            <p>
              {initialized.agentInfo.title || initialized.agentInfo.name} ·{' '}
              {initialized.agentInfo.version}
            </p>
          )}
          {!initialized.authMethods.length && <p>{t.noAuthMethods}</p>}
          {initialized.authMethods.map((method) => {
            const supported = method.type === undefined || method.type === 'agent';
            return (
              <div key={method.id}>
                <button
                  type="button"
                  disabled={disabled || working || !supported}
                  onClick={() => void run(method.id)}
                >
                  {t.authenticate}: {method.name}
                </button>
                {method.description && <p>{method.description}</p>}
                {!supported && <p>{t.unsupportedAuth}</p>}
              </div>
            );
          })}
        </>
      )}
    </fieldset>
  );
}
