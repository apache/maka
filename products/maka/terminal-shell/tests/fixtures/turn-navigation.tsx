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
import { TurnNavigation } from '../../app/TurnNavigation';
import { uiScale } from '../../app/uiScale';

const colors = ['#161719', '#17181a', '#18191b', '#191a1c'];
const stage = signal(0);
[100, 80, 50, 200].forEach((percent, index) => {
  keymap.bind(
    `mod+${index + 1}`,
    () => {
      uiScale.preview(String(percent));
      stage.set(index);
    },
    { when: 'always' },
  );
});
const items = Array.from({ length: 6 }, (_, index) => ({
  turnId: `turn-${index}`,
  label: `Prompt ${index}`,
  anchor: { kind: 'loaded' as const, position: { sourceSequence: index, itemIndex: 0 } },
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
      navigate={(item) => Clipboard.writeText(item.turnId)}
      cancel={() => {}}
    />
  </View>
));
