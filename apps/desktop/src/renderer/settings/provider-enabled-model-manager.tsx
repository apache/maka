import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelCatalogEntry } from '@maka/core';
import {
  TextInput,
  CheckboxInput,
  OverlayScrollArea,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Enabled-model editor. The full candidate catalog (live-fetched merged with
 * the static fallback, via buildCatalogModelChoices) is shown persistently
 * inside a fixed-height scroll region; enabled models read as checked. Clicking
 * a row toggles it through the shared `enabledModelIds` path, so a newly
 * enabled model reaches the chat model picker with no side state. The default
 * model stays checked and locked (`connectionEnabledModelIds` always keeps it
 * enabled). Search filters the same list in place, so neither the provider's
 * model count nor an active filter changes the dialog height.
 */
export function EnabledModelManager(props: {
  modelChoices: ModelCatalogEntry[];
  enabledModelIds: string[];
  defaultModel: string;
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const [query, setQuery] = useState('');
  // Roving tabindex (composite-widget keyboard pattern): the whole list is ONE
  // Tab stop. Without this every row button is a Tab stop, and a large catalog
  // (OpenRouter's fallback list is 260+ rows) walls off everything below the
  // list for keyboard users. Only the active row has tabIndex=0; ArrowUp/Down
  // + Home/End move activity (focus scrolls the row into view), Space/Enter
  // toggle via the button's native activation.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const enabled = useMemo(() => new Set(props.enabledModelIds), [props.enabledModelIds]);
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

  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;
    return rows.filter(
      (row) => row.id.toLowerCase().includes(normalizedQuery) || row.label.toLowerCase().includes(normalizedQuery),
    );
  }, [rows, query]);

  function toggle(id: string) {
    if (props.disabled || id === props.defaultModel) return;
    const next = enabled.has(id)
      ? props.enabledModelIds.filter((candidate) => candidate !== id)
      : [...props.enabledModelIds, id];
    props.onChange(next);
  }

  // The default-model row is disabled (natively unfocusable), so arrow-key
  // traversal skips it — consistent with Tab behavior.
  const focusableRows = visibleRows.filter((row) => row.id !== props.defaultModel);
  const resolvedActiveRowId = activeRowId !== null && focusableRows.some((row) => row.id === activeRowId)
    ? activeRowId
    : focusableRows[0]?.id ?? null;

  function onModelListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (focusableRows.length === 0) return;
    const currentIndex = Math.max(0, focusableRows.findIndex((row) => row.id === resolvedActiveRowId));
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(currentIndex + 1, focusableRows.length - 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(currentIndex - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = focusableRows.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = focusableRows[nextIndex];
    setActiveRowId(next.id);
    // Focus scrolls the row into view inside the fixed-height scroll region.
    modelListRef.current
      ?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(next.id)}"]`)
      ?.focus();
  }

  return (
    <section className="providerEnabledModels" aria-labelledby="provider-enabled-models-title">
      <div className="providerEnabledModelsHeader">
        <strong id="provider-enabled-models-title">{copy.enabledModelsTitle(props.enabledModelIds.length)}</strong>
        <span>{copy.enabledModelsHelp}</span>
      </div>
      <TextInput
        type="text"
        value={query}
        onChange={(value) => setQuery(value)}
        placeholder={copy.searchModels}
        isDisabled={props.disabled}
              label={copy.searchModels}
              isLabelHidden
      />
      <OverlayScrollArea className="providerModelChoiceScroll">
        <ul
          ref={modelListRef}
          className="providerModelChoiceList"
          aria-label={copy.modelListAria}
          onKeyDown={onModelListKeyDown}
        >
          {visibleRows.length === 0 ? (
            <li className="providerModelChoiceEmpty">
              {rows.length === 0 ? copy.noModels : copy.noMatchingModels}
            </li>
          ) : (
            visibleRows.map((row) => {
              const isEnabled = enabled.has(row.id);
              const isDefault = row.id === props.defaultModel;
              return (
                <li key={row.id}>
                  <CheckboxInput
                    className="providerModelChoiceRow"
                    size="sm"
                    label={row.label}
                    description={isDefault ? copy.defaultModel : undefined}
                    value={isEnabled}
                    data-model-id={row.id}
                    tabIndex={row.id === resolvedActiveRowId ? 0 : -1}
                    isDisabled={props.disabled || isDefault}
                    onChange={() => toggle(row.id)}
                    onFocus={() => setActiveRowId(row.id)}
                  />
                </li>
              );
            })
          )}
        </ul>
      </OverlayScrollArea>
    </section>
  );
}

function modelDisplayLabel(model: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return model.displayName?.trim() || model.id;
}
