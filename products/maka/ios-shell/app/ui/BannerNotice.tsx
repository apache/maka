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
import { tr } from '../locale';
import { spacing, type } from '../theme/tokens';
import { Icon } from './Icon';

export type NoticeTone = 'info' | 'warning' | 'destructive' | 'success';

export function BannerNotice(props: {
  tone?: NoticeTone;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  const tone = () => props.tone ?? 'info';

  const bg = () => {
    switch (tone()) {
      case 'warning':
        return token('warning-tint');
      case 'destructive':
        return token('destructive-tint');
      case 'success':
        return token('success-tint');
      default:
        return token('primary-tint');
    }
  };

  const accent = () => {
    switch (tone()) {
      case 'warning':
        return token('warning');
      case 'destructive':
        return token('destructive');
      case 'success':
        return token('success');
      default:
        return token('primary');
    }
  };

  return (
    <View
      style={{
        marginHorizontal: spacing.pageX,
        marginBottom: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: spacing.groupRadius,
        borderCurve: 'continuous',
        backgroundColor: bg(),
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Icon name={tone() === 'success' ? 'checkCircle' : 'warning'} color={accent()} size={18} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            ...type.subheadlineMedium,
            color: token('foreground'),
          }}
        >
          {props.title}
        </Text>
        <If when={props.detail}>
          <Text
            style={{
              ...type.footnote,
              color: token('muted-foreground'),
            }}
          >
            {props.detail}
          </Text>
        </If>
      </View>
      <If when={props.actionLabel && props.onAction}>
        <View
          role="button"
          accessibilityLabel={props.actionLabel}
          onPress={props.onAction}
          class="active:opacity-70"
          style={{
            minHeight: 34,
            paddingHorizontal: 12,
            borderRadius: 8,
            borderCurve: 'continuous',
            backgroundColor: token('surface'),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              ...type.footnote,
              fontWeight: '600',
              color: accent(),
            }}
          >
            {props.actionLabel}
          </Text>
        </View>
      </If>
      <If when={props.onDismiss}>
        <View
          role="button"
          accessibilityLabel={tr('Dismiss')}
          onPress={props.onDismiss}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="close" color={token('muted-foreground')} size={16} />
        </View>
      </If>
    </View>
  );
}
