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

// apps/desktop/src/main/computer-use/pip-feed.ts
//
// What the mirror is shown after an action: the overlay hook wrapper that taps
// each result on its way past, and the arithmetic that puts the cursor where it
// belongs inside the captured pixels.
//
// Split out of pip-window.ts unchanged. This is the seam between Computer Use's
// results and the tile — the controller below owns the window, this owns what
// goes into it.

import type { ComputerUsePipController } from './pip-window.js';

/**
 * Feed the mirror from the same hook that drives the cursor.
 *
 * Wraps rather than replaces, for the same reason the status item does: the
 * cursor declines to draw in exactly the situations the mirror exists for. It
 * consumes the screenshot every mutating action already returns, so mirroring
 * costs no extra capture — and it covers semantic actions too, which the
 * cursor's own `onActionEnd` skips because they carry no end coordinate.
 */
export function withComputerUsePip<
  H extends {
    onActionBegin(action: never, context: never): unknown;
    onActionEnd?(action: never, result: never, context: never): unknown;
  },
>(hook: H, pip: ComputerUsePipController): H {
  return {
    ...hook,
    onActionBegin: hook.onActionBegin.bind(hook),
    onActionEnd(action: never, result: never, context: never) {
      const inner = hook.onActionEnd?.call(hook, action, result, context);
      try {
        presentToPip(pip, result, context);
      } catch {
        // A mirror that fails must never take the action down with it.
      }
      return inner;
    },
  } as H;
}

interface PipFeedResult {
  screenshot?: { base64: string; mimeType: 'image/png' | 'image/jpeg'; widthPx: number; heightPx: number };
  resolvedScreenPoint?: { x: number; y: number };
  observation?: {
    windowTitle?: string;
    windowBounds?: { x: number; y: number; width: number; height: number };
    screenshot?: { base64: string; mimeType: 'image/png' | 'image/jpeg'; widthPx: number; heightPx: number };
  };
}

function presentToPip(
  pip: ComputerUsePipController,
  result: PipFeedResult | undefined,
  context: { sessionId?: string; presentationScreenPoint?: { x: number; y: number } } | undefined,
): void {
  const sessionId = context?.sessionId;
  if (!sessionId || !result) return;
  const shot = result.screenshot ?? result.observation?.screenshot;
  if (!shot?.base64) return;

  pip.present({
    sessionId,
    base64: shot.base64,
    mimeType: shot.mimeType,
    widthPx: shot.widthPx,
    heightPx: shot.heightPx,
    ...(result.observation?.windowTitle ? { title: result.observation.windowTitle } : {}),
  });

  // The cursor point is in screen coordinates; the mirror needs it in capture
  // pixels. Scale through the window rather than subtracting the origin alone,
  // so a Retina capture (wider than the window in points) still lands on the
  // right control instead of a quarter of the way into it.
  // The executor reports a landing point only for the coordinate paths. An
  // element action resolves to an element, not a pointer position, so the point
  // it was addressed to — the element's own centre, already computed for the
  // cursor's flight — is what the mirror draws. Without this fallback the
  // mirror cleared its cursor at the end of every accessibility action, which
  // is every action Maka dispatches by default: the window the user is watching
  // showed the app being driven by nothing.
  const point = result.resolvedScreenPoint ?? context?.presentationScreenPoint;
  const bounds = result.observation?.windowBounds;
  if (!point || !bounds || bounds.width <= 0 || bounds.height <= 0) {
    pip.setCursor({ sessionId });
    return;
  }
  pip.setCursor({
    sessionId,
    x: ((point.x - bounds.x) / bounds.width) * shot.widthPx,
    y: ((point.y - bounds.y) / bounds.height) * shot.heightPx,
  });
}
