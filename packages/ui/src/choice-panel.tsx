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

import { useEffect, useId, useRef, type ReactNode, type CSSProperties, type KeyboardEvent } from 'react';
import { Badge, Item, isImeKeyEvent } from '@astryxdesign/core';

export interface ChoicePanelOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly accentColor?: string;
}

/** Shared single-choice interaction for questions and explicit target selection. */
export function ChoicePanel(props: {
  label: string;
  options: readonly ChoicePanelOption[];
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
  onConfirm(): void;
  onEscape(): void;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => { root.current?.focus(); }, []);
  const selectedIndex = props.options.findIndex((option) => option.value === props.value);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || isImeKeyEvent(event.nativeEvent) || event.altKey || event.metaKey || event.ctrlKey || props.disabled) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    const index = selectedIndex;
    if (digit >= 0 && digit < props.options.length) {
      event.preventDefault(); props.onChange(props.options[digit]!.value);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!props.options.length) return;
      event.preventDefault();
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : props.options.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + props.options.length) % props.options.length;
      props.onChange(props.options[next]!.value);
    } else if (event.key === 'Enter' && !target.closest('button, a')) {
      event.preventDefault(); props.onConfirm();
    } else if (event.key === 'Escape') {
      event.preventDefault(); props.onEscape();
    }
  }
  return <div className="maka-choice-panel" ref={root} tabIndex={props.disabled ? -1 : 0} role="listbox" aria-label={props.label}
    aria-activedescendant={selectedIndex >= 0 ? `${listId}-option-${selectedIndex}` : undefined}
    aria-disabled={props.disabled || undefined}
    onKeyDown={onKeyDown}
    // The composer's body click focuses the input; clicking between options
    // must keep focus on the panel so the digit/arrow keys keep working.
    onClick={(event) => { event.stopPropagation(); root.current?.focus({ preventScroll: true }); }}>
    {props.options.map((option, index) => {
      const selected = option.value === props.value;
      return <Item key={option.value} id={`${listId}-option-${index}`} role="option"
        label={<span>{option.label}</span>}
        description={option.description ? <span>{option.description}</span> : undefined}
        isSelected={selected} isDisabled={props.disabled}
        onClick={props.disabled ? undefined : (event) => {
          event.stopPropagation();
          props.onChange(option.value);
          root.current?.focus({ preventScroll: true });
        }}
        startContent={index < 9 ? <Badge variant={selected ? 'info' : 'neutral'} label={<span>{index + 1}</span>} aria-hidden="true" /> : undefined}
        style={option.accentColor ? { '--_item-label-color': option.accentColor } as CSSProperties : undefined} />;
    })}
    {props.children}
  </div>;
}
