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

import { cleanup, createAnimatedValue, effect, reduceMotion, Text, token } from 'nsh';
import { tr } from '../locale';
import type { HostConnectionProgress } from '../state/hostPool';
import { motion, type } from '../theme/tokens';
import { ShimmerText } from './ThinkingMark';

export function ConnectionProgress(props: {
  kind: HostConnectionProgress;
  surface?: 'canvas' | 'glass';
}) {
  const text = () => (props.kind === 'reconnecting' ? tr('Reconnecting…') : tr('Connecting…'));
  return (
    <If
      when={props.surface === 'glass'}
      else={
        <ShimmerText
          text={text()}
          style={type.footnote}
          surface={props.surface === 'canvas' ? 'canvas' : undefined}
        />
      }
    >
      <GlassConnectionProgress text={text()} />
    </If>
  );
}

function GlassConnectionProgress(props: { text: string }) {
  const opacity = createAnimatedValue(1);
  effect(() => {
    if (reduceMotion()) return;
    void opacity.keyframes([1, 0.84, 1], {
      duration: motion.skeletonPulse,
      easing: 'easeInOut',
      iterations: 'infinite',
    });
    cleanup(() => opacity.stop());
  });
  return (
    <Text
      style={{
        ...type.footnote,
        numberOfLines: 1,
        color: token('glass-foreground'),
        opacity: reduceMotion() ? 1 : opacity,
      }}
    >
      {props.text}
    </Text>
  );
}
