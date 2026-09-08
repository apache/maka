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

import { useLayoutEffect, useRef } from "react";
import type { WorkHubControlSnapshot } from "../../../../shared/workhub-control.js";

export function AssistantCursor({
  cursor,
}: {
  cursor: NonNullable<WorkHubControlSnapshot["cursor"]>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const heading = useRef(-35);
  const previous = useRef({ x: cursor.x, y: cursor.y });
  const { x, y, durationMs = 0 } = cursor;

  useLayoutEffect(() => {
    const element = ref.current!;
    const from = previous.current;
    previous.current = { x, y };
    const translate = (px: number, py: number) => `translate(${px}px, ${py}px)`;
    element.style.transform = translate(x, y);
    if (!durationMs) return;

    const dx = x - from.x,
      dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    const arrow = headingRef.current!;
    const nearestAngle = (angle: number, previous: number) =>
      previous + ((((angle - previous + 180) % 360) + 360) % 360) - 180;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      heading.current = nearestAngle(
        (Math.atan2(dy, dx) * 180) / Math.PI,
        heading.current,
      );
      arrow.style.transform = `rotate(${heading.current}deg)`;
      return;
    }
    const nx = -dy / distance,
      ny = dx / distance;
    // Bend gently toward the viewport's center. No random jitter, overshoot,
    // or extra clicks: the control's verified center is always the endpoint.
    const inward =
      (innerWidth / 2 - (from.x + x) / 2) * nx +
      (innerHeight / 2 - (from.y + y) / 2) * ny;
    const bend = Math.min(56, distance * 0.12) * (inward < 0 ? -1 : 1);
    const control = (along: number, across: number) => ({
      x: Math.max(
        8,
        Math.min(innerWidth - 8, from.x + dx * along + nx * bend * across),
      ),
      y: Math.max(
        8,
        Math.min(innerHeight - 8, from.y + dy * along + ny * bend * across),
      ),
    });
    const a = control(0.3, 1),
      b = control(0.72, 0.55);
    const startHeading = heading.current;
    let tangent = startHeading;
    const headings: Keyframe[] = [];
    const keyframes = Array.from({ length: 61 }, (_, index) => {
      const time = index / 60;
      // Zero velocity and acceleration at either end; Chromium interpolates
      // these local frames without sending frame-by-frame IPC updates.
      const t = time ** 3 * (10 - 15 * time + 6 * time ** 2),
        u = 1 - t;
      const vx =
        3 * u ** 2 * (a.x - from.x) +
        6 * u * t * (b.x - a.x) +
        3 * t ** 2 * (x - b.x);
      const vy =
        3 * u ** 2 * (a.y - from.y) +
        6 * u * t * (b.y - a.y) +
        3 * t ** 2 * (y - b.y);
      tangent = nearestAngle((Math.atan2(vy, vx) * 180) / Math.PI, tangent);
      // Turn through the shortest angle while starting slowly, then follow
      // the curve's tangent. The tip stays at (0, 0) during rotation/stretch.
      const turn = Math.min(1, (time * durationMs) / 120);
      const angle =
        startHeading + (tangent - startHeading) * turn ** 2 * (3 - 2 * turn);
      const speed = 16 * time ** 2 * (1 - time) ** 2;
      headings.push({
        offset: time,
        transform: `rotate(${angle}deg) scale(${1 + 0.05 * speed}, ${1 - 0.03 * speed})`,
      });
      return {
        offset: time,
        transform: translate(
          u ** 3 * from.x +
            3 * u ** 2 * t * a.x +
            3 * u * t ** 2 * b.x +
            t ** 3 * x,
          u ** 3 * from.y +
            3 * u ** 2 * t * a.y +
            3 * u * t ** 2 * b.y +
            t ** 3 * y,
        ),
      };
    });
    heading.current = tangent;
    arrow.style.transform = `rotate(${tangent}deg)`;
    const timing = { duration: durationMs, easing: "linear" };
    const animations = [
      element.animate(keyframes, timing),
      arrow.animate(headings, timing),
    ];
    return () => animations.forEach((animation) => animation.cancel());
  }, [x, y, durationMs]);

  return (
    <div
      ref={ref}
      className={`desktopAssistantCursor ${cursor.clicking ? "isClicking" : ""}`}
      aria-hidden="true"
    >
      <div
        ref={headingRef}
        className="desktopAssistantCursorHeading"
        style={{ transform: "rotate(-35deg)" }}
      >
        <svg
          className="desktopAssistantCursorArrow"
          viewBox="-34 -20 48 40"
          fill="none"
        >
          <path
            d="M-1.5-2.5Q2.5 0-1.5 2.5L-22 13Q-26 15-25 10L-22 1Q-21.5 0-22-1L-25-10Q-26-15-22-13Z"
            fill="currentColor"
            stroke="white"
            strokeOpacity=".95"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
