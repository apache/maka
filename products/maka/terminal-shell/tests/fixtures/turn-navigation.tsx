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

import { mount, signal, View } from 'nsh';
import { Clipboard } from 'nsh';
import { keymap } from 'nsh';
import { TurnNavigation, type TurnNavigationItem } from '../../../workbench/app/TurnNavigation';

const colors = ['#161719', '#17181a', '#18191b', '#191a1c'];
const stage = signal(0);
colors.forEach((_, index) => {
  keymap.bind(
    `mod+${index + 1}`,
    () => {
      stage.set(index);
    },
    { when: 'always' },
  );
});
const items: TurnNavigationItem[] = Array.from({ length: 6 }, (_, index) => ({
  turnKey: `turn-${index}`,
  order: { path: [index + 1], itemIndex: 0 },
  label: `Prompt ${index}`,
  anchor: {
    kind: 'loaded',
    position: {
      kind: 'live',
      sequence: index + 1,
      itemIndex: 0,
      fact: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    },
  },
}));
mount(() => (
  <View
    style={{
      flex: 1,
      backgroundColor: colors[stage()],
      flexDirection: 'row',
      justifyContent: 'flex-end',
    }}
  >
    <TurnNavigation
      items={() => items}
      active={() => null}
      busy={() => null}
      navigate={(item) => Clipboard.writeText(item.turnKey)}
      cancel={() => {}}
    />
  </View>
));
