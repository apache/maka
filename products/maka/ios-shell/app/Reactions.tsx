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

import { Canvas, cleanup, createAnimatedValue, Easing, signal, Text, View } from 'nsh';
import { palette } from './theme';

export const QUICK_REACTIONS = ['👍', '❤️', '🔥', '🎉', '🤯', '🤔'] as const;

export interface ReactionEntry {
  emoji: string;
  count: number;
  mine: boolean;
  fromAgent?: boolean;
}

const BURST_COLORS: Record<string, string[]> = {
  '❤️': ['#FF5E7E', '#FF8FA3', '#FFB3C1'],
  '🔥': ['#FF8A3D', '#FFB74D', '#FFE082'],
  '🎉': ['#5C8DFF', '#FF70A6', '#FFD166', '#34C77B'],
  '🤯': ['#A78BFA', '#60A5FA', '#F472B6'],
  '👍': ['#5C8DFF', '#8AB4FF', '#C3D8FF'],
  '🤔': ['#F0A83A', '#F6C873', '#D8A95C'],
};

export interface BurstController {
  active: () => boolean;
  emoji: () => string;
  trigger: (emoji: string) => void;
  progress: () => number;
}

export function createBurstController(): BurstController {
  const active = signal(false);
  const emoji = signal('❤️');
  const anim = createAnimatedValue(0);
  const frame = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  cleanup(() => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  const trigger = (nextEmoji: string) => {
    emoji.set(nextEmoji);
    active.set(true);
    anim.set(0);
    anim.timing(1, { duration: 480, easing: Easing.out(Easing.cubic) });
    frame.set(0);
    if (timer !== null) clearInterval(timer);
    let step = 0;
    timer = setInterval(() => {
      step += 1;
      const p = Math.min(1, step / 16);
      frame.set(p);
      if (p >= 1) {
        if (timer !== null) clearInterval(timer);
        timer = null;
        active.set(false);
      }
    }, 30);
  };

  return {
    active,
    emoji,
    trigger,
    progress: frame,
  };
}

/** Localized Telegram-style 120pt-radius Canvas burst rendered on reaction tap. */
export function ReactionBurstLayer(props: { burst: BurstController }) {
  return (
    <If when={props.burst.active()}>
      <View
        style={{
          position: 'absolute',
          top: 90,
          left: 0,
          right: 0,
          height: 150,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Canvas
          style={{ width: 240, height: 150 }}
          draw={(cx, { width, height }) => {
            const p = props.burst.progress();
            const colors = BURST_COLORS[props.burst.emoji()] ?? BURST_COLORS['👍'];
            const originX = width / 2;
            const originY = height / 2;
            const particles = 14;
            for (let i = 0; i < particles; i++) {
              const angle = (i / particles) * Math.PI * 2 + (i % 2) * 0.18;
              const radius = (26 + (i % 4) * 18) * p;
              const x = originX + Math.cos(angle) * radius;
              const y =
                originY + Math.sin(angle) * radius - (props.burst.emoji() === '🔥' ? p * 22 : 0);
              const size = Math.max(1.5, (1 - p) * (4.5 + (i % 3)));
              cx.fillStyle = colors[i % colors.length];
              cx.globalAlpha = Math.max(0, 1 - p * 1.15);
              cx.beginPath();
              cx.arc(x, y, size, 0, Math.PI * 2);
              cx.fill();
            }
            cx.globalAlpha = 1;
          }}
        />
      </View>
    </If>
  );
}

/** Floating reaction pill bar shown on message long-press / reaction trigger. */
export function ReactionPickerBar(props: {
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}) {
  const c = palette();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 24,
        backgroundColor: c.glassBg,
        borderWidth: 1,
        borderColor: c.glassBorder,
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
          backgroundColor: c.surfaceRaised,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontSize: 13, color: c.ink2 }}>✕</Text>
      </View>
    </View>
  );
}

/** Compact reaction pills beneath a message, including subtle Agent reactions. */
export function ReactionPillsRow(props: {
  reactions: ReactionEntry[];
  onToggle: (emoji: string) => void;
  onRetryWithNewIdea?: () => void;
}) {
  const c = palette();
  const showWhisperRetry = () =>
    props.reactions.some((r) => r.mine && (r.emoji === '🤔' || r.emoji === '👎'));
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
                backgroundColor: entry().mine ? c.accentSoft : c.surfaceRaised,
                borderWidth: 1,
                borderColor: entry().mine ? c.accent : c.line,
              }}
            >
              <Text style={{ fontSize: 13 }}>{entry().emoji}</Text>
              <If when={entry().count > 1}>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '600',
                    color: entry().mine ? c.accent : c.ink2,
                  }}
                >
                  {String(entry().count)}
                </Text>
              </If>
            </View>
          )}
        </Each>
        <If when={showWhisperRetry() && !!props.onRetryWithNewIdea}>
          <View
            role="button"
            accessibilityLabel="Retry with a different approach"
            onPress={() => props.onRetryWithNewIdea && props.onRetryWithNewIdea()}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 14,
              backgroundColor: c.surfaceRaised,
              borderWidth: 1,
              borderColor: c.line,
            }}
          >
            <Text style={{ fontSize: 12, color: c.ink2 }}>换个思路重试</Text>
          </View>
        </If>
      </View>
    </If>
  );
}
