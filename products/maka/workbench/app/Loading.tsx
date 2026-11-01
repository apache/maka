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

import { platform, reduceMotion, Text, View } from 'nsh';
import { tr } from './locale';
import { C, captionTextStyle } from './ui';
import { Icon } from './Icon';

export function LoadingIndicator(props: { label?: string; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label ?? tr('Loading…')}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <If when={platform.isTerminal}>
        <Text
          accessibilityElementsHidden
          style={{ color: props.color ?? C.muted, lineHeight: size }}
        >
          ◌
        </Text>
      </If>
      <If when={!platform.isTerminal}>
        <View
          accessibilityElementsHidden
          style={{
            width: size,
            height: size,
            animationName: reduceMotion() ? 'none' : 'spin',
            animationDuration: 800,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
          }}
        >
          <Icon name="loader" size={size} color={props.color ?? C.muted} />
        </View>
      </If>
    </View>
  );
}

export function LoadingState(props: { label?: string }) {
  return (
    <View
      style={{
        flex: 1,
        minHeight: 48,
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <LoadingIndicator size={24} label={props.label} />
      <If when={platform.isTerminal}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{props.label ?? tr('Loading…')}</Text>
      </If>
    </View>
  );
}
