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
 * The mark of a model at work keeps rebuilding itself: one stroke after another
 * lifts off, tumbles once around on a curved path that leaves on one side and
 * comes back from another, and settles into its place again, a little past it
 * first. A stroke is under way at every moment and the others stand, so the mark
 * is never gone and the loop has no start or end. Each stroke is a view the
 * native driver moves along sampled curves; nothing is drawn per frame.
 */
export const MARK_CYCLE = 4000;
export const MARK_SAMPLES = 80;
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

/**
 * Stroke `index` at `t` of a cycle that began at `phase` of the loop: its
 * offset, its turn and its opacity. The turn goes one way only, a full turn
 * a cycle, so neighbouring samples never unwind it; a full turn shows a stroke
 * as it was, which is what closes the loop where the cycle starts over.
 */
export function strokeAt(index: number, t: number, phase = 0) {
  const flight = MARK_FLIGHTS[index];
  const start = (((phase - 0.2 * flight.order) % 1) + 1) % 1;
  const cycles = Math.floor(t + start);
  const since = t + start - cycles;
  const turn = (flown: number) => flight.spin * 360 * (cycles + flown);
  if (since >= MARK_FLIGHT) return { x: 0, y: 0, turn: turn(1), opacity: 1 };
  const q = inOut(since / MARK_FLIGHT);
  // Out toward `to`, around, and back in from `from`: both weights are nothing
  // at the two ends, where the stroke is in its place.
  const lift = Math.sin(Math.PI * q);
  const out = lift * (1 - q);
  const back = lift * q;
  return {
    x: flight.to[0] * out + flight.from[0] * back,
    y: flight.to[1] * out + flight.from[1] * back,
    turn: turn(settling(since / MARK_FLIGHT)),
    opacity: 1 - 0.6 * lift,
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
  // window has three lines to show. It shows plain text, so the marks of bold,
  // code and headings are left out, as is half of a bold mark still arriving.
  const text = thought
    .trimEnd()
    .replace(/\*$/, '')
    .replace(/\*\*|`|^#{1,6} +/gm, '')
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
