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

async function drawCursor(input) {
  const registry = (globalThis.__makaCursorRegistry ??= new Map());
  const { cursor, ownerEpoch, point, action, operation, svg } = input;
  let entry = registry.get(cursor.id);
  const state = () => ({
    status: 'ready',
    visible:
      (!!entry?.host.isConnected &&
        entry.host.matches(':popover-open') &&
        entry.host.style.display !== 'none') ||
      !!(entry?.control?.isConnected && entry.control.style.display !== 'none'),
    requestedPosition: entry?.point ?? null,
  });
  if (operation === 'finalize') {
    if (entry) {
      entry.host.remove();
      entry.control?.remove();
      registry.delete(cursor.id);
      entry = undefined;
    }
    return state();
  }
  if (operation === 'controlStop') {
    if (entry?.ownerEpoch === ownerEpoch) {
      if (entry.control) entry.control.style.setProperty('display', 'none', 'important');
      entry.host.style.setProperty('display', 'none', 'important');
      if (entry.host.matches(':popover-open')) entry.host.hidePopover();
    }
    return state();
  }
  if (operation === 'remove' || operation === 'hide') {
    if (entry?.ownerEpoch === ownerEpoch) {
      entry.host.remove();
      entry.control?.remove();
      entry.point = null;
      // Keep the epoch watermark until the logical owner finalizes its cursor.
      if (operation === 'remove') entry.retired = true;
    }
    return state();
  }
  if (operation === 'state') return state();
  if (
    entry &&
    (BigInt(entry.ownerEpoch) > BigInt(ownerEpoch) ||
      (entry.ownerEpoch === ownerEpoch && entry.retired))
  )
    return state();
  if (!entry) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.popover = 'manual';
    host.style.cssText =
      'all:initial;position:fixed!important;inset:auto!important;left:0!important;top:0!important;width:42px!important;height:42px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;display:none!important;contain:layout style;';
    const root = host.attachShadow({ mode: 'closed' });
    const picture = document.createElement('div');
    const badge = document.createElement('span');
    const pulse = document.createElement('div');
    picture.style.cssText = 'width:42px;height:42px;pointer-events:none;';
    badge.style.cssText =
      'position:absolute;left:19px;top:45px;max-width:150px;padding:2px 7px;border:1px solid #ffffffcc;border-radius:8px;background:#17223bcc;color:white;font:600 10px/15px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
    pulse.style.cssText =
      'position:absolute;left:9.69px;top:9.69px;width:16px;height:16px;margin:-8px;border:2px solid white;border-radius:50%;box-sizing:border-box;opacity:0;pointer-events:none;';
    root.append(picture, pulse, badge);
    entry = { host, picture, badge, pulse, ownerEpoch, point: null };
    registry.set(cursor.id, entry);
  }
  if (!entry.host.isConnected) document.documentElement.append(entry.host);
  if (entry.svg !== svg) {
    const artwork = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    artwork.setAttribute('width', '42');
    artwork.setAttribute('height', '42');
    entry.picture.replaceChildren(document.importNode(artwork, true));
    entry.svg = svg;
  }
  entry.badge.textContent = cursor.label;
  if (operation === 'control' && input.nativeControl) {
    const control = input.nativeControl;
    if (!entry.control) {
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText =
        'all:initial;position:fixed!important;right:12px!important;top:12px!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style;';
      const root = host.attachShadow({ mode: 'closed' });
      const badge = document.createElement('span');
      badge.style.cssText =
        'display:block;padding:5px 10px;border:1px solid #ffffffcc;border-radius:10px;background:#17223be6;color:white;font:600 12px/18px system-ui;';
      root.append(badge);
      entry.control = host;
      entry.controlBadge = badge;
    }
    if (!entry.control.isConnected) document.documentElement.append(entry.control);
    entry.controlBadge.textContent = cursor.label;
    entry.control.style.setProperty(
      'display',
      control.running && control.observed ? 'block' : 'none',
      'important',
    );
    entry.controlSession = control.sessionId;
    entry.controlTurn = control.turnId;
  }
  const reduced = cursor.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  entry.host.style.transition = reduced ? 'none' : 'transform 120ms ease-out';
  if (point) {
    if (
      !point.every(Number.isFinite) ||
      point[0] < 0 ||
      point[1] < 0 ||
      point[0] > innerWidth ||
      point[1] > innerHeight
    )
      throw Error('cursor point is outside the current viewport');
    entry.point = point;
    entry.host.style.setProperty(
      'transform',
      `translate(${point[0] - 9.685922}px,${point[1] - 9.685922}px)`,
      'important',
    );
  }
  entry.ownerEpoch = ownerEpoch;
  entry.retired = false;
  const shown = cursor.enabled && entry.point;
  entry.host.style.setProperty('display', shown ? 'block' : 'none', 'important');
  if (shown && !entry.host.matches(':popover-open')) entry.host.showPopover();
  if (!shown && entry.host.matches(':popover-open')) entry.host.hidePopover();
  if (shown && point) {
    // Flush the new transform before collecting its CSS transition. A CDP
    // acknowledgement alone does not mean the visible pointer has arrived.
    getComputedStyle(entry.host).transform;
    await Promise.all(
      entry.host.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }
  if (entry.ownerEpoch !== ownerEpoch || entry.retired) return state();
  if (cursor.enabled && entry.point) {
    if ((action === 'click' || action === 'key') && !reduced) {
      entry.pulse.getAnimations().forEach((animation) => animation.cancel());
      entry.pulse.animate(
        [
          { opacity: 0.8, transform: 'scale(.3)' },
          { opacity: 0, transform: 'scale(2.2)' },
        ],
        { duration: 450 },
      );
    }
  }
  return {
    status: 'ready',
    visible:
      (entry.host.matches(':popover-open') && entry.host.style.display !== 'none') ||
      !!(entry.control?.isConnected && entry.control.style.display !== 'none'),
    requestedPosition: entry.point,
  };
}
