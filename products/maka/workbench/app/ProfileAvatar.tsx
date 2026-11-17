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

import { Text, View } from 'nsh';
import type { ProfileAvatar as Avatar } from '../../../../packages/plugin-sdk/src/index.js';
import { Icon } from './Icon';
import { C } from './ui';

const palette = {
  blue: { background: '#234765', foreground: '#d9efff' },
  green: { background: '#244d40', foreground: '#d4f7e5' },
  rose: { background: '#673950', foreground: '#ffe0ed' },
  amber: { background: '#614624', foreground: '#ffebc9' },
} satisfies Record<Avatar, { background: string; foreground: string }>;

export function ProfileAvatar(props: { name: string; avatar?: Avatar | null; size: number }) {
  const color = () => (props.avatar ? palette[props.avatar] : null);
  const foreground = () => color()?.foreground ?? C.secondary;
  const initial = () => Array.from(props.name.trim())[0]?.toLocaleUpperCase();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color()?.background ?? C.surface,
      }}
    >
      <If
        when={initial()}
        else={<Icon name="user" size={Math.round(props.size * 0.56)} color={foreground()} />}
      >
        <Text style={{ fontSize: props.size * 0.46, fontWeight: '600', color: foreground() }}>
          {initial()}
        </Text>
      </If>
    </View>
  );
}
