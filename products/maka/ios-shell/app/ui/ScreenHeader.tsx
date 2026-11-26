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
import { tr } from '../locale';
import { spacing, type } from '../theme/tokens';
import { Icon } from './Icon';

/**
 * Fallback header for NavPage.header when running without a native UIKit header
 * (headless tests & desktop projections). Ignored automatically on real iOS where
 * UIKit renders the native UINavigationBar.
 */
export function ScreenHeader(props: {
  title: string;
  backLabel?: string;
  onBack?: () => void;
  trailing?: JSX.Element;
  large?: boolean;
}) {
  return (
    <View
      style={{
        backgroundColor: token('grouped-bg'),
        paddingHorizontal: spacing.pageX,
        paddingTop: 10,
        paddingBottom: props.large ? 8 : 10,
      }}
    >
      <View
        style={{
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }}>
          <If when={props.onBack}>
            <View
              role="button"
              accessibilityLabel={props.backLabel ?? tr('Back')}
              onPress={props.onBack}
              class="active:opacity-60"
              style={{
                minHeight: 44,
                minWidth: 44,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 2,
                marginLeft: -8,
                paddingHorizontal: 6,
              }}
            >
              <Icon name="chevronLeft" color={token('primary')} size={20} strokeWidth={2.2} />
              <If when={props.backLabel}>
                <Text style={{ ...type.body, color: token('primary') }}>{props.backLabel}</Text>
              </If>
            </View>
          </If>
          <If when={!props.large}>
            <Text
              style={{
                ...type.headline,
                color: token('foreground'),
                flex: 1,
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {props.title}
            </Text>
          </If>
        </View>
        <If when={props.trailing}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {props.trailing}
          </View>
        </If>
      </View>
      <If when={props.large}>
        <Text
          style={{
            fontSize: 32,
            fontWeight: '700',
            lineHeight: 38,
            letterSpacing: -0.5,
            color: token('foreground'),
            marginTop: 2,
            numberOfLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {props.title}
        </Text>
      </If>
    </View>
  );
}
