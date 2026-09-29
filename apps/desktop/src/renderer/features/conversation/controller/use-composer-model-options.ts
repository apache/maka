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

import { useCallback, useRef } from 'react';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import {
  modelOverride,
  modelOverrideForServiceTier,
  normalizeModelOverrides,
  type ModelOverride,
} from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopRuntimeHostRef } from '../../../../preload/bridge-contract.js';
import { getProviderSettingsCopy } from '../../connection-settings/settings-provider-copy.js';

export interface ComposerModelOptionTarget {
  connectionId: string;
  slug: string;
  model: string;
}

/**
 * Writes the composer's Fast toggle onto the connection's model override — the
 * value the runtime already reads for the next request. Picks are serialized so
 * the second save's expected override is the first save's result.
 */
export function useComposerModelOptions(options: {
  uiLocale: UiLocale;
  connections: readonly ProjectedLlmConnection[];
  model: ComposerModelOptionTarget | undefined;
  host: DesktopRuntimeHostRef | undefined;
  refresh(): Promise<void>;
  reportError(message: string): void;
}): {
  onFastChange(enabled: boolean): Promise<void>;
} {
  const latest = useRef(options);
  latest.current = options;
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  const rememberedRef = useRef<{ key: string; override: ModelOverride | null } | null>(null);

  const onFastChange = useCallback((enabled: boolean) => {
    // Everything this write targets is fixed at click time: a queued write must
    // not follow the composer to another Session's Host or connection list.
    const { model, host, uiLocale, refresh, reportError } = latest.current;
    if (!model) return Promise.resolve();
    const connection = latest.current.connections.find(
      (candidate) => candidate.connectionId === model.connectionId && candidate.slug === model.slug,
    );
    const key = [host?.profileId ?? '', host?.hostId ?? '', model.connectionId, model.model].join('\u0000');
    const task = tailRef.current.then(async () => {
      if (!connection) throw new Error(`Connection is no longer available: ${model.slug}`);
      const stored = modelOverride(connection, model.model) ?? null;
      const remembered = rememberedRef.current?.key === key ? rememberedRef.current.override : undefined;
      const expected = remembered !== undefined && JSON.stringify(stored) !== JSON.stringify(remembered)
        ? remembered
        : stored;
      const value = modelOverrideForServiceTier(expected ?? undefined, enabled);
      const normalized = (entry: ModelOverride | null | undefined) =>
        JSON.stringify(normalizeModelOverrides({ model: entry ?? {} })?.model ?? {});
      if (normalized(value) === normalized(expected)) return;
      const saved = await window.maka.connections.update(
        { connectionId: model.connectionId, slug: model.slug },
        { modelOverride: { modelId: model.model, expected, value } },
        host,
      );
      rememberedRef.current = { key, override: saved.modelOverrides?.[model.model] ?? null };
      await refresh();
    });
    tailRef.current = task.then(() => undefined, () => undefined);
    return task.catch((error: unknown) => {
      reportError(getProviderSettingsCopy(uiLocale).detail.saveFailed);
      throw error;
    });
  }, []);

  return { onFastChange };
}
