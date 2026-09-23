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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDefaultMcpConfig,
  type McpConfigAddResult,
  type McpConfigFile,
  type McpServerConfig,
  type McpServerStatus,
} from '@maka/core/mcp';
import { useMountedRef } from '@maka/ui';
import { useModuleHubServices } from '../services-context.js';
import type { ModuleHubRuntimeHostRef } from '../ports.js';
import { isDefaultRuntimeHostCurrent, runOnDefaultRuntimeHost } from './default-runtime-host.js';

export function useMcpController() {
  const { mcp, runtimeHosts } = useModuleHubServices();
  const mounted = useMountedRef();
  const [config, setConfig] = useState<McpConfigFile>(createDefaultMcpConfig);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<unknown>(null);
  const operation = useRef<{ key: string; host?: ModuleHubRuntimeHostRef; cancelled?: boolean } | null>(null);
  const revision = useRef(0);

  const reload = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await runOnDefaultRuntimeHost(runtimeHosts, (host) =>
        Promise.all([mcp.getConfig(host), mcp.listStatuses(host)]),
      );
      if (
        !await isDefaultRuntimeHostCurrent(runtimeHosts, result.host) ||
        !mounted.current || request !== revision.current
      ) return;
      setConfig(result.value[0]);
      setStatuses(result.value[1]);
    } catch (failure) {
      if (mounted.current && request === revision.current) setError(failure);
    } finally {
      if (mounted.current && request === revision.current && !operation.current) setBusy(null);
    }
  }, [mcp, runtimeHosts, mounted]);

  useEffect(() => {
    void reload();
    const unsubscribe = mcp.subscribeChanges(() => void reload());
    const unsubscribeHosts = runtimeHosts.subscribeChanges(() => {
      setConfig(createDefaultMcpConfig());
      setStatuses([]);
      void reload();
    });
    return () => {
      ++revision.current;
      unsubscribe();
      unsubscribeHosts();
    };
  }, [mcp, runtimeHosts, reload]);

  async function run<T>(key: string, action: (host: ModuleHubRuntimeHostRef) => Promise<T>): Promise<T | undefined> {
    if (operation.current) return undefined;
    const current: { key: string; host?: ModuleHubRuntimeHostRef; cancelled?: boolean } = { key };
    operation.current = current;
    setBusy(key);
    setError(null);
    try {
      const result = await runOnDefaultRuntimeHost(runtimeHosts, (host) => {
        current.host = host;
        return action(host);
      });
      if (mounted.current && await isDefaultRuntimeHostCurrent(runtimeHosts, result.host)) return result.value;
    } catch (failure) {
      if (mounted.current && !current.cancelled) setError(failure);
    } finally {
      // Held until the refreshed config lands, so nothing acts on the old one.
      if (mounted.current) await reload();
      operation.current = null;
      if (mounted.current) setBusy(null);
    }
    return undefined;
  }

  return {
    config,
    statuses,
    busy,
    error,
    reload,
    save: (id: string, config: McpServerConfig, creating: boolean) =>
      run<McpConfigAddResult>('save', async (host) => creating
        ? mcp.add(id, config, host)
        : { status: 'added', config: await mcp.upsert(id, config, host) },
      ),
    importConfig: (source: string) => run('import', (host) => mcp.importConfig(source, host)),
    setEnabled: (id: string, config: McpServerConfig, enabled: boolean) =>
      run(`toggle:${id}`, (host) => mcp.upsert(id, { ...config, enabled }, host)),
    remove: (id: string) => run(`remove:${id}`, (host) => mcp.remove(id, host)),
    test: (id: string) => run(`test:${id}`, (host) => mcp.test(id, host)),
    login: (id: string) => run(`login:${id}`, (host) => mcp.login(id, host)),
    logout: (id: string) => run(`logout:${id}`, (host) => mcp.logout(id, host)),
    async cancelLogin(id: string) {
      const current = operation.current;
      if (!current) {
        await run(`cancel:${id}`, (host) => mcp.cancelLogin(id, host));
        return;
      }
      if (current.key !== `login:${id}` || !current.host) return;
      current.cancelled = true;
      try {
        await mcp.cancelLogin(id, current.host);
      } catch (failure) {
        current.cancelled = false;
        if (mounted.current) setError(failure);
      }
    },
  };
}
