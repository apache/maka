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

import { cleanup, signal, Text, View } from 'nsh';
import { palette } from './theme';

export interface TurnRailEntry {
  id: string;
  preview: string;
}

/**
 * Right-edge minimalist Turn Navigation Rail mirroring Maka Desktop's TurnNavigation:
 * each horizontal tick represents a conversation turn; tapping any tick jumps straight
 * to that turn and reveals a brief floating preview pill.
 */
export function TurnRail(props: {
  turns: () => TurnRailEntry[];
  activeId: () => string | null;
  onJump: (turnId: string) => void;
}) {
  const previewLabel = signal<string | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  cleanup(() => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });

  const handleSelect = (entry: TurnRailEntry) => {
    props.onJump(entry.id);
    const trimmed = entry.preview.replace(/\s+/g, ' ').trim();
    if (trimmed.length > 0) {
      previewLabel.set(trimmed.length > 36 ? trimmed.slice(0, 36) + '…' : trimmed);
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        previewLabel.set(null);
        hideTimer = null;
      }, 1800);
    }
  };

  // Cap visible ticks cleanly on long histories while preserving start/end + active turn.
  const visibleTurns = (): TurnRailEntry[] => {
    const all = props.turns();
    if (all.length <= 28) return all;
    const step = (all.length - 1) / 27;
    const picked: TurnRailEntry[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 28; i++) {
      const item = all[Math.round(i * step)];
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        picked.push(item);
      }
    }
    return picked;
  };

  return (
    <If when={props.turns().length >= 2}>
      <View
        style={{
          position: 'absolute',
          right: 2,
          top: 16,
          bottom: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <If when={previewLabel() !== null}>
          <View
            style={{
              maxWidth: 210,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 10,
              backgroundColor: palette().surface2,
              borderWidth: 1,
              borderColor: palette().glassBorder,
            }}
          >
            <Text style={{ fontSize: 12.5, color: palette().ink }}>{previewLabel()}</Text>
          </View>
        </If>

        <View
          accessibilityLabel="Turn navigation rail"
          style={{
            width: 24,
            alignItems: 'flex-end',
            justifyContent: 'center',
            gap: 6,
            paddingRight: 3,
          }}
        >
          <Each of={visibleTurns()} key={(t) => t.id}>
            {(entry) => {
              const isActive = () => props.activeId() === entry().id;
              return (
                <View
                  role="button"
                  accessibilityLabel={'Jump to turn ' + entry().id}
                  onPress={() => handleSelect(entry())}
                  style={{
                    width: 22,
                    height: 12,
                    alignItems: 'flex-end',
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: isActive() ? 18 : 9,
                      height: isActive() ? 2.5 : 1.5,
                      borderRadius: 1.5,
                      backgroundColor: isActive() ? palette().ink : palette().ink3,
                    }}
                  />
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </If>
  );
}
