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

import { useCallback, useEffect, useRef } from 'react';
import { useToast } from '@maka/ui';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import {
  modelOverride,
  modelOverrideForServiceTier,
  normalizeModelOverrides,
  type ModelOverride,
} from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import type { ConversationRuntimeHost } from '../ports.js';
import { useConversationServices } from '../services.js';

export interface ComposerModelOptionTarget {
  connectionId: string;
  slug: string;
  model: string;
}

const normalizedOverride = (entry: ModelOverride | null | undefined) =>
  JSON.stringify(normalizeModelOverrides({ model: entry ?? {} })?.model ?? {});

const writeKey = (host: ConversationRuntimeHost, model: ComposerModelOptionTarget) =>
  [host.profileId, host.hostId, model.connectionId, model.model].join('\u0000');

/** The override the connection list shows for `key`, or `undefined` when the list is for another target. */
function shownOverride(
  options: {
    connections: readonly ProjectedLlmConnection[];
    model: ComposerModelOptionTarget | undefined;
    host: ConversationRuntimeHost | undefined;
  },
  key: string,
): ModelOverride | null | undefined {
  const { model, host } = options;
  if (!model || !host || writeKey(host, model) !== key) return undefined;
  const connection = options.connections.find(
    (candidate) => candidate.connectionId === model.connectionId && candidate.slug === model.slug,
  );
  return connection ? (modelOverride(connection, model.model) ?? null) : undefined;
}

/**
 * Writes the composer's Fast toggle onto the connection's model override — the
 * value the runtime already reads for the next request. Picks are serialized.
 * A pick made before the previous save's refresh reached the connection list
 * still sees that save's `before`; only then is its `after` the expected value.
 * Once the list has shown `after`, the refresh has landed and that memory is
 * dropped: from then on the list is authoritative, including an edit made
 * elsewhere that restores `before`.
 */
export function useComposerModelOptions(options: {
  uiLocale: UiLocale;
  connections: readonly ProjectedLlmConnection[];
  model: ComposerModelOptionTarget | undefined;
  host: ConversationRuntimeHost | undefined;
}): {
  onFastChange?(enabled: boolean): Promise<void>;
} {
  const services = useConversationServices();
  const toast = useToast();
  const latest = useRef({ ...options, services, toast });
  latest.current = { ...options, services, toast };
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  const rememberedRef = useRef<{
    key: string;
    before: ModelOverride | null;
    after: ModelOverride | null;
  } | null>(null);
  const forgetIfShown = useCallback(() => {
    const remembered = rememberedRef.current;
    if (!remembered) return;
    const shown = shownOverride(latest.current, remembered.key);
    if (shown !== undefined && normalizedOverride(shown) === normalizedOverride(remembered.after)) {
      rememberedRef.current = null;
    }
  }, []);
  useEffect(forgetIfShown, [options.connections, forgetIfShown]);

  const onFastChange = useCallback((enabled: boolean) => {
    // Everything this write targets is fixed at click time: a queued write must
    // not follow the composer to another Session's Host or connection list.
    const { model, host, uiLocale, services, toast } = latest.current;
    const update = services.connections?.updateModelOverride;
    if (!model || !host || !update) return Promise.resolve();
    const connection = latest.current.connections.find(
      (candidate) => candidate.connectionId === model.connectionId && candidate.slug === model.slug,
    );
    const key = writeKey(host, model);
    const task = tailRef.current.then(async () => {
      if (!connection) throw new Error(`Connection is no longer available: ${model.slug}`);
      // The live list is fresher than the click-time snapshot, but only while it
      // still describes the same Host, connection and model.
      const stored = shownOverride(latest.current, key) ?? modelOverride(connection, model.model) ?? null;
      const remembered = rememberedRef.current?.key === key ? rememberedRef.current : undefined;
      const expected = remembered && normalizedOverride(stored) === normalizedOverride(remembered.before)
        ? remembered.after
        : stored;
      const value = modelOverrideForServiceTier(expected ?? undefined, enabled);
      if (normalizedOverride(value) === normalizedOverride(expected)) return;
      const saved = await update({
        host,
        connection: { connectionId: model.connectionId, slug: model.slug },
        modelId: model.model,
        expected,
        value,
      });
      rememberedRef.current = { key, before: expected, after: saved };
      // The refresh may have landed before the save resolved.
      forgetIfShown();
    });
    tailRef.current = task.then(() => undefined, () => undefined);
    return task.catch((error: unknown) => {
      rememberedRef.current = null;
      toast.error(
        getDesktopConversationCopy(uiLocale).actions.modelOptionSaveFailedTitle,
        error instanceof Error ? error.message : undefined,
      );
      throw error;
    });
  }, [forgetIfShown]);

  // Without a known Host the write could land on a Host whose connections the
  // menu is not showing, so Fast is not offered at all.
  return services.connections && options.host && options.model ? { onFastChange } : {};
}
