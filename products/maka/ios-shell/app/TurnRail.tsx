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

import { Scroll, Text, View, signal } from 'nsh';
import { copy } from './copy';
import { Action, Panel } from './ui';

export interface TurnRailEntry {
  id: string;
  preview: string;
}

export function TurnRail(props: {
  turns: () => TurnRailEntry[];
  activeId: () => string | null;
  onJump: (turnId: string) => void;
}) {
  const open = signal(false);
  const select = (id: string) => {
    open.set(false);
    props.onJump(id);
  };
  return (
    <If when={props.turns().length >= 2}>
      <View class="absolute right-2 top-4">
        <Action title={copy('Turns', '轮次', '輪次')} onPress={() => open.set(true)} />
      </View>
      <Panel open={open()} close={() => open.set(false)}>
        <View class="flex-1 gap-2 p-4">
          <Action title={copy('Close', '关闭', '關閉')} onPress={() => open.set(false)} />
          <If when={props.activeId()}>
            <Action
              primary
              title={copy('Current turn', '当前轮次', '目前輪次')}
              onPress={() => {
                const id = props.activeId();
                if (id) select(id);
              }}
            />
          </If>
          <Scroll class="flex-1">
            <Each of={props.turns()} key={(turn) => turn.id}>
              {(turn) => (
                <View
                  role="button"
                  class="min-h-11 justify-center border-b border-border px-3 py-2"
                  accessibilityLabel={turn().preview}
                  onPress={() => select(turn().id)}
                >
                  <Text class="text-foreground" numberOfLines={2}>
                    {turn().preview}
                  </Text>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </Panel>
    </If>
  );
}
