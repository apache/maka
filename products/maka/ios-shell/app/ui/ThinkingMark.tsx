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

import { cleanup, createAnimatedValue, effect, reduceMotion, signal, Text, View, token } from 'nsh';

// Maka's mark as the five strokes it is drawn with, in its 16-unit box: the
// bar, the two sides of the peak and the two sides of the fold inside it.
export const MARK_STROKES: readonly [number, number, number, number][] = [
  [6.1, 1.3, 9.9, 1.3],
  [1.35, 14.35, 8, 3.55],
  [8, 3.55, 14.65, 14.35],
  [4.95, 8.5, 8, 13.6],
  [8, 13.6, 11.05, 8.5],
];
export const MARK_STROKE = 1.45;

/**
 * The mark of a model at work is taken apart and built again, over and over, in
 * depth: its strokes burst out of the mark one after another and fly off into
 * the distance, growing small and faint, then come back from far off on another
 * side, growing as they near, and land one by one, each a little too large
 * first, as a thing arriving does. Then the mark stands whole for a while. A
 * stroke far off is small, not gone, and the strokes are never all far at once,
 * so nothing blinks and the loop has no cut. Each stroke is a view the native
 * driver moves along sampled curves; nothing is drawn per frame.
 */
export const MARK_CYCLE = 4000;
export const MARK_SAMPLES = 120;
/** How long a stroke is under way, of the cycle. */
const MARK_FLIGHT = 0.52;
/** How long after the stroke before it a stroke lifts off, of the cycle. */
const MARK_STAGGER = 0.05;
/** How small a stroke is where it is farthest. */
const MARK_FAR = 0.18;
// Where each stroke leaves to and comes back from, in the mark's units, and
// which way it leans as it goes. None comes back from its own side.
const MARK_FLIGHTS: readonly {
  order: number;
  to: [number, number];
  from: [number, number];
  spin: 1 | -1;
}[] = [
  { order: 4, to: [7, -5], from: [-8, 6], spin: -1 },
  { order: 0, to: [-8, 3], from: [8, -6], spin: 1 },
  { order: 1, to: [8, 5], from: [-8, -6], spin: -1 },
  { order: 2, to: [-6, -7], from: [6, 8], spin: 1 },
  { order: 3, to: [6, -7], from: [-6, 8], spin: -1 },
];
const inOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/**
 * Stroke `index` at `t` of a cycle that began at `phase` of the loop: its
 * offset, its turn, its size and its opacity. The turn goes one way only, half
 * a turn a cycle, so neighbouring samples never unwind it; half a turn shows a
 * stroke as it was, which is what closes the loop where the cycle starts over.
 */
export function strokeAt(index: number, t: number, phase = 0) {
  const flight = MARK_FLIGHTS[index];
  const start = (((phase - MARK_STAGGER * flight.order) % 1) + 1) % 1;
  const cycles = Math.floor(t + start);
  const since = t + start - cycles;
  const turn = (flown: number) => flight.spin * 180 * (cycles + flown);
  if (since >= MARK_FLIGHT) return { x: 0, y: 0, turn: turn(1), scale: 1, opacity: 1 };
  const flown = since / MARK_FLIGHT;
  const q = inOut(flown);
  // Out toward `to`, around, and back in from `from`: both weights are nothing
  // at the two ends, where the stroke is in its place. `away` is how far off
  // it is, most in the middle of the flight.
  const away = Math.sin(Math.PI * q);
  const out = away * (1 - q);
  const back = away * q;
  // Arriving, it is a little larger than itself before it rests.
  const arriving = flown > 0.78 ? Math.sin((Math.PI * (flown - 0.78)) / 0.22) : 0;
  return {
    x: flight.to[0] * out + flight.from[0] * back,
    y: flight.to[1] * out + flight.from[1] * back,
    turn: turn(q),
    scale: 1 - (1 - MARK_FAR) * away + 0.16 * arriving,
    opacity: 1 - 0.85 * away,
  };
}

const MARK_ENTRANCE = 0.36;
/** How long after the last mark left a new one still carries its motion on, in ms. */
const MARK_CARRY = 400;
let markEpoch = 0;
let marksShown = 0;
let lastMarkGone = Number.NEGATIVE_INFINITY;
/**
 * Where in the loop a mark shown at `now` is. A mark that takes another's
 * place, as a step follows a step, carries the motion on; one that appears when
 * none was there starts with its strokes arriving, so it is seen to begin.
 * Returns the phase and what to call when the mark goes.
 */
export function markPhase(now: number): { phase: number; gone(at: number): void } {
  if (marksShown === 0 && now - lastMarkGone > MARK_CARRY)
    markEpoch = now - MARK_ENTRANCE * MARK_CYCLE;
  marksShown += 1;
  const phase = (((now - markEpoch) % MARK_CYCLE) + MARK_CYCLE) % MARK_CYCLE;
  return {
    phase: phase / MARK_CYCLE,
    gone(at) {
      marksShown -= 1;
      lastMarkGone = at;
    },
  };
}
export function ShimmerText(props: {
  text: string;
  style: object;
  surface?: 'grouped-bg' | 'surface';
}) {
  const width = signal(0);
  const sweep = createAnimatedValue(0);
  const still = () => reduceMotion();
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
  const surface = () => token(props.surface ?? 'grouped-bg').slice(0, 7);
  const veil = () => `${surface()}66`;
  return (
    <View
      style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden' }}
      onLayout={({ bounds }) => width.set(Math.round(bounds.size.width))}
    >
      <Text
        style={[
          { ...props.style, color: still() ? token('muted-foreground') : token('foreground') },
          { numberOfLines: 1 },
        ]}
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
              backgroundImage: `linear-gradient(90deg, ${veil()} 0%, ${veil()} 38%, ${surface()}00 50%, ${veil()} 62%, ${veil()} 100%)`,
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
  const still = () => reduceMotion();
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
  const unit = () => size() / 16;
  const inputRange = Array.from({ length: MARK_SAMPLES + 1 }, (_, at) => at / MARK_SAMPLES);
  const { phase, gone } = markPhase(Date.now());
  cleanup(() => gone(Date.now()));
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
                backgroundColor: token('foreground'),
                opacity: still() ? 1 : along((at) => at.opacity),
                transform: still()
                  ? [{ rotate: `${angle}deg` }]
                  : [
                      { translateX: along((at) => at.x * unit()) },
                      { translateY: along((at) => at.y * unit()) },
                      { rotate: along((at) => `${angle + at.turn}deg`) },
                      { scale: along((at) => at.scale) },
                    ],
              }}
            />
          );
        }}
      </Each>
    </View>
  );
}
