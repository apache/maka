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

import {
  cleanup,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  signal,
  Text,
  View,
} from 'nsh';
import { appearance } from './appearance';
import { tr } from './locale';
import {
  MARK_CYCLE,
  MARK_SAMPLES,
  MARK_STROKE,
  MARK_STROKES,
  strokeAt,
  thoughtTail,
} from './thinkingMark';
import { C, captionTextStyle } from './ui';
import { Icon } from './Icon';

export function LoadingIndicator(props: { label?: string; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label ?? tr('Loading…')}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <If when={platform.idiom === 'terminal'}>
        <Text
          accessibilityElementsHidden
          style={{ color: props.color ?? C.muted, lineHeight: size }}
        >
          ◌
        </Text>
      </If>
      <If when={platform.idiom !== 'terminal'}>
        <View
          accessibilityElementsHidden
          style={{
            width: size,
            height: size,
            animationName: reduceMotion() ? 'none' : 'spin',
            animationDuration: 800,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
            animationFrameRate: 30,
          }}
        >
          <Icon name="loader" size={size} color={props.color ?? C.muted} />
        </View>
      </If>
    </View>
  );
}

export function LoadingState(props: { label?: string }) {
  return (
    <View
      style={{
        flex: 1,
        minHeight: 48,
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <LoadingIndicator size={24} label={props.label} />
      <If when={platform.idiom === 'terminal'}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{props.label ?? tr('Loading…')}</Text>
      </If>
    </View>
  );
}

/**
 * What is happening right now, with a band of light passing over it. The
 * text is drawn bright and a dimming veil of the panel's color slides across
 * it with a clear gap, so only the content's background may sit behind it.
 */
export function ShimmerText(props: { text: string; style: object }) {
  const width = signal(0);
  const sweep = createAnimatedValue(0);
  const still = () => platform.idiom === 'terminal' || reduceMotion();
  effect(() => {
    const span = width();
    if (still() || span === 0) return;
    sweep.set(-2 * span);
    void sweep.keyframes([-2 * span, 0], {
      duration: 1400 + span * 2,
      easing: 'linear',
      iterations: 'infinite',
      frameRate: 30,
    });
    cleanup(() => sweep.stop());
  });
  const veil = () => `${C.panel}66`;
  return (
    <View
      style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}
      onLayout={({ bounds }) => width.set(Math.round(bounds.size.width))}
    >
      <Text
        style={[{ ...props.style, color: still() ? C.secondary : C.text }, { numberOfLines: 1 }]}
      >
        {props.text}
      </Text>
      <If when={!still() && width() > 0}>
        <View
          accessibilityElementsHidden
          style={[
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: 3 * width(),
              backgroundImage: `linear-gradient(90deg, ${veil()} 0%, ${veil()} 38%, ${C.panel}00 50%, ${veil()} 62%, ${veil()} 100%)`,
              transform: [{ translateX: sweep }],
            },
            { pointerEvents: 'none' },
          ]}
        />
      </If>
    </View>
  );
}

export function ThinkingMark(props: { size?: number }) {
  const size = () => props.size ?? 16;
  const cycle = createAnimatedValue(0);
  const still = () => platform.idiom === 'terminal' || reduceMotion();
  effect(() => {
    if (still()) return;
    void cycle.keyframes([0, 1], {
      duration: MARK_CYCLE,
      easing: 'linear',
      iterations: 'infinite',
      frameRate: 60,
    });
    cleanup(() => cycle.stop());
  });
  if (platform.idiom === 'terminal') return <Icon name="thinking" color={C.text} />;
  const unit = () => size() / 16;
  const inputRange = Array.from({ length: MARK_SAMPLES + 1 }, (_, at) => at / MARK_SAMPLES);
  // Every mark is at the place in the loop the clock gives, so one that takes
  // another's place, as a step follows a step, carries the motion on.
  const phase = (Date.now() % MARK_CYCLE) / MARK_CYCLE;
  return (
    <View
      accessibilityElementsHidden
      style={[{ width: size(), height: size(), flexShrink: 0 }, { pointerEvents: 'none' }]}
    >
      <Each
        of={MARK_STROKES.map((stroke, index) => ({ stroke, index }))}
        key={(item) => item.index}
      >
        {(item) => {
          const [x1, y1, x2, y2] = item().stroke;
          const length = Math.hypot(x2 - x1, y2 - y1) + MARK_STROKE;
          const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          const samples = inputRange.map((t) => strokeAt(item().index, t, phase));
          const along = (output: (at: (typeof samples)[number]) => number | string) =>
            cycle.interpolate({ inputRange, outputRange: samples.map(output) as number[] });
          return (
            <View
              style={{
                position: 'absolute',
                left: (cx - length / 2) * unit(),
                top: (cy - MARK_STROKE / 2) * unit(),
                width: length * unit(),
                height: MARK_STROKE * unit(),
                borderRadius: (MARK_STROKE / 2) * unit(),
                backgroundColor: C.text,
                opacity: still() ? 1 : along((at) => at.opacity),
                transform: still()
                  ? [{ rotate: `${angle}deg` }]
                  : [
                      { translateX: along((at) => at.x * unit()) },
                      { translateY: along((at) => at.y * unit()) },
                      { rotate: along((at) => `${angle + at.turn}deg`) },
                    ],
              }}
            />
          );
        }}
      </Each>
    </View>
  );
}

const PEEK_LINE = 20;
const PEEK_LINES = 3;

/**
 * The last lines of what a model is thinking, while it thinks: a window of
 * three lines that the text passes through, fading out at its top and bottom.
 * Only the content's background may sit behind it.
 */
export function ThinkingPeek(props: { text(): string }) {
  const shown = createAnimatedValue(reduceMotion() ? 1 : 0);
  if (!reduceMotion()) void shown.timing(1, { duration: 220 });
  // New lines push the text up; it slides there instead of jumping.
  const pushed = createAnimatedValue(0);
  let height = 0;
  cleanup(() => {
    shown.stop();
    pushed.stop();
  });
  const tail = () => thoughtTail(props.text());
  // Text grows with the window's text size, and the window with it.
  const line = () => PEEK_LINE * appearance.textSize();
  const fade = (from: string, to: string) => `linear-gradient(180deg, ${from} 0%, ${to} 100%)`;
  return (
    <View
      style={{
        height: line() * PEEK_LINES + 6,
        paddingBottom: 6,
        marginTop: 4,
        marginLeft: 24,
        overflow: 'hidden',
        justifyContent: 'flex-end',
        opacity: shown,
      }}
    >
      <View
        style={{ transform: [{ translateY: pushed }] }}
        onLayout={({ bounds }) => {
          const grown = bounds.size.height - height;
          height = bounds.size.height;
          if (grown <= 0 || grown > line() * PEEK_LINES || reduceMotion()) return;
          pushed.set(grown);
          void pushed.timing(0, { duration: 260, easing: 'easeOut' });
        }}
      >
        <Text
          style={[
            { ...captionTextStyle, lineHeight: PEEK_LINE, color: C.muted },
            { userSelect: 'none' },
          ]}
        >
          {tail()}
        </Text>
      </View>
      <View
        accessibilityElementsHidden
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: line() * 1.5,
            backgroundImage: fade(C.panel, `${C.panel}00`),
          },
          { pointerEvents: 'none' },
        ]}
      />
      <View
        accessibilityElementsHidden
        style={[
          {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 10,
            backgroundImage: fade(`${C.panel}00`, C.panel),
          },
          { pointerEvents: 'none' },
        ]}
      />
    </View>
  );
}
