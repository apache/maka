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

import { useEffect, useRef, type ReactNode, type CSSProperties, type KeyboardEvent } from 'react';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { RadioList, RadioListItem, Kbd, Text } from '@astryxdesign/core';

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
  const locale = useUiLocale();
  const hint = getConversationCopy(locale).questions.keyboardHint;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey || props.disabled) return;
    const target = event.target as HTMLElement;
    if (target.closest('input:not([type="radio"]), textarea, [contenteditable="true"]')) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    const index = props.options.findIndex((option) => option.value === props.value);
    if (digit >= 0 && digit < props.options.length) {
      event.preventDefault(); props.onChange(props.options[digit]!.value);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!props.options.length) return;
      event.preventDefault();
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : props.options.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + props.options.length) % props.options.length;
      props.onChange(props.options[next]!.value);
    } else if (event.key === 'Enter' && !target.closest('button, a')) {
      event.preventDefault(); if (props.value) props.onConfirm();
    } else if (event.key === 'Escape') {
      event.preventDefault(); props.onEscape();
    }
  }
  return <div className="maka-choice-panel" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
    <RadioList label={props.label} isLabelHidden value={props.value} isDisabled={props.disabled} onChange={props.onChange}>
      {props.options.map((option, index) => <RadioListItem key={option.value} value={option.value}
        label={option.label} description={option.description}
        style={option.accentColor ? { '--_item-label-color': option.accentColor } as CSSProperties : undefined}
        endContent={index < 9 ? <Kbd keys={String(index + 1)} aria-hidden="true" /> : undefined} />)}
    </RadioList>
    <Text as="p" type="supporting" color="secondary" className="maka-choice-hint">{hint}</Text>
    {props.children}
  </div>;
}
