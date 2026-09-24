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
import type { ClientContext, ClientLocale } from '@maka-agent/plugin-sdk/client';
import { copy } from './copy.js';
import type { Agent } from './setup.js';

type Request = { kind: 'install_antigravity'; operationId: string };
type Event = { kind: 'installed'; agent: Agent };
export function Installer({
  context,
  locale,
  disabled,
  existingIds,
  onUse,
}: {
  context: ClientContext;
  locale: ClientLocale;
  disabled: boolean;
  existingIds: string[];
  onUse: (agent: Agent, replace: boolean) => void;
}) {
  const t = copy[locale];
  const stream = useMemo(() => context.remote.stream<Request, Event>('setup-request'), [context]);
  const active = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'installing' | 'cancelling' | 'cancelled' | 'failed' | 'installed'
  >('idle');
  const [installed, setInstalled] = useState<Agent | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setPhase('idle');
    setInstalled(null);
    setError('');
    const abort = () => active.current?.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    return () => {
      context.signal.removeEventListener('abort', abort);
      abort();
      active.current = null;
    };
  }, [context]);
  async function install() {
    if (active.current || disabled || context.signal.aborted) return;
    const controller = new AbortController();
    active.current = controller;
    const current = () => active.current === controller && !context.signal.aborted;
    setPhase('installing');
    setInstalled(null);
    setError('');
    let result: Agent | null = null;
    try {
      for await (const event of stream(
        { kind: 'install_antigravity', operationId: crypto.randomUUID() },
        controller.signal,
      )) {
        if (!current() || controller.signal.aborted) break;
        if (event.kind === 'installed') result = event.agent;
      }
      if (!current()) return;
      if (controller.signal.aborted) setPhase('cancelled');
      else if (result) {
        setInstalled(result);
        setPhase('installed');
      } else throw new Error(t.incompleteInstall);
    } catch (reason) {
      if (!current()) return;
      setPhase(controller.signal.aborted ? 'cancelled' : 'failed');
      if (!(controller.signal.aborted && reason instanceof Error && reason.name === 'AbortError'))
        setError(String(reason));
    } finally {
      controller.abort();
      if (current()) active.current = null;
    }
  }
  const working = phase === 'installing' || phase === 'cancelling';
  const replace = installed !== null && existingIds.includes(installed.id);
  return (
    <fieldset>
      <legend>{t.installTitle}</legend>
      <p>{t.installDescription}</p>
      <button type="button" disabled={disabled || working} onClick={() => void install()}>
        {t.installAntigravity}
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
      {installed && (
        <>
          <p>
            {installed.displayName} ({installed.id})
          </p>
          <p>
            {t.executable}: <code>{installed.executable}</code>
          </p>
          {replace && <p>{t.replaceInstalledDescription}</p>}
          <button type="button" disabled={disabled} onClick={() => onUse(installed, replace)}>
            {replace ? t.replaceInstalled : t.addInstalled}
          </button>
        </>
      )}
    </fieldset>
  );
}
