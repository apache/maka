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
import { glass } from './ui';

export const QUICK_REACTIONS = ['👍', '❤️', '🔥', '🎉', '🤯', '🤔'] as const;

export interface ReactionEntry {
  emoji: string;
  count: number;
  mine: boolean;
}

/** Floating reaction pill bar shown on message long-press / reaction trigger. */
export function ReactionPickerBar(props: {
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        ...glass,
      }}
    >
      <Each of={[...QUICK_REACTIONS]} key={(e) => e}>
        {(item) => (
          <View
            role="button"
            accessibilityLabel={'React ' + item()}
            onPress={() => props.onPick(item())}
            style={{
              minWidth: 38,
              minHeight: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 21 }}>{item()}</Text>
          </View>
        )}
      </Each>
      <View
        role="button"
        accessibilityLabel="Close reaction picker"
        onPress={props.onDismiss}
        style={{
          minWidth: 34,
          minHeight: 34,
          borderRadius: 17,
          backgroundColor: token('muted'),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 13, color: token('muted-foreground') }}>✕</Text>
      </View>
    </View>
  );
}

/** Compact reaction pills beneath a message, including subtle Agent reactions. */
export function ReactionPillsRow(props: {
  reactions: ReactionEntry[];
  onToggle: (emoji: string) => void;
}) {
  return (
    <If when={props.reactions.length > 0}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          marginTop: 6,
        }}
      >
        <Each of={props.reactions} key={(r) => r.emoji}>
          {(entry) => (
            <View
              role="button"
              accessibilityLabel={'Toggle reaction ' + entry().emoji}
              onPress={() => props.onToggle(entry().emoji)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 9,
                paddingVertical: 4,
                borderRadius: 14,
                backgroundColor: entry().mine ? token('accent-soft') : token('muted'),
                borderWidth: 1,
                borderColor: entry().mine ? token('accent') : token('border'),
              }}
            >
              <Text style={{ fontSize: 13 }}>{entry().emoji}</Text>
              <If when={entry().count > 1}>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '600',
                    color: entry().mine ? token('accent') : token('muted-foreground'),
                  }}
                >
                  {String(entry().count)}
                </Text>
              </If>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
