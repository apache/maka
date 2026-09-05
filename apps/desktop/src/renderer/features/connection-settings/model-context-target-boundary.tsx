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

import { useState, type ReactNode } from 'react';
import { modelProfilesWithContextTarget } from '@maka/core/model-thinking';
import { useToast, useUiLocale } from '@maka/ui';
import type { ConnectionSettingsHost } from './ports.js';
import { providerPanelActionErrorMessage } from './provider-panel-shared.js';
import { useConnectionSettingsServices } from './services-context.js';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

export interface ModelContextTargetControl {
  readonly pending: boolean;
  readonly onChange?: (target: number | undefined) => Promise<void>;
}

/** Owns the Host-scoped connection write used by the Composer context selector. */
export function ModelContextTargetBoundary(props: {
  readonly host?: ConnectionSettingsHost;
  readonly connection?: { readonly connectionId: string; readonly slug: string };
  readonly modelId?: string;
  readonly children: (control: ModelContextTargetControl) => ReactNode;
}) {
  const services = useConnectionSettingsServices();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale);
  const [pending, setPending] = useState(false);
  const ready = Boolean(props.host && props.connection && props.modelId);

  async function change(target: number | undefined): Promise<void> {
    const host = props.host;
    const identity = props.connection;
    const modelId = props.modelId;
    if (!host || !identity || !modelId || pending) return;

    setPending(true);
    try {
      const connections = services.forHost(host).connections;
      const snapshot = await connections.getSnapshot();
      const current = snapshot.connections.find(
        (connection) =>
          connection.connectionId === identity.connectionId && connection.slug === identity.slug,
      );
      if (!current) throw new Error(copy.shared.actionFallback);
      await connections.update(identity, {
        relayModelProfiles: modelProfilesWithContextTarget(
          current.relayModelProfiles,
          modelId,
          target,
        ),
      });
    } catch (error) {
      toast.error(
        copy.detail.saveFailed,
        providerPanelActionErrorMessage(error, locale),
        undefined,
        { profileId: host.profileId },
      );
    } finally {
      setPending(false);
    }
  }

  return props.children({
    pending,
    ...(ready ? { onChange: change } : {}),
  });
}
