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

import { createContext, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, EmptyState, TextInput, isImeKeyEvent, useCombobox } from '@astryxdesign/core';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

/** Native controls keep their selection semantics while sharing the executor panel. */
export const ModelPickerPanelContext = createContext<undefined | { onSelected(): void }>(undefined);

export interface ModelPickerPanelOption {
  value: string;
  label: string;
  detail?: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
  disabled?: boolean;
}

export function ModelPickerPanel(props: {
  options: readonly ModelPickerPanelOption[];
  value?: string;
  disabled?: boolean;
  disabledReason?: string;
  searchPlaceholder?: string;
  onSelect(value: string): void | Promise<void>;
  renderOption?(option: ModelPickerPanelOption): ReactNode;
}) {
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).modelPicker;
  const searchPlaceholder = props.searchPlaceholder ?? copy.searchPlaceholder;
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const normalized = query.trim().toLocaleLowerCase(locale);
  const options = props.options.filter((option) => !normalized || (
    [option.label, option.detail, option.description, option.group].join(' ').toLocaleLowerCase(locale).includes(normalized)
  ));
  const combobox = useCombobox({
    selectableItems: options,
    value: props.value,
    isDisabled: props.disabled,
    isOpen: true,
    hasSearch: true,
    listboxId,
    onOpen: () => {},
    // The selection owner closes only after a successful async commit.
    onClose: () => {},
    onSelect: (value) => void props.onSelect(value),
  });
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return;
    // Home/End edit the query; Escape and Tab belong to the selector surface.
    if (['ArrowDown', 'ArrowUp', 'PageUp', 'PageDown', 'Enter'].includes(event.key)) {
      combobox.onKeyDown(event);
    }
  };
  return (
    <>
      <TextInput
        ref={searchRef}
        className="maka-executor-picker-search"
        label={searchPlaceholder}
        isLabelHidden
        size="sm"
        width="100%"
        value={query}
        placeholder={searchPlaceholder}
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={options[combobox.highlightedIndex] ? combobox.getItemId(combobox.highlightedIndex) : undefined}
        onChange={(value) => { setQuery(value); combobox.setHighlightedIndex(-1); }}
        onKeyDown={navigate}
        // Portalled input clicks must not reach ChatComposer's click-to-focus body.
        onClick={(event) => event.stopPropagation()}
      />
      <div id={listboxId} className="maka-executor-picker-model-list" role="listbox" aria-label={searchPlaceholder} hidden={options.length === 0}>
        {options.map((option, index) => (
          <div key={option.value} className="maka-executor-picker-option">
            {option.group && option.group !== options[index - 1]?.group ? (
              <div className="maka-executor-picker-group">{option.group}</div>
            ) : null}
            <Button
              label={option.label}
              variant="ghost"
              size="sm"
              role="option"
              id={combobox.getItemId(index)}
              tabIndex={-1}
              data-highlighted={combobox.highlightedIndex === index ? 'true' : undefined}
              onMouseEnter={() => combobox.onItemMouseEnter(option, index)}
              icon={props.renderOption ? undefined : option.icon}
              aria-selected={props.value === option.value}
              className="maka-executor-picker-model"
              isDisabled={props.disabled || option.disabled}
              tooltip={props.disabledReason ?? option.description}
              onClick={() => combobox.onItemSelect(option)}
            >
              {props.renderOption ? props.renderOption(option) : (
                <span className="maka-executor-picker-label">
                  <span>{option.label}</span>
                  {option.detail && option.detail !== option.label ? <small>{option.detail}</small> : null}
                </span>
              )}
            </Button>
          </div>
        ))}
      </div>
      {options.length === 0 && <EmptyState
        isCompact
        title={normalized ? copy.noResults : copy.empty}
        actions={normalized ? <Button
          label={copy.clearSearch}
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            setQuery('');
            combobox.setHighlightedIndex(-1);
            searchRef.current?.focus();
          }}
        /> : undefined}
      />}
    </>
  );
}
