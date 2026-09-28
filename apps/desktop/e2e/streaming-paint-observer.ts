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

export interface StreamingPaintObservation {
  texts: string[];
  maxActiveAnimations: number;
}

interface InstalledStreamingPaintObservation extends StreamingPaintObservation {
  stop(): void;
}

declare global {
  interface Window {
    __makaBackgroundRestoreObserved?: InstalledStreamingPaintObservation;
  }
}

/** Install a paint-clock sampler inside the browser under test. */
export function installStreamingPaintObserver(): void {
  const observed: InstalledStreamingPaintObservation = {
    texts: [],
    maxActiveAnimations: 0,
    stop() {},
  };
  let stopped = false;
  const sample = () => {
    if (stopped) return;
    const bubbles = [
      ...document.querySelectorAll<HTMLElement>(".maka-bubble-streaming"),
    ];
    const bubble = bubbles.at(-1);
    if (bubble) {
      const text = bubble.textContent ?? "";
      if (observed.texts.at(-1) !== text) observed.texts.push(text);
      observed.maxActiveAnimations = Math.max(
        observed.maxActiveAnimations,
        ...bubbles.map(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState !== "finished").length,
        ),
      );
    }
    window.requestAnimationFrame(sample);
  };
  observed.stop = () => {
    stopped = true;
  };
  window.__makaBackgroundRestoreObserved = observed;
  window.requestAnimationFrame(sample);
}

/** Stop after one final painted frame and return a serializable snapshot. */
export function stopStreamingPaintObserver(): Promise<
  StreamingPaintObservation | undefined
> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      const observed = window.__makaBackgroundRestoreObserved;
      observed?.stop();
      resolve(
        observed
          ? {
              texts: observed.texts,
              maxActiveAnimations: observed.maxActiveAnimations,
            }
          : undefined,
      );
    });
  });
}
