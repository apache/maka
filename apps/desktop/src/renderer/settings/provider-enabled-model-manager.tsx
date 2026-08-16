import { MultiSelector } from '@astryxdesign/core';
import type { ModelCatalogEntry } from '@maka/core/model-catalog';
import { useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Adapts Maka's model catalog to Astryx's multi-select field.
 *
 * A CheckboxList was the wrong shape here: Astryx scopes it to 3–7 options and
 * says to use MultiSelector past that, and a provider like OpenAI lists dozens —
 * the settings page turned into a wall of checkboxes taller than everything else
 * on it combined. MultiSelector keeps the same one-line field weight as the
 * selectors around it, and brings the search that a list that long needs.
 *
 * `enabledModelIds` remains the only product state.
 */
export function EnabledModelManager(props: {
  modelChoices: ModelCatalogEntry[];
  enabledModelIds: string[];
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const options = (() => {
    const byId = new Map(props.modelChoices.map((model) => [model.id, model] as const));
    const seen = new Set<string>();
    const list: Array<{ value: string; label: string; disabled?: boolean }> = [];
    const push = (id: string, label: string) => {
      seen.add(id);
      list.push({ value: id, label });
    };
    for (const model of props.modelChoices) {
      if (!model.canUseAsChatDefault) continue;
      push(model.id, modelDisplayLabel(model));
    }
    // Always surface an already-enabled model even if it is not a current
    // chat-default candidate (a stale id, or a model dropped from the latest
    // catalog), so the user can still toggle it off.
    for (const id of props.enabledModelIds) {
      if (seen.has(id)) continue;
      const model = byId.get(id);
      push(id, model ? modelDisplayLabel(model) : id);
    }
    return list;
  })();

  return (
    <MultiSelector
      label={copy.enabledModels}
      // The section is already headed 模型 and says what the list is for; a
      // visible field label repeated it in a third type style. Kept as the
      // accessible name so the trigger still announces what it selects.
      isLabelHidden
      options={options}
      value={props.enabledModelIds}
      onChange={props.onChange}
      isDisabled={props.disabled || options.length === 0}
      disabledMessage={options.length === 0 ? copy.noModels : undefined}
      placeholder={copy.noModels}
      // Names, not "N selected": Astryx hard-codes the English word into the
      // count display, and the labels answer "which ones" in the same width.
      triggerDisplay="labels"
      hasSearch
      searchPlaceholder={copy.searchModels}
      hasSelectAll
      selectAllLabel={copy.selectAllModels}
      width="100%"
    />
  );
}

function modelDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}
