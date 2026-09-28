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

import {
  ClientPluginRuntime,
  MakaClientRoot,
  MakaClientRootOutlet,
} from '@maka/ui/client-plugin-runtime';
import {
  MakaClientPluginSdkModule,
  MakaClientSlotOutlet,
} from '@maka/ui/client-plugin';
import { useEffect, useState, type ReactNode } from 'react';
import * as ReactModule from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { useClientPluginServices } from './services-context.js';

const REFRESH_INTERVAL_MS = 1_000;
const MakaClientPluginRuntimeModule = Object.freeze({
  ClientPluginRuntime,
  MakaClientRoot,
  MakaClientRootOutlet,
});

/** Owns the trusted Renderer plugin graph around Maka's product surface. */
export function ClientPluginRoot(props: { readonly children?: ReactNode }) {
  const services = useClientPluginServices();
  const [root] = useState(() => new MakaClientRoot());

  useEffect(() => {
    const runtime = new ClientPluginRuntime({
      root,
      remote: services.clientPlugins.remote,
      productEvents: services.clientPlugins.productEvents,
      staticModules: Object.freeze({
        react: ReactModule,
        'react/jsx-runtime': ReactJsxRuntime,
        '@maka/ui/client-plugin': MakaClientPluginSdkModule,
        '@maka/ui/client-plugin-runtime': MakaClientPluginRuntimeModule,
      }),
    });
    const detachLoader = runtime.attachLoader();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      try {
        const snapshot = await services.clientPlugins.snapshot();
        if (!stopped) await runtime.reconcile(snapshot);
      } catch {
        // Preserve the last committed graph while its Runtime Host is unavailable.
      } finally {
        if (!stopped) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    };
    void refresh();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      detachLoader();
      void runtime.close();
    };
  }, [root, services]);

  return (
    <MakaClientRootOutlet root={root}>
      {props.children}
      <MakaClientSlotOutlet name="shell.overlay" owner={{}} />
    </MakaClientRootOutlet>
  );
}
