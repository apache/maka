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

import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { UiContext } from '@maka-agent/plugin-sdk';

export function activate(context: UiContext) {
  const restored = context.restored;
  if (restored !== null && typeof restored !== 'number') throw Error('Invalid counter state');
  const count = signal(restored ?? 0);
  function Counter() {
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Text>Count {count()}</Text>
        <Button onPress={() => count.set(count() + 1)}>
          <Text>Increment</Text>
        </Button>
      </View>
    );
  }
  return {
    exports: {
      root: { kind: 'root', render: Counter },
      counter: { kind: 'panel', render: Counter },
      openCounter: {
        kind: 'command',
        run() {
          context.openPanel('counter');
        },
      },
    },
    async prepareReload() {
      return count();
    },
  };
}
