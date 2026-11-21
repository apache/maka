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

// Astryx's descendant selectors under ancestor :hover cause document-wide
// style invalidation even when no Astryx component matches the selector.
// The companion dependency patch uses this marker instead of ancestor :hover.
const hoverRoots = '.x1odsvnm, .x84s7jz, .x1iwu4tg, .x-default-marker, .x1u3b27q, th';

function setHoverMarker(event: PointerEvent, active: boolean): void {
  if (event.pointerType === 'touch') return;
  const target = event.target;
  if (target instanceof Element && target.matches(hoverRoots)) {
    target.toggleAttribute('data-astryx-hover', active);
  }
}

// pointerenter/leave do not bubble, but capture reaches the relevant root
// once on entry/exit. Movement across transcript descendants changes no marker.
document.addEventListener('pointerenter', (event) => setHoverMarker(event, true), true);
document.addEventListener('pointerleave', (event) => setHoverMarker(event, false), true);
