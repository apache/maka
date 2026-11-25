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
import { spacing, type } from '../theme/tokens';
import { ActionButton } from './ActionButton';
import { GroupDivider } from './InsetGroup';
import { StatusDot } from './StatusDot';

export function ApprovalCard(props: {
  badge: string;
  timestamp?: string;
  sourceLine: string;
  title: string;
  detail?: string;
  monospaceDetail?: boolean;
  busy?: boolean;
  allowLabel?: string;
  denyLabel?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  onPress?: () => void;
  divider?: boolean;
}) {
  return (
    <View>
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 10,
        }}
      >
        <View
          role={props.onPress ? 'button' : undefined}
          onPress={props.onPress}
          style={{ gap: 6 }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                borderCurve: 'continuous',
                backgroundColor: token('warning-tint'),
              }}
            >
              <StatusDot kind="waiting" size={6} />
              <Text
                style={{
                  ...type.caption,
                  fontWeight: '600',
                  color: token('warning'),
                }}
              >
                {props.badge}
              </Text>
            </View>
            <If when={props.timestamp}>
              <Text
                style={{
                  ...type.caption,
                  fontVariant: ['tabular-nums'],
                  color: token('tertiary-foreground'),
                }}
              >
                {props.timestamp}
              </Text>
            </If>
          </View>

          <Text
            style={{
              ...type.footnote,
              color: token('muted-foreground'),
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {props.sourceLine}
          </Text>

          <Text
            style={{
              ...type.headline,
              color: token('foreground'),
              numberOfLines: 2,
              textOverflow: 'ellipsis',
            }}
          >
            {props.title}
          </Text>

          <If when={props.detail}>
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                borderCurve: 'continuous',
                backgroundColor: token('grouped-bg'),
              }}
            >
              <Text
                style={{
                  ...(props.monospaceDetail ? type.mono : type.subheadline),
                  color: token('foreground'),
                  numberOfLines: 3,
                  textOverflow: 'ellipsis',
                }}
              >
                {props.detail}
              </Text>
            </View>
          </If>
        </View>

        <If when={props.onAllow || props.onDeny}>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
            <If when={props.onDeny && props.denyLabel}>
              <View style={{ flex: 1 }}>
                <ActionButton
                  title={props.denyLabel!}
                  variant="destructive"
                  compact
                  disabled={props.busy}
                  onPress={props.onDeny!}
                />
              </View>
            </If>
            <If when={props.onAllow && props.allowLabel}>
              <View style={{ flex: 1 }}>
                <ActionButton
                  title={props.allowLabel!}
                  variant="primary"
                  compact
                  disabled={props.busy}
                  onPress={props.onAllow!}
                />
              </View>
            </If>
          </View>
        </If>
      </View>
      <If when={props.divider}>
        <GroupDivider inset={spacing.pageX} />
      </If>
    </View>
  );
}
