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

/**
 * Pure value-codec helpers backing the ChatModelSwitcher: group an
 * unsorted list of `ChatModelChoice`s by their connection, and
 * encode/decode the `<connection>:<model>` pair that becomes the
 * Select item value.
 *
 * PR-UI-LIB-EXTRACT-3 (WAWQAQ msg `510fef52`, round 4/10): pulled
 * out of `components.tsx`. `ChatModelChoice` itself was already
 * a public type (consumed by the renderer's main.tsx); the three
 * helpers were panel-internal. byte-for-byte equivalent; behavior
 * unchanged; `index.ts` re-exports the new module so the
 * `@maka/ui` public API surface stays identical.
 *
 * Why this seam: the encode/decode pair is the trust boundary
 * between Select-item string values and structured
 * `{ llmConnectionSlug, model }` records. Living next to ~600
 * lines of ChatModelSwitcher JSX made the codec hard to find and
 * impossible to unit-test in isolation — but it's exactly the
 * kind of pure boundary that benefits from a separate test
 * harness (URI-encoded delimiters, malformed input fall-through).
 */

import type { ChatModelChoice } from '@maka/core/chat-model-choice';

import type { ProviderType, TraeAccount } from '@maka/core/llm-connections';
import { connectionModelChoiceValue } from '@maka/core/llm-connections';

import type { UiLocale } from '@maka/core/ui-locale';
import { getSharedUiCopy } from './shared-ui-copy.js';
export type { ChatModelChoice } from '@maka/core/chat-model-choice';

export function modelChoiceDescription(
  choice: Pick<ChatModelChoice, 'description' | 'knowledgeCutoff'>,
  locale: UiLocale,
): string | undefined {
  const description = choice.description?.trim();
  const knowledge = choice.knowledgeCutoff?.trim();
  const copy = getSharedUiCopy(locale).modelPicker;
  const parts = [description, knowledge ? copy.knowledgeCutoff(knowledge) : undefined].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export interface ModelMenuGroup {
  connectionSlug: string;
  /** Provider of this group, so the menu can render its brand mark on the heading. */
  providerType: ProviderType;
  /**
   * De-duplicated heading. The user's own connection name when one was
   * safely supplied (see `ChatModelChoice.connectionName`); otherwise the
   * short provider label, plus the Trae account variant (`Trae · US`) or,
   * for other providers, the slug when the same provider has multiple
   * connections. Never derived from an OAuth connection's `connection.name`.
   */
  heading: string;
  choices: ChatModelChoice[];
}

/**
 * Group choices by connection and give each group a distinguishable heading.
 * Prefers the user's own connection name (`ChatModelChoice.connectionName`)
 * when the caller supplied one — safe by construction, since callers only
 * populate it for non-OAuth providers. Falls back to the short provider
 * label, with the connection slug appended when two or more connections of
 * the SAME provider are present and neither supplied a name (e.g. two OpenAI
 * keys) — the slug is a safe `[a-z0-9-]` identifier, never the OAuth
 * account email `connection.name` carries for `claude-subscription` /
 * `openai-codex`. Trae accounts are named by their variant instead
 * (`Trae · US`, `Trae · CN SOLO`), and only a repeated variant gets a
 * running number (`Trae · US · 2`), never the slug.
 */
export function modelMenuGroups(choices: ChatModelChoice[], locale: UiLocale): ModelMenuGroup[] {
  const copy = getSharedUiCopy(locale).providers;
  const localizedLabels: Partial<Record<ProviderType, string>> = {
    'MiniMax-cn': copy.minimaxChina,
    'openai-compatible': copy.custom,
    'claude-subscription': copy.claudeSubscription,
  };
  const bySlug = new Map<string, { connectionSlug: string; providerType: ProviderType; providerLabel: string; connectionName?: string; traeAccount?: TraeAccount; choices: ChatModelChoice[] }>();
  for (const choice of choices) {
    const group = bySlug.get(choice.connectionSlug);
    if (group) {
      group.choices.push(choice);
    } else {
      bySlug.set(choice.connectionSlug, {
        connectionSlug: choice.connectionSlug,
        providerType: choice.providerType,
        providerLabel: choice.providerLabel,
        connectionName: choice.connectionName,
        traeAccount: choice.traeAccount,
        choices: [choice],
      });
    }
  }
  const groups = [...bySlug.values()];
  const connectionsPerType = new Map<ProviderType, number>();
  const connectionsPerName = new Map<string, number>();
  const connectionsPerVariant = new Map<string, number>();
  const seenVariant = new Map<string, number>();
  const variantHeading = (group: (typeof groups)[number]): string | undefined => {
    if (group.providerType !== 'trae' || !group.traeAccount) return undefined;
    const label = localizedLabels[group.providerType] ?? group.providerLabel;
    return `${label} · ${traeAccountLabel(group.traeAccount, copy.traeEmployee)}`;
  };
  for (const group of groups) {
    connectionsPerType.set(group.providerType, (connectionsPerType.get(group.providerType) ?? 0) + 1);
    const ownName = group.connectionName?.trim();
    if (ownName) connectionsPerName.set(ownName, (connectionsPerName.get(ownName) ?? 0) + 1);
    const variant = variantHeading(group);
    if (variant) connectionsPerVariant.set(variant, (connectionsPerVariant.get(variant) ?? 0) + 1);
  }
  return groups.map((group) => {
    const variant = variantHeading(group);
    if (variant && !group.connectionName?.trim()) {
      const ordinal = (seenVariant.get(variant) ?? 0) + 1;
      seenVariant.set(variant, ordinal);
      const repeated = (connectionsPerVariant.get(variant) ?? 0) > 1 && ordinal > 1;
      return {
        connectionSlug: group.connectionSlug,
        providerType: group.providerType,
        heading: repeated ? `${variant} · ${ordinal}` : variant,
        choices: group.choices,
      };
    }
    const ownName = group.connectionName?.trim();
    if (ownName) {
      // Two connections can carry the same user-chosen name (the add form
      // defaults it to the provider's display label) — keep them
      // distinguishable with the same slug suffix the label path uses.
      const nameAmbiguous = (connectionsPerName.get(ownName) ?? 0) > 1;
      return {
        connectionSlug: group.connectionSlug,
        providerType: group.providerType,
        heading: nameAmbiguous ? `${ownName} · ${group.connectionSlug}` : ownName,
        choices: group.choices,
      };
    }
    const label = localizedLabels[group.providerType] ?? group.providerLabel;
    const ambiguous = (connectionsPerType.get(group.providerType) ?? 0) > 1;
    return {
      connectionSlug: group.connectionSlug,
      providerType: group.providerType,
      heading: ambiguous ? `${label} · ${group.connectionSlug}` : label,
      choices: group.choices,
    };
  });
}

/** `CN`, `US SOLO`, or the localized employee SSO label. */
export function traeAccountLabel(account: TraeAccount, employeeLabel: string): string {
  if (account === 'employee') return employeeLabel;
  const [region, solo] = account.split('-');
  return `${region!.toUpperCase()}${solo ? ' SOLO' : ''}`;
}

export function modelChoiceValue(connectionSlug: string, model: string): string {
  return `${encodeURIComponent(connectionSlug)}:${encodeURIComponent(model)}`;
}

export function exactModelChoiceValue(
  connectionId: string,
  connectionSlug: string,
  model: string,
): string {
  return connectionModelChoiceValue(connectionId, connectionSlug, model);
}

export function parseModelChoiceValue(value: string): { llmConnectionSlug: string; model: string } | undefined {
  const idx = value.indexOf(':');
  if (idx <= 0) return undefined;
  try {
    const llmConnectionSlug = decodeURIComponent(value.slice(0, idx));
    const model = decodeURIComponent(value.slice(idx + 1));
    if (!llmConnectionSlug || !model) return undefined;
    return { llmConnectionSlug, model };
  } catch {
    return undefined;
  }
}

/** Combine only account-advertised Trae variants; selection retains the exact route. */
export function modelMenuRows(choices: readonly ChatModelChoice[], currentValue?: string) {
  const families = new Map<string, ChatModelChoice[]>();
  for (const choice of choices) {
    const key = choice.providerType === 'trae' && choice.trae
      ? JSON.stringify([choice.connectionId, choice.trae.configName])
      : exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model);
    const family = families.get(key) ?? [];
    family.push(choice);
    families.set(key, family);
  }
  return [...families.entries()].map(([key, variants]) => {
    const standard = variants.find((choice) => choice.trae?.mode === 'standard');
    const max = variants.find((choice) => choice.trae?.mode === 'max');
    const choice = variants.find((item) =>
      exactModelChoiceValue(item.connectionId, item.connectionSlug, item.model) === currentValue,
    ) ?? standard ?? variants[0]!;
    return {
      key,
      choice,
      label: standard && max ? choice.label.replace(/ · (Standard|Max)$/, '') : choice.label,
      ...(standard && max ? { standard, max } : {}),
    };
  });
}
