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

import type { ReactNode } from 'react';
import { Tab, TabList } from '@astryxdesign/core';
import type { ExtensionModule } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { ICON_SIZE, Blocks, Plug } from './icons.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export type ModuleHubHeader = {
  title: string;
  subtitle?: string;
  badge: ReactNode;
};

type ModuleHubSelectorProps = {
  value: ExtensionModule;
  onChange(value: ExtensionModule): void;
};

type SelectorOption = readonly [value: string, label: string, icon: ReactNode];

function Selector(props: {
  value: string;
  options: readonly SelectorOption[];
  ariaLabel: string;
  onChange(value: string): void;
}) {
  return (
    <TabList
      className="maka-module-hub-selector"
      value={props.value}
      aria-label={props.ariaLabel}
      onChange={props.onChange}
    >
      {props.options.map(([value, label, icon]) => (
        <Tab key={value} value={value} label={label} icon={icon} />
      ))}
    </TabList>
  );
}

export function ModuleHubSelector(props: ModuleHubSelectorProps) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs;
  const options = [
    ['skills', copy.extensions.skills, <Blocks key="skills" size={ICON_SIZE.chrome} aria-hidden="true" />],
    ['mcp', copy.extensions.mcp, <Plug key="mcp" size={ICON_SIZE.chrome} aria-hidden="true" />],
  ] as const;
  const selectedLabel = options.find(([value]) => value === props.value)?.[1] ?? copy.extensions.skills;
  return (
    <Selector
      value={props.value}
      options={options}
      ariaLabel={copy.extensions.selectorLabel(selectedLabel)}
      onChange={(value) => props.onChange(value as ExtensionModule)}
    />
  );
}
