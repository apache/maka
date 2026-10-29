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

import { createAnimatedValue, reduceMotion, Text, View } from 'nsh';
import { tr } from './locale';
import { Icon } from './Icon';
import { C, captionTextStyle } from './ui';

// An image, files and a folder, fanned out as the kinds of things a drop takes.
const fan = [
  { name: 'image', rotate: '-14deg', lift: 0 },
  { name: 'copy', rotate: '0deg', lift: -6 },
  { name: 'folder', rotate: '14deg', lift: 0 },
] as const;

/** Covers the composer card while files dragged from another application are over the conversation. */
export function FileDropHint(props: { radius: number }) {
  // The icons rise into place each time a drag arrives.
  const rise = createAnimatedValue(reduceMotion() ? 0 : 12);
  if (!reduceMotion()) void rise.spring(0, { stiffness: 360, damping: 17 });
  return (
    <View
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: props.radius,
          backgroundColor: C.raised,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        },
        { pointerEvents: 'none' },
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 18,
          transform: [{ translateY: rise }],
        }}
      >
        {fan.map((icon) => (
          <View style={{ transform: [{ translateY: icon.lift }, { rotate: icon.rotate }] }}>
            <Icon name={icon.name} color={C.accent} size={28} />
          </View>
        ))}
      </View>
      <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Drop files here')}</Text>
    </View>
  );
}
