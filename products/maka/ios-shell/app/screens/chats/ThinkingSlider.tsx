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

import { keymap, Scroll, Text, View, token } from 'nsh';
import { Slider } from 'nsh/base';
import { thinkingLevelLabel, tr } from '../../locale';
import { spacing, type } from '../../theme/tokens';
import { glassSurfaceStyle } from '../../ui';

export function ThinkingSlider(props: {
  stops: readonly (string | null)[];
  value: string | null;
  disabled: boolean;
  maxHeight: number;
  horizontal: boolean;
  onChange: (level: string | null) => void;
  onCommit: (level: string | null) => void;
  onClose: () => void;
}) {
  keymap.bind('escape', props.onClose, { when: 'always' });
  const label = (level: string | null) =>
    level === null ? tr('Default') : thinkingLevelLabel(level);
  return (
    <Scroll
      testID="chat-thinking-slider"
      keyboardShouldPersistTaps="always"
      style={{ ...glassSurfaceStyle(22), width: '100%', maxWidth: 680, maxHeight: props.maxHeight }}
    >
      <View
        style={{
          paddingHorizontal: 8,
          flexDirection: props.horizontal ? 'row' : 'column',
          alignItems: props.horizontal ? 'center' : 'stretch',
          gap: props.horizontal ? 12 : 0,
        }}
      >
        <Slider
          min={0}
          max={props.stops.length - 1}
          step={1}
          value={Math.max(0, props.stops.indexOf(props.value))}
          accessibilityLabel={tr('Thinking level') + ' · ' + label(props.value)}
          disabled={props.disabled}
          style={props.horizontal ? { flex: 1, minWidth: 120 } : undefined}
          trackStyle={{
            height: spacing.rowMinHeight,
            paddingHorizontal: 22,
            justifyContent: 'center',
          }}
          indicatorStyle={{
            height: 5,
            borderRadius: 3,
            backgroundColor: token('glass-slider-track'),
          }}
          rangeStyle={{ borderRadius: 3, backgroundColor: token('glass-accent') }}
          thumbClass="focus-visible:ring-2"
          thumbStyle={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: token('glass-slider-thumb'),
            borderColor: token('surface'),
            borderWidth: 2,
          }}
          onChange={({ value }) => {
            if (typeof value === 'number') props.onChange(props.stops[value]!);
          }}
          onChangeEnd={({ value }) => {
            if (typeof value === 'number') props.onCommit(props.stops[value]!);
          }}
        />
        <View
          style={{
            flex: props.horizontal ? 2 : undefined,
            flexDirection: 'row',
            flexWrap: 'wrap',
          }}
        >
          <Each of={props.stops} key={(level) => level ?? ''}>
            {(level) => (
              <View
                role="button"
                accessibilityLabel={label(level())}
                accessibilityState={{ selected: props.value === level() }}
                disabled={props.disabled}
                onPress={() => props.onCommit(level())}
                activeStyle={{ backgroundColor: token('glass-action-pressed-bg') }}
                style={{
                  flexGrow: 1,
                  minWidth: spacing.rowMinHeight,
                  minHeight: spacing.rowMinHeight,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                  paddingHorizontal: 5,
                  backgroundColor:
                    props.value === level() ? token('glass-action-bg') : 'transparent',
                }}
              >
                <Text
                  style={{
                    ...type.caption,
                    fontWeight: props.value === level() ? '700' : '500',
                    color: token('glass-foreground'),
                    textAlign: 'center',
                  }}
                >
                  {label(level())}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </Scroll>
  );
}
