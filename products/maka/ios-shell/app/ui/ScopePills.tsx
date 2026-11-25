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

import { Scroll, Text, View, token } from 'nsh';
import { spacing, type } from '../theme/tokens';
import { StatusDot, type StatusKind } from './StatusDot';

export interface ScopePillItem {
  id: string;
  label: string;
  status?: StatusKind;
  count?: number;
}

export function ScopePills(props: {
  items: readonly ScopePillItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Scroll
      horizontal
      scrollbar={false}
      style={{ marginBottom: 12 }}
      contentStyle={{ paddingHorizontal: spacing.pageX }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Each of={[...props.items]} key={(item) => item.id}>
          {(item) => {
            const active = () => props.selectedId === item().id;
            return (
              <View
                role="button"
                accessibilityLabel={item().label}
                onPress={() => props.onSelect(item().id)}
                class="active:opacity-75 transition-colors duration-150"
                style={{
                  minHeight: 36,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: spacing.pillRadius,
                  backgroundColor: active() ? token('primary-tint') : token('surface-muted'),
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <If when={item().status}>
                  <StatusDot kind={item().status!} size={7} />
                </If>
                <Text
                  style={{
                    ...type.subheadline,
                    fontWeight: active() ? '600' : '500',
                    color: active() ? token('primary') : token('foreground'),
                  }}
                >
                  {item().label}
                </Text>
                <If when={(item().count ?? 0) > 0}>
                  <Text
                    style={{
                      ...type.caption,
                      fontWeight: '600',
                      fontVariant: ['tabular-nums'],
                      color: active() ? token('primary') : token('muted-foreground'),
                    }}
                  >
                    {String(item().count)}
                  </Text>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );
}
