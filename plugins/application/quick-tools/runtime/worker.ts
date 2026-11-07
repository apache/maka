/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { host } from 'nsh';
import { randomUUID } from 'crypto';
import { quickLocale } from '../shared/i18n';
import { parseRows, parseView } from './schema';
import type { Bundle } from './packages';
import type { Plugin } from '../shared/plugin';
export async function loadWorker(
  bundle: Bundle,
  changed: () => void,
  active: (token: string | null) => void,
): Promise<Plugin> {
  const token = (await host.call('quickTools.plugin.load', {
    code: bundle.code,
    manifest: bundle.manifest,
  })) as string;
  active(token);
  const invoke = async (method: string, args: unknown[] = [], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const id = randomUUID();
    const cancel = () => {
      void host.call('quickTools.plugin.cancel', { token, id }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const reply = (await host.call('quickTools.plugin.invoke', {
        token,
        request: {
          id,
          method,
          args,
          locale: quickLocale(),
          ...(method === 'start' ? { code: bundle.code } : {}),
        },
      })) as { value: any; changed: boolean };
      signal?.throwIfAborted();
      if (reply.changed) changed();
      return reply.value;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  try {
    await invoke('start');
  } catch (error) {
    active(null);
    await host.call('quickTools.plugin.unload', { token });
    throw error;
  }
  return {
    search: async (query, signal) => parseRows(await invoke('search', [query], signal)),
    view: async (id, query, signal) => parseView(await invoke('view', [id, query], signal)),
    resolve: async (id) => {
      const row = await invoke('resolve', [id]);
      return row ? parseRows([row])[0] : undefined;
    },
    run: (id, data, values, signal) => invoke('run', [id, data ?? null, values], signal),
    event: (name, data) => invoke('event', [name, data ?? null]),
    suggest: (input, signal) => invoke('suggest', [input], signal),
    dispose: async () => {
      try {
        await invoke('dispose');
      } finally {
        active(null);
        await host.call('quickTools.plugin.unload', { token });
      }
    },
  };
}
