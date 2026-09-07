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

import { useLayoutEffect, useRef } from 'react';
import { MousePointer2 } from '@maka/ui/icons';
import type { DesktopAssistantSnapshot } from '../../../shared/desktop-assistant.js';

export function AssistantCursor({ cursor }: { cursor: NonNullable<DesktopAssistantSnapshot['cursor']> }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef({ x: cursor.x, y: cursor.y });
  const { x, y, durationMs = 0 } = cursor;

  useLayoutEffect(() => {
    const element = ref.current!;
    const from = previous.current;
    previous.current = { x, y };
    const translate = (px: number, py: number) => `translate(${px}px, ${py}px)`;
    element.style.transform = translate(x, y);
    if (!durationMs || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const dx = x - from.x, dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    const nx = -dy / distance, ny = dx / distance;
    // Bend gently toward the viewport's center. No random jitter, overshoot,
    // or extra clicks: the control's verified center is always the endpoint.
    const inward = (innerWidth / 2 - (from.x + x) / 2) * nx + (innerHeight / 2 - (from.y + y) / 2) * ny;
    const bend = Math.min(56, distance * 0.12) * (inward < 0 ? -1 : 1);
    const control = (along: number, across: number) => ({
      x: Math.max(8, Math.min(innerWidth - 8, from.x + dx * along + nx * bend * across)),
      y: Math.max(8, Math.min(innerHeight - 8, from.y + dy * along + ny * bend * across)),
    });
    const a = control(0.3, 1), b = control(0.72, 0.55);
    const keyframes = Array.from({ length: 61 }, (_, index) => {
      const time = index / 60;
      // Zero velocity and acceleration at either end; Chromium interpolates
      // these local frames without sending frame-by-frame IPC updates.
      const t = time ** 3 * (10 - 15 * time + 6 * time ** 2), u = 1 - t;
      return { offset: time, transform: translate(
        u ** 3 * from.x + 3 * u ** 2 * t * a.x + 3 * u * t ** 2 * b.x + t ** 3 * x,
        u ** 3 * from.y + 3 * u ** 2 * t * a.y + 3 * u * t ** 2 * b.y + t ** 3 * y,
      ) };
    });
    const animation = element.animate(keyframes, { duration: durationMs, easing: 'linear' });
    return () => animation.cancel();
  }, [x, y, durationMs]);

  return <div ref={ref} className={`desktopAssistantCursor ${cursor.clicking ? 'isClicking' : ''}`} aria-hidden="true">
    <MousePointer2 size={25} fill="currentColor" /><span>Maka</span>
  </div>;
}
