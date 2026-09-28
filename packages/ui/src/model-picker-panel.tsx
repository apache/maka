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

import { createContext, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, TextInput } from '@astryxdesign/core';
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
  onSelect(value: string): void | Promise<void>;
  renderOption?(option: ModelPickerPanelOption): ReactNode;
}) {
  const locale = useUiLocale();
  const copy = getSharedUiCopy(locale).modelPicker;
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase(locale);
  const options = props.options.filter((option) => !normalized || (
    [option.label, option.detail, option.description, option.group].join(' ').toLocaleLowerCase(locale).includes(normalized)
  ));
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .filter((row) => !row.disabled && row.getAttribute('aria-disabled') !== 'true');
    if (rows.length === 0) return;
    const index = rows.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    event.preventDefault();
    rows[next]?.focus();
  };
  return (
    <>
      <TextInput
        className="maka-executor-picker-search"
        label={copy.searchPlaceholder}
        isLabelHidden
        size="sm"
        width="100%"
        value={query}
        placeholder={copy.searchPlaceholder}
        onChange={setQuery}
      />
      <div className="maka-executor-picker-model-list" role="listbox" aria-label={copy.searchPlaceholder} onKeyDown={navigate}>
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
              icon={props.renderOption ? undefined : option.icon}
              aria-selected={props.value === option.value}
              className="maka-executor-picker-model"
              isDisabled={props.disabled || option.disabled}
              tooltip={props.disabledReason ?? option.description}
              onClick={() => void props.onSelect(option.value)}
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
        {options.length === 0 ? <span role="status">{normalized ? copy.noResults : copy.empty}</span> : null}
      </div>
    </>
  );
}
