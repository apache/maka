import type { ModelCatalogEntry } from '@maka/core';
import {
  CheckboxList,
  CheckboxListItem,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Adapts Maka's model catalog data to Astryx's canonical checkbox field.
 * `enabledModelIds` remains the only product state; Astryx owns labels,
 * checkbox semantics, disabled state, and focus.
 */
export function EnabledModelManager(props: {
  modelChoices: ModelCatalogEntry[];
  enabledModelIds: string[];
  defaultModel: string;
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const rows = (() => {
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
  })();

  return (
    <CheckboxList
      label={copy.enabledModelsTitle(props.enabledModelIds.length)}
      description={copy.enabledModelsHelp}
      value={props.enabledModelIds}
      onChange={props.onChange}
      isDisabled={props.disabled}
      width="100%"
      density="compact"
    >
      {rows.map((row) => (
        <CheckboxListItem
          key={row.id}
          value={row.id}
          label={
            row.id === props.defaultModel
              ? `${row.label} · ${copy.defaultModel}`
              : row.label
          }
          isDisabled={row.id === props.defaultModel}
        />
      ))}
    </CheckboxList>
  );
}

function modelDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}
