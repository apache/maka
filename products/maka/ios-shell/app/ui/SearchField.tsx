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

import { Text, View, token } from 'nsh';
import { Input } from 'nsh/base';
import { tr } from '../locale';
import { spacing, type } from '../theme/tokens';
import { Icon } from './Icon';

export function SearchField(props: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  accessibilityLabel?: string;
}) {
  return (
    <View
      style={{
        marginHorizontal: spacing.pageX,
        marginBottom: 12,
        minHeight: 38,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderCurve: 'continuous',
        backgroundColor: token('surface-muted'),
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Icon name="search" color={token('muted-foreground')} size={16} />
      <Input
        accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
        value={props.value}
        placeholder={props.placeholder}
        onChange={({ value }) => props.onChange(value)}
        style={{
          flex: 1,
          ...type.body,
          color: token('foreground'),
          placeholderColor: token('muted-foreground'),
          paddingVertical: 6,
          backgroundColor: 'transparent',
        }}
      />
      <If when={props.value.length > 0}>
        <View
          role="button"
          accessibilityLabel={tr('Clear search')}
          onPress={() => props.onChange('')}
          style={{
            width: 28,
            height: 28,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="close" color={token('muted-foreground')} size={15} />
        </View>
      </If>
    </View>
  );
}
