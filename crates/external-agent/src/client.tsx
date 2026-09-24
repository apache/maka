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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientContext, ClientPlugin, ClientSlots } from '@maka-agent/plugin-sdk/client';
import { copy } from './client/copy.js';

import { AgentSetup, type Agent } from './client/setup.js';
import { Installer } from './client/install.js';

type Snapshot = { revision: number | null; agents: Agent[]; activationError?: string };
type Request =
  | { kind: 'read' }
  | { kind: 'reconcile' }
  | { kind: 'configure'; expectedRevision: number | null; agents: Agent[] };
type Draft = Omit<Agent, 'args' | 'env'> & { key: string; args: string; env: string };
const toDraft = (agent: Agent): Draft => ({
  ...agent,
  key: crypto.randomUUID(),
  args: JSON.stringify(agent.args),
  env: JSON.stringify(agent.env, null, 2),
});
function parse(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

export function SettingsPage({
  context,
  locale,
}: ClientSlots['settings.page'] & { context: ClientContext }) {
  const t = copy[locale];
  const call = useMemo(() => context.remote.method<Request, Snapshot>('request'), [context]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<
    'saved' | 'refreshed' | 'refreshFailed' | 'installedDraft' | null
  >(null);
  const epoch = useRef(0);
  const active = useRef(false);
  const run = useCallback(
    async (request: Request, draftRevision?: number | null) => {
      if (active.current || context.signal.aborted) return;
      active.current = true;
      const generation = ++epoch.current;
      const current = () => generation === epoch.current && !context.signal.aborted;
      const apply = (result: Snapshot) => {
        setSnapshot(result);
        if (request.kind !== 'reconcile' || result.revision !== draftRevision)
          setDraft(result.agents.map(toDraft));
      };
      setBusy(true);
      setError('');
      setStatus(null);
      try {
        const result = await call(request);
        if (!current()) return;
        apply(result);
        if (request.kind === 'configure') setStatus('saved');
        else if (request.kind === 'reconcile' && result.revision !== draftRevision)
          setStatus('refreshed');
      } catch (reason) {
        if (!current()) return;
        setError(String(reason));
        if (request.kind !== 'read') {
          // A failed response may follow a committed compare-and-swap write.
          setSnapshot(null);
          try {
            const result = await call({ kind: 'read' });
            if (!current()) return;
            apply(result);
            setStatus('refreshed');
          } catch {
            if (current()) setStatus('refreshFailed');
          }
        }
      } finally {
        if (current()) {
          active.current = false;
          setBusy(false);
        }
      }
    },
    [call, context.signal],
  );
  useEffect(() => {
    setSnapshot(null);
    setDraft([]);
    void run({ kind: 'read' });
    return () => {
      epoch.current++;
      active.current = false;
    };
  }, [run]);

  function edit(key: string, patch: Partial<Draft>) {
    setStatus(null);
    setDraft((items) => items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }
  function save() {
    if (!snapshot || active.current) return;
    try {
      const agents = draft.map(({ id, displayName, executable, args: rawArgs, env: rawEnv }) => {
        const args = parse(rawArgs, t.invalidArgs);
        if (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))
          throw new Error(t.invalidArgs);
        const env = parse(rawEnv.trim() || '{}', t.invalidEnv);
        if (
          !env ||
          typeof env !== 'object' ||
          Array.isArray(env) ||
          Object.values(env).some((value) => typeof value !== 'string')
        )
          throw new Error(t.invalidEnv);
        return {
          id,
          displayName,
          executable,
          args: args as string[],
          env: env as Record<string, string>,
        };
      });
      void run({ kind: 'configure', expectedRevision: snapshot.revision, agents });
    } catch (reason) {
      setError(String(reason));
      setStatus(null);
    }
  }

  return (
    <section data-maka-external-agent>
      <h2>{t.title}</h2>
      <p>{t.description}</p>
      {error && <p role="alert">{error}</p>}
      {busy ? <p role="status">{t.working}</p> : status && <p role="status">{t[status]}</p>}
      <button type="button" disabled={busy} onClick={() => void run({ kind: 'read' })}>
        {t.refresh}
      </button>
      {snapshot?.activationError && (
        <aside>
          <p role="alert">
            {t.activationError}: {snapshot.activationError}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ kind: 'reconcile' }, snapshot.revision)}
          >
            {t.retryActivation}
          </button>
        </aside>
      )}
      {snapshot && (
        <Installer
          context={context}
          locale={locale}
          disabled={busy}
          existingIds={draft.map((agent) => agent.id)}
          onUse={(agent, replace) => {
            setDraft((items) =>
              !replace && items.some((item) => item.id === agent.id)
                ? items
                : [...items.filter((item) => item.id !== agent.id), toDraft(agent)],
            );
            setStatus('installedDraft');
          }}
        />
      )}
      {snapshot && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset disabled={busy}>
            {!draft.length && <p>{t.empty}</p>}
            {draft.map((agent, index) => (
              <fieldset key={agent.key}>
                <legend>{agent.displayName || `${t.agent} ${index + 1}`}</legend>
                <label>
                  {t.id}
                  <input
                    required
                    maxLength={128}
                    value={agent.id}
                    onChange={(event) => edit(agent.key, { id: event.target.value })}
                  />
                </label>
                <label>
                  {t.displayName}
                  <input
                    required
                    maxLength={256}
                    value={agent.displayName}
                    onChange={(event) => edit(agent.key, { displayName: event.target.value })}
                  />
                </label>
                <label>
                  {t.executable}
                  <input
                    required
                    maxLength={4096}
                    spellCheck={false}
                    value={agent.executable}
                    onChange={(event) => edit(agent.key, { executable: event.target.value })}
                  />
                </label>
                <label>
                  {t.args}
                  <textarea
                    rows={2}
                    maxLength={65536}
                    spellCheck={false}
                    value={agent.args}
                    onChange={(event) => edit(agent.key, { args: event.target.value })}
                  />
                </label>
                <label>
                  {t.env}
                  <textarea
                    rows={3}
                    maxLength={65536}
                    spellCheck={false}
                    value={agent.env}
                    onChange={(event) => edit(agent.key, { env: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setStatus(null);
                    setDraft(draft.filter((item) => item.key !== agent.key));
                  }}
                >
                  {t.remove}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() => {
                setStatus(null);
                setDraft([
                  ...draft,
                  {
                    key: crypto.randomUUID(),
                    id: '',
                    displayName: '',
                    executable: '',
                    args: '[]',
                    env: '{}',
                  },
                ]);
              }}
            >
              {t.add}
            </button>
            <button type="submit">{t.save}</button>
          </fieldset>
        </form>
      )}
      {snapshot && snapshot.agents.length > 0 && (
        <section>
          <h3>{t.setupTitle}</h3>
          <p>{t.setupDescription}</p>
          {snapshot.agents.map((agent) => (
            <AgentSetup
              key={JSON.stringify(agent)}
              context={context}
              agent={agent}
              locale={locale}
              disabled={busy}
            />
          ))}
        </section>
      )}
    </section>
  );
}

const plugin: ClientPlugin = {
  activate(context) {
    context.style(`
      [data-maka-external-agent]{display:grid;gap:12px;max-width:760px;color:inherit;font:inherit}
      [data-maka-external-agent] fieldset{display:grid;gap:12px;border:1px solid #8886;border-radius:8px;padding:14px}
      [data-maka-external-agent] label{display:grid;gap:6px}
      [data-maka-external-agent] input,[data-maka-external-agent] textarea,[data-maka-external-agent] button{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:6px;padding:8px;min-width:0}
      [data-maka-external-agent] textarea{resize:vertical}
      [data-maka-external-agent] :disabled{opacity:.5}
      [data-maka-external-agent] [role=alert]{color:var(--destructive,#c44);white-space:pre-wrap;overflow-wrap:anywhere}
    `);
    context.slots.register(
      'settings.page',
      'external-agent',
      (props) => <SettingsPage {...props} context={context} />,
      {
        label: { en: copy.en.title, 'zh-CN': copy['zh-CN'].title, 'zh-TW': copy['zh-TW'].title },
        order: 37,
      },
    );
  },
};
export default plugin;
