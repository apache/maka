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
import { tr } from './locale';
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

// Maka's mark as the five strokes it is drawn with, in its 16-unit box: the
// bar, the two sides of the peak and the two sides of the fold inside it.
const MARK_STROKES: readonly [number, number, number, number][] = [
  [6.1, 1.3, 9.9, 1.3],
  [1.35, 14.35, 8, 3.55],
  [8, 3.55, 14.65, 14.35],
  [4.95, 8.5, 8, 13.6],
  [8, 13.6, 11.05, 8.5],
];
const MARK_STROKE = 1.45;

/**
 * The mark of a model at work keeps rebuilding itself: one stroke after another
 * lifts off, tumbles once around on a curved path that leaves on one side and
 * comes back from another, and settles into its place again, a little past it
 * first. A stroke is under way at every moment and the others stand, so the mark
 * is never gone and the loop has no start or end. Each stroke is a view the
 * native driver moves along sampled curves; nothing is drawn per frame.
 */
const MARK_CYCLE = 4000;
const MARK_SAMPLES = 80;
/** How long a stroke is under way, of the cycle. */
const MARK_FLIGHT = 0.36;
// Where each stroke leaves to and comes back from, in the mark's units, and
// which way it tumbles. None comes back from its own side.
const MARK_FLIGHTS: readonly {
  order: number;
  to: [number, number];
  from: [number, number];
  spin: 1 | -1;
}[] = [
  { order: 4, to: [9, -3], from: [-9, 7], spin: -1 },
  { order: 0, to: [-8, 5], from: [10, -6], spin: 1 },
  { order: 1, to: [8, 6], from: [-10, -6], spin: -1 },
  { order: 2, to: [-6, -8], from: [7, 9], spin: 1 },
  { order: 3, to: [6, -8], from: [-7, 9], spin: -1 },
];
const inOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
// Comes to rest as on a spring: about 9% past, then home.
const settling = (t: number) => {
  const s = 1.9;
  const u = t - 1;
  return 1 + (s + 1) * u ** 3 + s * u ** 2;
};

/** Stroke `index` at `t` of the cycle: its offset, its turn and its opacity. */
function strokeAt(index: number, t: number) {
  const flight = MARK_FLIGHTS[index];
  const since = (((t - 0.2 * flight.order) % 1) + 1) % 1;
  if (since >= MARK_FLIGHT) return { x: 0, y: 0, turn: 0, opacity: 1 };
  const q = inOut(since / MARK_FLIGHT);
  // Out toward `to`, around, and back in from `from`: both weights are nothing
  // at the two ends, where the stroke is in its place.
  const lift = Math.sin(Math.PI * q);
  const out = lift * (1 - q);
  const back = lift * q;
  return {
    x: flight.to[0] * out + flight.from[0] * back,
    y: flight.to[1] * out + flight.from[1] * back,
    // A full turn shows a stroke as it was, so the loop closes.
    turn: flight.spin * 360 * settling(since / MARK_FLIGHT),
    opacity: 1 - 0.6 * lift,
  };
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
          const samples = inputRange.map((t) => strokeAt(item().index, t + phase));
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
const PEEK_TAIL = 480;

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
  // The window shows the end of the text, so only its end is laid out. It is
  // cut where a paragraph starts, or else in long steps: a cut that moved with
  // every word would wrap the lines in view anew each time.
  const tail = () => {
    // Paragraphs follow one another without the empty line between them: the
    // window has three lines to show.
    const text = props
      .text()
      .trimEnd()
      .replace(/\n\s*\n/g, '\n');
    if (text.length <= PEEK_TAIL) return text;
    const paragraph = text.lastIndexOf('\n', text.length - PEEK_TAIL);
    if (paragraph >= 0) return text.slice(paragraph + 1);
    const step = PEEK_TAIL / 2;
    const cut = text.slice(Math.floor((text.length - PEEK_TAIL) / step) * step);
    const space = cut.search(/\s/);
    return space >= 0 && space < 80 ? cut.slice(space + 1) : cut;
  };
  const fade = (from: string, to: string) => `linear-gradient(180deg, ${from} 0%, ${to} 100%)`;
  return (
    <View
      style={{
        height: PEEK_LINE * PEEK_LINES + 6,
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
          if (grown <= 0 || grown > PEEK_LINE * PEEK_LINES || reduceMotion()) return;
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
            height: PEEK_LINE * 1.5,
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
