/**
 * Shared, searchable model picker popup: one component behind both the chat
 * composer's model switcher and Settings → 通用 → 默认模型.
 *
 * Astryx owns the combobox keyboard contract and native-popover layer. Maka
 * keeps only the product-specific grouped catalog, provider marks, and static
 * thinking-level footer that the generic Selector component cannot express.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useCombobox,
  type SelectorOptionData,
} from '@astryxdesign/core/Selector';
import { usePopover } from '@astryxdesign/core/Popover';
import type { ProviderType } from '@maka/core';
import type { ModelMenuGroup } from './chat-model-helpers.js';
import { Check, ChevronDown } from './icons.js';
import {
  buildModelPickerGroups,
  filterModelPickerOption,
  modelPickerHasCatalogMatches,
  type ModelPickerOption,
  type ModelPickerPinnedItem,
} from './model-picker-internals.js';
import { cn } from './utils.js';
import {
  pickerTriggerClasses,
  type PickerTriggerAppearance,
} from './ui.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export interface ModelPickerProps {
  groups: ModelMenuGroup[];
  value: string;
  onValueChange(value: string): void;
  renderProviderMark?(type: ProviderType): ReactNode;
  disabled?: boolean;
  /** Row pinned above catalog groups and exempt from search filtering. */
  pinnedItem?: ModelPickerPinnedItem;
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerClassName?: string;
  triggerAppearance?: PickerTriggerAppearance;
  popupClassName?: string;
  ariaLabel: string;
  title?: string;
  /** Static popup footer, outside the scrollable model list. */
  footer?(context: { open: boolean; close(): void }): ReactNode;
  /** Trigger button inner content; the chevron is added by ModelPicker. */
  children: ReactNode;
}

export function ModelPicker(props: ModelPickerProps) {
  const copy = getSharedUiCopy(useUiLocale()).modelPicker;
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => buildModelPickerGroups(props.groups, props.pinnedItem),
    [props.groups, props.pinnedItem],
  );
  const filteredGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            filterModelPickerOption(item, query),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [groups, query],
  );
  const filteredOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.items),
    [filteredGroups],
  );

  const handleLayerHide = useCallback(() => {
    setQuery('');
  }, []);
  const popover = usePopover({
    onHide: handleLayerHide,
    hasLightDismiss: true,
    hasCloseButton: false,
    hasAutoFocus: false,
    role: 'none',
  });
  const { hide, isOpen, render, show, triggerRef } = popover;

  const open = useCallback(() => {
    show({ skipAutoFocus: true });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [show]);
  const close = useCallback(() => {
    hide();
    setQuery('');
  }, [hide]);

  const {
    highlightedIndex,
    setHighlightedIndex,
    getItemId,
    onTriggerClick,
    onKeyDown,
    onItemSelect,
    onItemMouseEnter,
  } = useCombobox({
    selectableItems: filteredOptions as SelectorOptionData[],
    value: props.value,
    isDisabled: props.disabled,
    isOpen,
    hasSearch: true,
    onOpen: open,
    onClose: close,
    onSelect: props.onValueChange,
    listboxId,
  });

  useEffect(() => {
    if (!isOpen) setHighlightedIndex(-1);
  }, [isOpen, setHighlightedIndex]);

  const noMatches =
    !modelPickerHasCatalogMatches(filteredOptions) &&
    (query.trim().length > 0 || !props.pinnedItem);
  const activeIndex = filteredOptions[highlightedIndex]
    ? highlightedIndex
    : -1;

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    document
      .getElementById(getItemId(activeIndex))
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, getItemId, isOpen]);

  let optionIndex = 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          pickerTriggerClasses(props.triggerAppearance),
          'modelPickerTrigger',
          props.triggerClassName,
        )}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        title={props.title}
        disabled={props.disabled}
        onClick={onTriggerClick}
        onKeyDown={onKeyDown}
      >
        {props.children}
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {render(
        <div
          className={cn(
            'modelPickerPopup',
            props.popupClassName,
          )}
        >
          <input
            ref={inputRef}
            className="modelPickerSearchInput"
            role="combobox"
            aria-label={
              props.searchPlaceholder ?? copy.searchAriaLabel
            }
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0
                ? getItemId(activeIndex)
                : undefined
            }
            value={query}
            placeholder={
              props.searchPlaceholder ?? copy.searchPlaceholder
            }
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={onKeyDown}
          />

          {noMatches && (
            <div className="modelPickerEmpty">
              {props.emptyMessage ?? copy.empty}
            </div>
          )}
          <div
            id={listboxId}
            role="listbox"
            aria-label={props.ariaLabel}
            className="modelPickerList"
          >
            {filteredGroups.map((group) => {
              const groupItems = group.items.map((item) => {
                const index = optionIndex++;
                const highlighted = index === activeIndex;
                const selected = item.value === props.value;
                return (
                  <div
                    key={item.value}
                    id={getItemId(index)}
                    role="option"
                    aria-selected={selected}
                    data-highlighted={highlighted ? '' : undefined}
                    data-selected={selected ? '' : undefined}
                    className="modelPickerOption"
                    onClick={() => onItemSelect(item)}
                    onMouseEnter={() =>
                      onItemMouseEnter(item, index)
                    }
                  >
                    <span
                      className="modelPickerOptionIndicator"
                      aria-hidden="true"
                    >
                      {selected ? <Check size={13} /> : null}
                    </span>
                    <span className="modelPickerOptionLabel">
                      {item.label}
                    </span>
                  </div>
                );
              });

              if (!group.heading) return groupItems;
              const logo = group.providerType
                ? props.renderProviderMark?.(group.providerType)
                : null;
              return (
                <div
                  key={group.key}
                  role="group"
                  aria-label={group.heading}
                  className="modelPickerGroup"
                >
                  <div className="modelPickerGroupLabel">
                    {logo ? (
                      <span
                        className="modelPickerGroupLogo"
                        aria-hidden="true"
                      >
                        {logo}
                      </span>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <span>{group.heading}</span>
                  </div>
                  {groupItems}
                </div>
              );
            })}
          </div>
          {props.footer?.({ open: isOpen, close })}
        </div>,
        { placement: 'below', alignment: 'start' },
      )}
    </>
  );
}
