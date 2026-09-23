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
  type McpConfigUpdateResult,
  type McpServerConfig,
  type McpServerStatus,
} from '@maka/core/mcp';
import { useMountedRef } from '@maka/ui';
import type { OpencliChromeStatus } from '../../../../shared/opencli-chrome.js';
import { useModuleHubServices } from '../services-context.js';
import type { ModuleHubRuntimeHostRef } from '../ports.js';
import { isDefaultRuntimeHostCurrent, runOnDefaultRuntimeHost } from './default-runtime-host.js';

const CHROME_POLL_MS = 2000;

export function isChromeServer(server: McpServerConfig, chrome: OpencliChromeStatus | null): boolean {
  return chrome !== null && 'command' in server && server.command === chrome.command;
}

export function useMcpController() {
  const { mcp, runtimeHosts } = useModuleHubServices();
  const mounted = useMountedRef();
  const [config, setConfig] = useState<McpConfigFile>(createDefaultMcpConfig);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [chrome, setChrome] = useState<OpencliChromeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<unknown>(null);
  const operation = useRef<{ key: string; host?: ModuleHubRuntimeHostRef; cancelled?: boolean } | null>(null);
  const revision = useRef(0);

  const reload = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await runOnDefaultRuntimeHost(runtimeHosts, (host) =>
        Promise.all([mcp.getConfig(host), mcp.listStatuses(host), mcp.chromeStatus(host)]),
      );
      if (
        !await isDefaultRuntimeHostCurrent(runtimeHosts, result.host) ||
        !mounted.current || request !== revision.current
      ) return;
      setConfig(result.value[0]);
      setStatuses(result.value[1]);
      setChrome(result.value[2]);
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

  // Chrome gives no signal when the extension connects, so a configured but
  // unconnected Chrome server is polled while this page is open.
  const awaitingChrome = chrome !== null && !chrome.connected &&
    Object.values(config.mcpServers).some((server) => isChromeServer(server, chrome));
  useEffect(() => {
    if (!awaitingChrome) return;
    const timer = setInterval(() => {
      void runOnDefaultRuntimeHost(runtimeHosts, (host) => mcp.chromeStatus(host)).then(
        (result) => { if (mounted.current) setChrome(result.value); },
        () => undefined,
      );
    }, CHROME_POLL_MS);
    return () => clearInterval(timer);
  }, [awaitingChrome, mcp, runtimeHosts, mounted]);

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
    chrome,
    busy,
    error,
    reload,
    add: (id: string, config: McpServerConfig) =>
      run<McpConfigAddResult>('save', (host) => mcp.add(id, config, host)),
    update: (id: string, config: McpServerConfig, basis: McpServerConfig) =>
      run<McpConfigUpdateResult>('save', (host) => mcp.update(id, config, basis, host)),
    importConfig: (source: string) => run('import', (host) => mcp.importConfig(source, host)),
    setEnabled: (id: string, enabled: boolean) =>
      run<McpConfigUpdateResult>(`toggle:${id}`, (host) => mcp.setEnabled(id, enabled, host)),
    remove: (id: string) => run(`remove:${id}`, (host) => mcp.remove(id, host)),
    test: (id: string) => run(`test:${id}`, (host) => mcp.test(id, host)),
    login: (id: string) => run(`login:${id}`, (host) => mcp.login(id, host)),
    logout: (id: string) => run(`logout:${id}`, (host) => mcp.logout(id, host)),
    connectChrome: () => run('chrome', (host) => mcp.connectChrome(host)),
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
