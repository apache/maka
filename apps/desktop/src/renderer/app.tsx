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

import { StrictMode, useEffect } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { makaTheme } from './astryx-theme/maka';
import { AppShell } from './composition/legacy-desktop-region';
import { useAstryxThemeMode } from './astryx-theme-mode';

export function App() {
  // The launch overlay (`#maka-preload` in index.html) retires on its own once
  // a surface commits `data-maka-content-ready`; this signal's live job is the
  // crash-recovery reload, where `ready-to-show` does not re-fire and the
  // re-hidden window waits on it. A layout effect is too early: it runs after
  // the DOM commit but before Chromium paints, so two animation frames put the
  // signal after at least one paint of the committed AppShell. `window.maka`
  // is undefined outside Electron (storybook), so guard it.
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void window.maka?.appWindow?.notifyRendererReady?.();
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, []);
  // Astryx owns the component/design system (issue #1565). It sits inside
  // StrictMode and follows our already-resolved color mode; see
  // astryx-theme-mode.ts for why we don't hand it `mode="system"`.
  const astryxMode = useAstryxThemeMode();
  return (
    <StrictMode>
      <Theme theme={makaTheme} mode={astryxMode}>
        <AppShell />
      </Theme>
    </StrictMode>
  );
}
