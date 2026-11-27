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
import { Button } from 'nsh/base';
import { spacing, type } from '../theme/tokens';
import { Icon, type IconName } from './Icon';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'glassPrimary'
  | 'glassDestructive'
  | 'glassSecondary'
  | 'glassQuiet'
  | 'quiet'
  | 'destructive'
  | 'destructiveFilled';

export function ActionButton(props: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  compact?: boolean;
  minHeight?: number;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const variant = () => props.variant ?? 'primary';
  const compact = () => !!props.compact;
  const glass = () => variant().startsWith('glass');
  const pressedColor = () =>
    token(
      variant() === 'glassPrimary'
        ? 'glass-primary-pressed-bg'
        : variant() === 'glassDestructive'
          ? 'glass-destructive-pressed-bg'
          : 'glass-action-pressed-bg',
    );

  const backgroundColor = () => {
    switch (variant()) {
      case 'primary':
        return token('primary');
      case 'secondary':
        return token('primary-tint');
      case 'glassPrimary':
        return token('glass-accent');
      case 'glassSecondary':
        return token('glass-action-bg');
      case 'glassDestructive':
      case 'glassQuiet':
        return token('surface-elevated');
      case 'destructive':
        return token('destructive-tint');
      case 'destructiveFilled':
        return token('destructive');
      case 'quiet':
        return 'transparent';
    }
  };

  const foregroundColor = () => {
    switch (variant()) {
      case 'primary':
      case 'destructiveFilled':
        return token('primary-foreground');
      case 'secondary':
      case 'quiet':
        return token('primary');
      case 'glassPrimary':
        return token('glass-primary-fg');
      case 'glassDestructive':
        return token('glass-destructive');
      case 'glassSecondary':
      case 'glassQuiet':
        return token('glass-accent');
      case 'destructive':
        return token('destructive');
    }
  };

  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      disabled={props.disabled}
      onPress={props.onPress}
      class={
        glass()
          ? 'disabled:opacity-45'
          : 'active:opacity-70 transition-opacity duration-150 disabled:opacity-45'
      }
      activeStyle={glass() ? { backgroundColor: pressedColor() } : undefined}
      style={{
        minHeight: props.minHeight ?? (compact() ? 40 : spacing.buttonMinHeight),
        minWidth: props.minHeight,
        maxWidth: '100%',
        paddingHorizontal: compact() ? 14 : 18,
        paddingVertical: compact() ? 9 : 13,
        borderRadius: spacing.controlRadius,
        borderCurve: 'continuous',
        backgroundColor: backgroundColor(),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} color={foregroundColor()} size={compact() ? 16 : 18} />
      </If>
      <Text
        style={{
          ...(compact() ? type.subheadlineMedium : type.headline),
          fontWeight: variant() === 'quiet' || variant() === 'glassQuiet' ? '500' : '600',
          color: foregroundColor(),
          textAlign: 'center',
          flexShrink: 1,
        }}
      >
        {props.title}
      </Text>
    </Button>
  );
}
