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

import { cleanup, reduceMotion, signal, View, token, type JSX } from 'nsh';
import { tr } from '../locale';
import { motion, spacing } from '../theme/tokens';
import { GroupDivider, InsetGroup } from './InsetGroup';

function SkeletonBlock(props: { width: `${number}%`; height: number }) {
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: props.width,
        height: props.height,
        borderRadius: spacing.pillRadius,
        backgroundColor: token('surface-muted'),
      }}
    />
  );
}

function Skeleton(props: { children: JSX.Element }) {
  const visible = signal(false);
  const timer = setTimeout(() => visible.set(true), motion.fast);
  cleanup(() => clearTimeout(timer));

  return (
    <If when={visible()}>
      <View role="progressbar" accessibilityLabel={tr('Loading…')}>
        <View
          accessibilityElementsHidden
          style={{
            animationName: reduceMotion() ? 'none' : 'pulse',
            animationDuration: motion.skeletonPulse,
            animationTimingFunction: 'ease-in-out',
            animationIterationCount: 'infinite',
            animationFrameRate: 24,
          }}
        >
          {props.children}
        </View>
      </View>
    </If>
  );
}

export function ListSkeleton(props: { compact?: boolean }) {
  return (
    <Skeleton>
      <InsetGroup>
        {(['58%', '72%', '46%'] as const).map((width, index) => (
          <View>
            {index > 0 && <GroupDivider />}
            <View
              style={{
                minHeight: props.compact ? spacing.rowMinHeight : 70,
                justifyContent: 'center',
                paddingHorizontal: spacing.pageX,
                gap: 8,
              }}
            >
              <SkeletonBlock width={width} height={12} />
              <If when={!props.compact}>
                <SkeletonBlock width="34%" height={8} />
              </If>
            </View>
          </View>
        ))}
      </InsetGroup>
    </Skeleton>
  );
}

export function TranscriptSkeleton() {
  return (
    <Skeleton>
      <View style={{ gap: 20 }}>
        <View
          style={{
            alignSelf: 'flex-end',
            width: '48%',
            padding: 12,
            borderRadius: spacing.groupRadius,
            borderCurve: 'continuous',
            backgroundColor: token('inline-card'),
          }}
        >
          <SkeletonBlock width="84%" height={10} />
        </View>
        <View style={{ gap: 8 }}>
          <SkeletonBlock width="82%" height={11} />
          <SkeletonBlock width="69%" height={11} />
          <SkeletonBlock width="43%" height={11} />
        </View>
      </View>
    </Skeleton>
  );
}
