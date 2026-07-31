import { useMemo } from 'react';
import type { ModelCatalogEntry } from '@maka/core';
import { MultiSelector, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Adapts Maka's model catalog data to Astryx's canonical multi-select field.
 * `enabledModelIds` remains the only product state; Astryx owns search,
 * checkbox semantics, keyboard navigation, focus, and popup layout.
 */
export function EnabledModelManager(props: {
  modelChoices: ModelCatalogEntry[];
  enabledModelIds: string[];
  defaultModel: string;
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const rows = useMemo(() => {
    const byId = new Map(props.modelChoices.map((model) => [model.id, model] as const));
    const seen = new Set<string>();
    const list: Array<{ id: string; label: string }> = [];
    for (const model of props.modelChoices) {
      if (!model.canUseAsChatDefault) continue;
      seen.add(model.id);
      list.push({ id: model.id, label: modelDisplayLabel(model) });
    }
    // Always surface an already-enabled model even if it is not a current
    // chat-default candidate (a stale id, or a model dropped from the latest
    // catalog), so the user can still toggle it off.
    for (const id of props.enabledModelIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const model = byId.get(id);
      list.push({ id, label: model ? modelDisplayLabel(model) : id });
    }
    return list;
  }, [props.modelChoices, props.enabledModelIds]);
  const options = useMemo(
    () =>
      rows.map((row) => ({
        value: row.id,
        label: row.id === props.defaultModel ? `${row.label} · ${copy.defaultModel}` : row.label,
        disabled: row.id === props.defaultModel,
      })),
    [copy.defaultModel, props.defaultModel, rows],
  );

  return (
    <MultiSelector
      label={copy.enabledModelsTitle(props.enabledModelIds.length)}
      description={copy.enabledModelsHelp}
      options={options}
      value={props.enabledModelIds}
      onChange={props.onChange}
      hasSearch
      searchPlaceholder={copy.searchModels}
      triggerDisplay="labels"
      isDisabled={props.disabled}
      width="100%"
    />
  );
}

function modelDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}
