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
import { type } from '../theme/tokens';
import { ActionButton } from './ActionButton';
import { Icon, type IconName } from './Icon';

export function EmptyState(props: {
  icon: IconName;
  title: string;
  subtitle?: string;
  tint?: 'primary' | 'success' | 'muted';
  actionTitle?: string;
  onAction?: () => void;
}) {
  const badgeBg = () => {
    if (props.tint === 'success') return token('success-tint');
    if (props.tint === 'muted') return token('surface-muted');
    return token('primary-tint');
  };
  const iconColor = () => {
    if (props.tint === 'success') return token('success');
    if (props.tint === 'muted') return token('muted-foreground');
    return token('primary');
  };

  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingVertical: 48,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          borderCurve: 'continuous',
          backgroundColor: badgeBg(),
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 4,
        }}
      >
        <Icon name={props.icon} color={iconColor()} size={26} />
      </View>
      <Text
        style={{
          ...type.headline,
          color: token('foreground'),
          textAlign: 'center',
        }}
      >
        {props.title}
      </Text>
      <If when={props.subtitle}>
        <Text
          style={{
            ...type.subheadline,
            color: token('muted-foreground'),
            textAlign: 'center',
            maxWidth: 308,
          }}
        >
          {props.subtitle}
        </Text>
      </If>
      <If when={props.actionTitle && props.onAction}>
        <View style={{ marginTop: 8, width: '100%', maxWidth: 260 }}>
          <ActionButton title={props.actionTitle!} onPress={props.onAction!} />
        </View>
      </If>
    </View>
  );
}
