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

import type { CSSProperties } from 'react';

/* The appFrame publishes both column widths because the titlebar's first grid
   track is a calc() on --maka-sidenav-width. Every value here must stay a
   <length>: a unitless 0 makes that calc() invalid at computed-value time and
   drops the whole grid-template-columns — the strip falls back to implicit
   columns and the rail parks mid-window instead of beside the traffic lights.
   Shared with the Storybook frame so the story cannot drift from this write. */
export function appShellFrameStyle(input: {
  sessionListCollapsed: boolean;
  sessionListWidth: number;
  workbarRightWidth: number;
}): CSSProperties {
  return {
    '--maka-session-workbar-width': `${input.workbarRightWidth}px`,
    '--maka-sidenav-width': `${input.sessionListCollapsed ? 0 : input.sessionListWidth}px`,
    '--agents-content-area-gap': `${APP_SHELL_CONTENT_AREA_GAP}px`,
  } as CSSProperties;
}

/**
 * The spacing between the conversation column and the rail, in CSS pixels.
 *
 * The single source of truth: `appShellFrameStyle` publishes it as
 * `--agents-content-area-gap` for the eight CSS rules that draw the shell's
 * seams, and the Workbar takes the same number to size the rail against. It
 * lives here rather than in `reference-shell.css` because it has a JavaScript
 * reader, and the Workbar cannot read the custom property itself — one reads
 * back as its declaration, not as a resolved length (see
 * `ink-ladder-contract`).
 */
export const APP_SHELL_CONTENT_AREA_GAP = 4;
