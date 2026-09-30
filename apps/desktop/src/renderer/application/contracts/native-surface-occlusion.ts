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

/** Native child views sit above DOM top-layer content, regardless of z-index. */
export function isNativeSurfaceOccluded(rect: DOMRect, document: Document): boolean {
  return Array.from(document.querySelectorAll(':popover-open:not(:empty), dialog[open]')).some((overlay) => {
    if (overlay.matches(':modal')) return true;
    const bounds = overlay.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.left < rect.right && bounds.right > rect.left && bounds.top < rect.bottom && bounds.bottom > rect.top;
  });
}

export interface NativeSurfaceWatch {
  /** Re-run `sync` next frame for a change the watch cannot observe. */
  refresh(): void;
  dispose(): void;
}

/**
 * Runs `sync` in a frame after the element's box or an overlay above it may
 * have changed. With no overlay open, everything arrives through events and
 * observers, so an idle surface costs nothing. An open overlay can move or
 * resize with no event at all (text, attributes, anchor positioning), so
 * frames are sampled for as long as one is open.
 */
export function watchNativeSurface(element: HTMLElement, sync: () => void): NativeSurfaceWatch {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  let frame = 0;
  let moveKey = '';
  let move: IntersectionObserver | undefined;
  let emptyOverlays: Element[] = [];
  // The toast viewport stays open while empty, and no toggle fires when a
  // toast fills it.
  const filled = new view.MutationObserver(() => refresh());
  const overlayOpen = () => {
    const open = Array.from(document.querySelectorAll(':popover-open, dialog[open]'));
    const empty = open.filter((overlay) => overlay.matches(':empty'));
    if (empty.length !== emptyOverlays.length || empty.some((overlay, index) => overlay !== emptyOverlays[index])) {
      filled.disconnect();
      for (const overlay of empty) filled.observe(overlay, { childList: true });
      emptyOverlays = empty;
    }
    return open.length > empty.length;
  };
  const refresh = () => {
    if (!frame) frame = view.requestAnimationFrame(run);
  };
  // A box can move without resizing: a window resize shifts a right-anchored
  // strip. An observer whose root is shrunk to the box's own rect fires as soon
  // as the box leaves it. It cannot see a move of a box that an ancestor
  // already clips, so a partly hidden box is sampled until it is whole again.
  let clipped = false;
  const observeMove = () => {
    const rect = element.getBoundingClientRect();
    const root = document.documentElement;
    const insets = [rect.top, root.clientWidth - rect.right, root.clientHeight - rect.bottom, rect.left].map(Math.floor);
    const key = `${insets.join()},${rect.width},${rect.height}`;
    if (key === moveKey) return;
    moveKey = key;
    move?.disconnect();
    move = undefined;
    clipped = false;
    if (rect.width === 0 || rect.height === 0) return;
    let armed = false;
    move = new view.IntersectionObserver((entries) => {
      const whole = entries.at(-1)?.intersectionRatio === 1;
      const first = !armed;
      armed = true;
      clipped = !whole;
      if (!first || !whole) refresh();
    }, { rootMargin: insets.map((inset) => `${-inset}px`).join(' '), threshold: 1 });
    move.observe(element);
  };
  const run = () => {
    frame = 0;
    sync();
    observeMove();
    if (overlayOpen() || clipped) refresh();
  };
  const resize = new view.ResizeObserver(refresh);
  resize.observe(element);
  view.addEventListener('resize', refresh);
  // Toggle events do not bubble; capture sees every popover and dialog.
  document.addEventListener('toggle', refresh, true);
  refresh();
  return {
    refresh,
    dispose() {
      view.cancelAnimationFrame(frame);
      frame = 0;
      resize.disconnect();
      move?.disconnect();
      filled.disconnect();
      view.removeEventListener('resize', refresh);
      document.removeEventListener('toggle', refresh, true);
    },
  };
}
