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

const PEEK_TAIL = 480;
/**
 * The end of a thought, which is all its window lays out. It is cut where a
 * paragraph starts, or else in long steps: a cut that moved with every word
 * would wrap the lines in view anew each time.
 */
export function thoughtTail(thought: string) {
  // Paragraphs follow one another without the empty line between them: the
  // window has three lines to show. Inline code keeps its content intact while
  // bold, heading marks and a trailing lone `*` (half of a bold mark arriving)
  // are left out.
  const text = thought
    .trimEnd()
    .replace(/`([^`\n]*)`?|\*\*|^#{1,6} +|\*(?![\s\S])/gm, (_, code) => code ?? '')
    .replace(/\n\s*\n/g, '\n');
  if (text.length <= PEEK_TAIL) return text;
  const paragraph = text.lastIndexOf('\n', text.length - PEEK_TAIL);
  if (paragraph >= 0 && text.length - paragraph <= PEEK_TAIL * 1.5)
    return text.slice(paragraph + 1);
  const step = PEEK_TAIL / 2;
  const cut = text.slice(Math.floor((text.length - PEEK_TAIL) / step) * step);
  const space = cut.search(/\s/);
  return space >= 0 && space < 80 ? cut.slice(space + 1) : cut;
}

const FRESH = 4;
/**
 * The text of a thought's window as what has been there a while and its newest
 * few words, newest last, which are drawn lighter the newer they are: a word
 * comes in faint and darkens as others follow it. A word is a run without
 * spaces, or a pair of characters where the script has no spaces.
 */
export function freshWords(text: string): { settled: string; fresh: string[] } {
  const words =
    text.match(/[\u2e80-\u9fff\uf900-\uffef]{1,2}\s*|[^\s\u2e80-\u9fff\uf900-\uffef]+\s*|\s+/g) ??
    [];
  const fresh = words.slice(-FRESH);
  return { settled: words.slice(0, -FRESH).join(''), fresh };
}

/** Where in the loop a mark comes into being: its strokes far off, about to arrive. */
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
