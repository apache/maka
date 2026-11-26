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

import { Text, View, token, type JSX } from 'nsh';
import { spacing, type } from '../theme/tokens';
import { Icon } from './Icon';

export function GroupHeader(props: { title: string; trailing?: JSX.Element }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.pageX + 16,
        marginBottom: 6,
      }}
    >
      <Text
        style={{
          ...type.footnote,
          fontWeight: '500',
          color: token('muted-foreground'),
        }}
      >
        {props.title}
      </Text>
      <If when={props.trailing}>{props.trailing}</If>
    </View>
  );
}

export function GroupFooter(props: { text: string }) {
  return (
    <View
      style={{
        paddingHorizontal: spacing.pageX + 16,
        marginTop: 6,
      }}
    >
      <Text
        style={{
          ...type.footnote,
          color: token('muted-foreground'),
        }}
      >
        {props.text}
      </Text>
    </View>
  );
}

export function GroupDivider(props: { inset?: number }) {
  return (
    <View
      style={{
        height: spacing.hairline,
        marginLeft: props.inset ?? 16,
        backgroundColor: token('separator'),
      }}
    />
  );
}

/**
 * Apple HIG Inset-Grouped container: pure surface over grouped-bg,
 * continuous 12pt corner radius, zero outer border.
 */
export function InsetGroup(props: {
  header?: string;
  headerTrailing?: JSX.Element;
  footer?: string;
  elevated?: boolean;
  children?: JSX.Element;
}) {
  return (
    <View style={{ marginBottom: spacing.sectionGap }}>
      <If when={props.header}>
        <GroupHeader title={props.header!} trailing={props.headerTrailing} />
      </If>
      <View
        style={{
          marginHorizontal: spacing.pageX,
          borderRadius: spacing.groupRadius,
          borderCurve: 'continuous',
          backgroundColor: props.elevated ? token('surface-elevated') : token('surface'),
          overflow: 'hidden',
        }}
      >
        {props.children}
      </View>
      <If when={props.footer}>
        <GroupFooter text={props.footer!} />
      </If>
    </View>
  );
}

export function GroupRow(props: {
  leading?: JSX.Element;
  title: string;
  subtitle?: string;
  value?: string;
  trailing?: JSX.Element;
  chevron?: boolean;
  tone?: 'default' | 'primary' | 'destructive';
  disabled?: boolean;
  divider?: boolean;
  dividerInset?: number;
  accessibilityLabel?: string;
  testID?: string;
  onPress?: () => void;
}) {
  const titleColor = () => {
    if (props.tone === 'primary') return token('primary');
    if (props.tone === 'destructive') return token('destructive');
    return token('foreground');
  };

  const hasLeading = () => props.leading !== undefined;
  const inset = () => props.dividerInset ?? (hasLeading() ? 56 : 16);

  const rowContent = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: props.subtitle ? 56 : spacing.rowMinHeight,
        paddingHorizontal: 16,
        paddingVertical: props.subtitle ? 10 : 11,
        gap: 12,
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <If when={hasLeading()}>
        <View style={{ width: 28, alignItems: 'center', justifyContent: 'center' }}>
          {props.leading}
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            ...type.body,
            fontWeight: props.tone === 'primary' ? '500' : '400',
            color: titleColor(),
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {props.title}
        </Text>
        <If when={props.subtitle}>
          <Text
            style={{
              ...type.footnote,
              color: token('muted-foreground'),
              numberOfLines: 2,
              textOverflow: 'ellipsis',
            }}
          >
            {props.subtitle}
          </Text>
        </If>
      </View>
      <If when={props.value}>
        <Text
          style={{
            ...type.body,
            color: token('muted-foreground'),
            maxWidth: 150,
            textAlign: 'right',
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {props.value}
        </Text>
      </If>
      <If when={props.trailing}>{props.trailing}</If>
      <If when={props.chevron}>
        <Icon
          name="chevronRight"
          color={token('tertiary-foreground')}
          size={16}
          strokeWidth={2.1}
        />
      </If>
    </View>
  );

  return (
    <View>
      <If
        when={props.onPress && !props.disabled}
        else={
          <View testID={props.testID} accessibilityLabel={props.accessibilityLabel ?? props.title}>
            {rowContent}
          </View>
        }
      >
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={props.accessibilityLabel ?? props.title}
          onPress={props.onPress}
          class="active:bg-row-pressed transition-colors duration-150"
        >
          {rowContent}
        </View>
      </If>
      <If when={props.divider}>
        <GroupDivider inset={inset()} />
      </If>
    </View>
  );
}
