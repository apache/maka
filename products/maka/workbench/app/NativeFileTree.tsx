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

import { type JSX, computed, effect, signal, Image, platform, Text, View } from 'nsh';
import { Tree, type TreeItem } from 'nsh/base';
import { fileIcon } from './pierreIcons.js';
import { C, DisclosureChevron } from './ui';
import { Icon } from './Icon';

export function NativeFileTree(props: {
  label: string;
  items: TreeItem[];
  expanded: string[];
  setExpanded(ids: string[]): void;
  open(id: string): void;
  demand?(id: string): void;
  detail?(id: string): JSX.Element;
  selected?: string;
}) {
  const open = computed(() => new Set(props.expanded));
  const selected = signal<string | null>(null);
  effect(() => selected.set(props.selected ?? null));
  return (
    <Tree
      accessibilityLabel={props.label}
      items={props.items}
      expanded={props.expanded}
      selected={selected()}
      onSelectedChange={({ selected: id }) => selected.set(id)}
      onExpandedChange={({ expanded }) => props.setExpanded(expanded)}
      singleClickAction
      onAction={({ id }) => props.open(id)}
      style={{ flex: 1, minHeight: 0 }}
      listStyle={{ padding: 4 }}
      itemClass="group rounded-md hover:bg-accent selected:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      itemStyle={{ height: 28 }}
      renderItem={(entry) => {
        const more = entry.id.startsWith('more:');
        const image = !entry.folder && !more ? fileIcon(entry.label) : undefined;
        return (
          <View
            onLayout={more ? () => props.demand?.(entry.id) : undefined}
            style={{
              height: 28,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingLeft: 4 + 12 * entry.depth,
              paddingRight: 6,
            }}
          >
            <View style={{ width: 11 }}>
              {entry.folder ? <DisclosureChevron open={open().has(entry.id)} size={11} /> : null}
            </View>
            {entry.folder ? (
              <Icon name="folder" color={C.secondary} size={15} />
            ) : more ? null : platform.idiom === 'terminal' ? (
              <Icon name="file" color={C.secondary} size={15} />
            ) : (
              <Image
                accessibilityElementsHidden
                src={image}
                style={{ height: 15, width: 15, flexShrink: 0, tintColor: C.secondary }}
              />
            )}
            <Text
              style={[
                { flex: 1, minWidth: 0, fontSize: 13, color: entry.disabled ? C.muted : C.text },
                { numberOfLines: 1 },
              ]}
            >
              {entry.label}
            </Text>
            {props.detail?.(entry.id)}
          </View>
        );
      }}
    />
  );
}
